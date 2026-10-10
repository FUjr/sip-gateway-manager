/* SPDX-License-Identifier: GPL-2.0-only
 * Durable authenticated MESSAGE ingress and final-response delivery bridge.
 * All network access to the backend uses a private Unix socket, bounded to 2s.
 */
/*** MODULEINFO
 <depend>curl</depend>
 <depend>pjproject</depend>
 <support_level>extended</support_level>
 ***/
#include "asterisk.h"
#include <pjsip.h>
#include <pjlib.h>
#include <curl/curl.h>
#include "asterisk/module.h"
#include "asterisk/res_pjsip.h"
#include "asterisk/manager.h"
#include "asterisk/json.h"
#include "asterisk/utils.h"
#include "asterisk/sorcery.h"
#include "asterisk/taskprocessor.h"

static struct ast_taskprocessor *serializer;
static size_t discard(void *p, size_t s, size_t n, void *d) { return s*n; }
static long post(const char *path, struct ast_json *json)
{
    CURL *curl = curl_easy_init();
    struct curl_slist *headers = NULL;
    char url[256];
    char *body = ast_json_dump_string(json);
    long code = 0;
    if (!curl || !body) { if (curl) curl_easy_cleanup(curl); ast_json_free(body); return 0; }
    snprintf(url, sizeof(url), "http://localhost%s", path);
    headers = curl_slist_append(headers, "Content-Type: application/json");
    curl_easy_setopt(curl, CURLOPT_UNIX_SOCKET_PATH, "/run/gateway/ingest.sock");
    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 2000L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, discard);
    if (curl_easy_perform(curl) == CURLE_OK) curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &code);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    ast_json_free(body);
    return code;
}
static void copy_pj(char *out, size_t size, const pj_str_t *str)
{
    size_t n = str->slen < size-1 ? str->slen : size-1;
    memcpy(out, str->ptr, n); out[n] = 0;
}
static pj_bool_t incoming(pjsip_rx_data *rdata)
{
    struct ast_sip_endpoint *endpoint;
    pjsip_msg *msg = rdata->msg_info.msg;
    pjsip_tx_data *response;
    pjsip_sip_uri *uri;
    pjsip_generic_string_hdr *header;
    pj_str_t header_name = pj_str("X-Gateway-Delivery-ID");
    char recipient[64], sender[128], id[256], body[4097];
    int code = 503;
    long result;
    struct ast_json *json;
    if (pj_stricmp2(&msg->line.req.method.name, "MESSAGE")) return PJ_FALSE;
    endpoint = ast_pjsip_rdata_get_endpoint(rdata);
    if (!endpoint) return PJ_FALSE;
    if (strcmp(endpoint->message_context, "managed-message")) { ao2_cleanup(endpoint); return PJ_FALSE; }
    /* Distributor has already authenticated the endpoint before APPLICATION priority. */
    uri = pjsip_uri_get_uri(msg->line.req.uri);
    if (!PJSIP_URI_SCHEME_IS_SIP(uri) && !PJSIP_URI_SCHEME_IS_SIPS(uri)) { code=400; goto respond; }
    if (!msg->body || msg->body->len > 4096 || pj_stricmp2(&msg->body->content_type.type,"text") || pj_stricmp2(&msg->body->content_type.subtype,"plain")) { code=415; goto respond; }
    if (uri->user.slen >= sizeof(recipient)) { code=400; goto respond; }
    copy_pj(recipient,sizeof(recipient),&uri->user);
    uri = pjsip_uri_get_uri(rdata->msg_info.from->uri);
    if ((!PJSIP_URI_SCHEME_IS_SIP(uri) && !PJSIP_URI_SCHEME_IS_SIPS(uri)) || uri->user.slen >= sizeof(sender)) { code=400; goto respond; }
    copy_pj(sender,sizeof(sender),&uri->user);
    header=pjsip_msg_find_hdr_by_name(msg,&header_name,NULL);
    if(header) {
        if(header->hvalue.slen>128){code=400;goto respond;}
        copy_pj(id,sizeof(id),&header->hvalue);
    }
    else {
        char *identity=ast_malloc(rdata->msg_info.cid->id.slen+32);
        if(!identity)goto respond;
        memcpy(identity,rdata->msg_info.cid->id.ptr,rdata->msg_info.cid->id.slen);
        snprintf(identity+rdata->msg_info.cid->id.slen,32,":%d",rdata->msg_info.cseq->cseq);
        ast_sha1_hash(id,identity);
        ast_free(identity);
    }
    header_name=pj_str("X-QModem-SMS-From");
    header=pjsip_msg_find_hdr_by_name(msg,&header_name,NULL);
    if(header) {
        if(header->hvalue.slen>=sizeof(recipient)){code=400;goto respond;}
        copy_pj(sender,sizeof(sender),&header->hvalue);
        /* Cellular incoming rules match the original sender number. */
        ast_copy_string(recipient,sender,sizeof(recipient));
    }
    memcpy(body,msg->body->data,msg->body->len); body[msg->body->len]=0;
    if (strlen(body) != msg->body->len) { code=400; goto respond; }
    json=ast_json_pack("{s:s,s:s,s:s,s:s,s:s}","account",ast_sorcery_object_get_id(endpoint),"recipient",recipient,"sender",sender,"content",body,"delivery_id",id);
    if (!json) goto respond;
    result=post("/ingest",json); ast_json_unref(json);
    code = result>=200 && result<300 ? 202 : result==404 ? 404 : result==409 ? 409 : result==422 ? 400 : 503;
respond:
    if (!ast_sip_create_response(rdata,code,NULL,&response)) ast_sip_send_stateful_response(rdata,response,endpoint);
    ao2_cleanup(endpoint);
    return PJ_TRUE;
}
static void completed(void *token, pjsip_event *event)
{
    char *id=token;
    int code=408;
    struct ast_json *json;
    if (event->body.tsx_state.type==PJSIP_EVENT_RX_MSG) code=event->body.tsx_state.tsx->status_code;
    json=ast_json_pack("{s:s,s:i}","delivery_id",id,"code",code);
    if(json){post("/complete",json);ast_json_unref(json);}
    ast_free(id);
    ast_module_unref(ast_module_info->self);
}
struct send_job { char endpoint[64], recipient[32], id[129], sender[129], body[4097]; };
static int send_task(void *data)
{
    struct send_job *job=data;
    struct ast_sip_endpoint *endpoint=ast_sorcery_retrieve_by_id(ast_sip_get_sorcery(),"endpoint",job->endpoint);
    struct ast_sip_contact *contact=NULL;
    pjsip_tx_data *tdata;
    char *id=NULL;
    int rc=-1;
    struct ast_sip_body body={.type="text",.subtype="plain",.body_text=job->body};
    if(!endpoint)goto done;
    contact=ast_sip_location_retrieve_contact_from_aor_list(endpoint->aors);
    if(!contact)goto done;
    if(ast_sip_create_request("MESSAGE",NULL,endpoint,contact->uri,contact,&tdata))goto done;
    if(!strncmp(endpoint->context,"managed-",8)) {
        pjsip_sip_uri *uri=pjsip_uri_get_uri(tdata->msg->line.req.uri);
        pj_strdup2(tdata->pool,&uri->user,job->recipient);
    }
    if (job->sender[0]) {
        pjsip_sip_uri *from = pjsip_uri_get_uri(PJSIP_MSG_FROM_HDR(tdata->msg)->uri);
        pj_strdup2(tdata->pool, &from->user, job->sender);
    }
    ast_sip_add_body(tdata,&body);
    ast_sip_add_header(tdata,"X-Gateway-Delivery-ID",job->id);
    ast_sip_add_header(tdata,"X-QModem-SMS-From",job->sender);
    id=ast_strdup(job->id);
    if(!id){pjsip_tx_data_dec_ref(tdata);goto done;}
    ast_module_ref(ast_module_info->self);
    rc=ast_sip_send_out_of_dialog_request(tdata,endpoint,30,id,completed);
    if(rc){ast_free(id);ast_module_unref(ast_module_info->self);}
done:
    if(rc){struct ast_json *json=ast_json_pack("{s:s,s:i}","delivery_id",job->id,"code",480);if(json){post("/complete",json);ast_json_unref(json);}}
    ao2_cleanup(contact);ao2_cleanup(endpoint);ast_free(job);
    return 0;
}
static int action_send(struct mansession *session,const struct message *message)
{
    struct send_job *job=ast_calloc(1,sizeof(*job));
    const char *id=astman_get_header(message,"DeliveryID");
    const char *endpoint=astman_get_header(message,"Endpoint");
    const char *recipient=astman_get_header(message,"Recipient");
    const char *encoded=astman_get_header(message,"BodyBase64");
    const char *sender=astman_get_header(message,"SenderBase64");
    if(!job || strlen(id)!=64 || strlen(endpoint)>48 || strlen(recipient)>24 || strlen(encoded)>5464 || strlen(sender)>172) {ast_free(job);astman_send_error(session,message,"Invalid message");return 0;}
    ast_copy_string(job->id,id,sizeof(job->id));ast_copy_string(job->endpoint,endpoint,sizeof(job->endpoint));ast_copy_string(job->recipient,recipient,sizeof(job->recipient));
    ast_base64decode((unsigned char*)job->body,encoded,sizeof(job->body)-1);
    ast_base64decode((unsigned char*)job->sender,sender,sizeof(job->sender)-1);
    if(ast_sip_push_task(serializer,send_task,job)){ast_free(job);astman_send_error(session,message,"Queue unavailable");return 0;}
    astman_send_ack(session,message,"Queued; final response reported to durable backend");return 0;
}
static int registered_task(void *data)
{
    char *account=data, path[128];
    struct ast_json *json=ast_json_object_create();
    snprintf(path,sizeof(path),"/registered/%s",account);
    if(json){post(path,json);ast_json_unref(json);}
    ast_free(account);return 0;
}
static pj_status_t response_sent(pjsip_tx_data *tdata)
{
    pjsip_msg *msg=tdata->msg;
    pjsip_cseq_hdr *cseq=PJSIP_MSG_CSEQ_HDR(msg);
    char account[64];
    pjsip_sip_uri *uri;
    char *copy;
    if(msg->line.status.code != 200 || !cseq || pj_stricmp2(&cseq->method.name,"REGISTER"))return PJ_SUCCESS;
    uri=pjsip_uri_get_uri(PJSIP_MSG_TO_HDR(msg)->uri);
    copy_pj(account,sizeof(account),&uri->user);
    if(strspn(account,"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_") != strlen(account))return PJ_SUCCESS;
    copy=ast_strdup(account);
    if(copy && ast_sip_push_task(serializer,registered_task,copy))ast_free(copy);
    return PJ_SUCCESS;
}
static pjsip_module module={.name={"Durable SIP Gateway",19},.id=-1,.priority=PJSIP_MOD_PRIORITY_APPLICATION-1,.on_rx_request=incoming,.on_tx_response=response_sent};
static int load_module(void)
{
    serializer=ast_sip_create_serializer("gateway/send");
    if(!serializer)return AST_MODULE_LOAD_DECLINE;
    if(ast_sip_register_service(&module)!=PJ_SUCCESS)return AST_MODULE_LOAD_DECLINE;
    ast_manager_register_xml("GatewayMessageSend",EVENT_FLAG_MESSAGE,action_send);
    return AST_MODULE_LOAD_SUCCESS;
}
static int unload_module(void)
{
    ast_manager_unregister("GatewayMessageSend");ast_sip_unregister_service(&module);ast_taskprocessor_unreference(serializer);return 0;
}
AST_MODULE_INFO(ASTERISK_GPL_KEY,AST_MODFLAG_LOAD_ORDER,"Durable SIP Gateway MESSAGE bridge",
 .load=load_module,.unload=unload_module,.load_pri=AST_MODPRI_APP_DEPEND,.requires="res_pjsip");
