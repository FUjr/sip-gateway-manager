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
#include "asterisk/channel.h"
#include "asterisk/pbx.h"
#include "asterisk/res_pjsip.h"
#include "asterisk/res_pjsip_session.h"
#include "asterisk/manager.h"
#include "asterisk/json.h"
#include "asterisk/utils.h"
#include "asterisk/sorcery.h"
#include "asterisk/taskprocessor.h"
#include "asterisk/lock.h"

static struct ast_taskprocessor *serializer;
static void remember_registration(pjsip_rx_data *rdata, const char *account);
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
    if (pj_stricmp2(&msg->line.req.method.name, "MESSAGE") && msg->line.req.method.id != PJSIP_REGISTER_METHOD) return PJ_FALSE;
    endpoint = ast_pjsip_rdata_get_endpoint(rdata);
    if (!endpoint) return PJ_FALSE;
    if (strcmp(endpoint->message_context, "managed-message")) { ao2_cleanup(endpoint); return PJ_FALSE; }
    if(msg->line.req.method.id == PJSIP_REGISTER_METHOD) {
        remember_registration(rdata,ast_sorcery_object_get_id(endpoint));
        ao2_cleanup(endpoint);return PJ_FALSE;
    }
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
    rc=ast_sip_send_out_of_dialog_request(tdata,endpoint,30000,id,completed);
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
struct registration_data {
    char account[64];
    struct ast_json *json;
};
static int registered_task(void *data)
{
    struct registration_data *registration=data;
    char path[128];
    snprintf(path,sizeof(path),"/registered/%s",registration->account);
    post(path,registration->json);
    ast_json_unref(registration->json);
    ast_free(registration);return 0;
}
/* Match the authenticated original REGISTER to its successful response. Registrar responses
 * can retain old URI parameters when a client refreshes the same host/port without PN. */
struct registration_cache {
    char id[256],account[64];
    int cseq;
    time_t created;
    struct ast_json *json;
};
static struct registration_cache registrations[128];
AST_MUTEX_DEFINE_STATIC(registration_lock);
static void remember_registration(pjsip_rx_data *rdata,const char *account)
{
    pjsip_msg *msg=rdata->msg_info.msg;
    pjsip_contact_hdr *contact=pjsip_msg_find_hdr(msg,PJSIP_H_CONTACT,NULL);
    pjsip_expires_hdr *expires=pjsip_msg_find_hdr(msg,PJSIP_H_EXPIRES,NULL);
    const char *names[]={"pn-provider","pn-param","pn-prid"};
    const char *keys[]={"pn_provider","pn_param","pn_prid"};
    const int limits[]={16,512,2048};
    struct ast_json *json;
    int active=0,i,slot=0;
    /* A contactless query doesn't change registration or wake a pending call. */
    if(!contact || !rdata->msg_info.cid || !rdata->msg_info.cseq || strlen(account)>=64
        || rdata->msg_info.cid->id.slen>=256)return;
    json=ast_json_object_create();if(!json)return;
    if(!contact->star && contact->expires != 0 && (!expires || expires->ivalue != 0)) {
        pjsip_sip_uri *uri=pjsip_uri_get_uri(contact->uri);
        if(PJSIP_URI_SCHEME_IS_SIP(uri) || PJSIP_URI_SCHEME_IS_SIPS(uri)) {
            active=1;
            for(i=0;i<3;i++) {
                pj_str_t name=pj_str((char *)names[i]);
                pjsip_param *param=pjsip_param_find(&uri->other_param,&name);
                char value[2049];
                if(param && param->value.slen>0 && param->value.slen<=limits[i]) {
                    copy_pj(value,sizeof(value),&param->value);
                    ast_json_object_set(json,keys[i],ast_json_string_create(value));
                }
            }
        }
    }
    ast_json_object_set(json,"active",ast_json_boolean(active));
    ast_mutex_lock(&registration_lock);
    for(i=0;i<128;i++) {
        if(!registrations[i].json) {slot=i;break;}
        if(registrations[i].created<registrations[slot].created)slot=i;
    }
    ast_json_unref(registrations[slot].json);
    copy_pj(registrations[slot].id,sizeof(registrations[slot].id),&rdata->msg_info.cid->id);
    ast_copy_string(registrations[slot].account,account,sizeof(registrations[slot].account));
    registrations[slot].cseq=rdata->msg_info.cseq->cseq;
    registrations[slot].created=time(NULL);
    registrations[slot].json=json;
    ast_mutex_unlock(&registration_lock);
}
static pj_status_t response_sent(pjsip_tx_data *tdata)
{
    pjsip_msg *msg=tdata->msg;
    pjsip_cseq_hdr *cseq=PJSIP_MSG_CSEQ_HDR(msg);
    pjsip_cid_hdr *cid=PJSIP_MSG_CID_HDR(msg);
    pjsip_sip_uri *to;
    struct registration_data *registration;
    int i;
    if(msg->line.status.code != 200 || !cseq || !cid || pj_stricmp2(&cseq->method.name,"REGISTER"))return PJ_SUCCESS;
    if(!PJSIP_MSG_TO_HDR(msg))return PJ_SUCCESS;
    to=pjsip_uri_get_uri(PJSIP_MSG_TO_HDR(msg)->uri);
    if(!PJSIP_URI_SCHEME_IS_SIP(to) && !PJSIP_URI_SCHEME_IS_SIPS(to))return PJ_SUCCESS;
    registration=ast_calloc(1,sizeof(*registration));if(!registration)return PJ_SUCCESS;
    ast_mutex_lock(&registration_lock);
    for(i=0;i<128;i++) {
        if(registrations[i].json && registrations[i].cseq==cseq->cseq
            && registrations[i].created>=time(NULL)-10 && !pj_strcmp2(&cid->id,registrations[i].id)
            && !pj_strcmp2(&to->user,registrations[i].account)) {
            ast_copy_string(registration->account,registrations[i].account,sizeof(registration->account));
            registration->json=registrations[i].json;registrations[i].json=NULL;break;
        }
    }
    ast_mutex_unlock(&registration_lock);
    if(!registration->json){ast_free(registration);return PJ_SUCCESS;}
    if(ast_sip_push_task(serializer,registered_task,registration)) {
        ast_json_unref(registration->json);ast_free(registration);
    }
    return PJ_SUCCESS;
}
static pjsip_module module={.name={"Durable SIP Gateway",19},.id=-1,.priority=PJSIP_MOD_PRIORITY_APPLICATION-1,.on_rx_request=incoming,.on_tx_response=response_sent};
struct route_response { char data[8192]; size_t used; };
static size_t route_write(void *data,size_t size,size_t count,void *opaque)
{
    struct route_response *out=opaque; size_t n=size*count;
    if(n>=sizeof(out->data)-out->used)return 0;
    memcpy(out->data+out->used,data,n);out->used+=n;out->data[out->used]=0;return n;
}
static int route_call(struct ast_channel *chan,const char *source)
{
    CURL *curl=curl_easy_init(); struct route_response out={{0},0};
    struct curl_slist *headers=NULL; struct ast_json *request=NULL,*response=NULL;
    char *body=NULL; long code=0; const char *dial; const char *caller;
    pbx_builtin_setvar_helper(chan,"GATEWAY_DIAL","");
    if(!curl)return 0;
    pbx_builtin_setvar_helper(chan,"__GATEWAY_SOURCE",source);
    pbx_builtin_setvar_helper(chan,"__GATEWAY_NUMBER",ast_channel_exten(chan));
    caller=ast_channel_caller(chan)->id.number.valid ? ast_channel_caller(chan)->id.number.str : "";
    pbx_builtin_setvar_helper(chan,"__GATEWAY_CALLER",S_OR(caller,""));
    request=ast_json_pack("{s:s,s:s,s:s}","source",source,"number",ast_channel_exten(chan),"caller",S_OR(caller,""));
    if(!request)goto done;
    body=ast_json_dump_string(request);if(!body)goto done;
    headers=curl_slist_append(headers,"Content-Type: application/json");
    curl_easy_setopt(curl,CURLOPT_UNIX_SOCKET_PATH,"/run/gateway/ingest.sock");
    curl_easy_setopt(curl,CURLOPT_URL,"http://localhost/resolve");
    curl_easy_setopt(curl,CURLOPT_HTTPHEADER,headers);
    curl_easy_setopt(curl,CURLOPT_POSTFIELDS,body);
    curl_easy_setopt(curl,CURLOPT_TIMEOUT_MS,2000L);
    curl_easy_setopt(curl,CURLOPT_NOSIGNAL,1L);
    curl_easy_setopt(curl,CURLOPT_WRITEFUNCTION,route_write);
    curl_easy_setopt(curl,CURLOPT_WRITEDATA,&out);
    if(curl_easy_perform(curl)!=CURLE_OK)goto done;
    curl_easy_getinfo(curl,CURLINFO_RESPONSE_CODE,&code);if(code!=200)goto done;
    response=ast_json_load_string(out.data,NULL);if(!response)goto done;
    dial=ast_json_string_get(ast_json_object_get(response,"dial"));
    if(dial && strspn(dial,"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_/@+&-")==strlen(dial))pbx_builtin_setvar_helper(chan,"GATEWAY_DIAL",dial);
 done:
    ast_json_unref(request);ast_json_unref(response);ast_json_free(body);curl_slist_free_all(headers);curl_easy_cleanup(curl);return 0;
}
/* All HTTP calls stay bounded; waiting happens on the call's PBX thread, not the SIP serializer. */
static struct ast_json *request_json(const char *path, struct ast_json *request)
{
    CURL *curl=curl_easy_init(); struct route_response out={{0},0};
    struct curl_slist *headers=NULL; char *body=NULL; char url[128];
    long code=0; struct ast_json *response=NULL;
    if(!curl || !request)goto done;
    body=ast_json_dump_string(request);if(!body)goto done;
    snprintf(url,sizeof(url),"http://localhost%s",path);
    headers=curl_slist_append(headers,"Content-Type: application/json");
    curl_easy_setopt(curl,CURLOPT_UNIX_SOCKET_PATH,"/run/gateway/ingest.sock");
    curl_easy_setopt(curl,CURLOPT_URL,url);
    curl_easy_setopt(curl,CURLOPT_HTTPHEADER,headers);
    curl_easy_setopt(curl,CURLOPT_POSTFIELDS,body);
    curl_easy_setopt(curl,CURLOPT_TIMEOUT_MS,2000L);
    curl_easy_setopt(curl,CURLOPT_NOSIGNAL,1L);
    curl_easy_setopt(curl,CURLOPT_WRITEFUNCTION,route_write);
    curl_easy_setopt(curl,CURLOPT_WRITEDATA,&out);
    if(curl_easy_perform(curl)==CURLE_OK) {
        curl_easy_getinfo(curl,CURLINFO_RESPONSE_CODE,&code);
        if(code==200)response=ast_json_load_string(out.data,NULL);
    }
 done:
    ast_json_free(body);curl_slist_free_all(headers);if(curl)curl_easy_cleanup(curl);
    return response;
}
static int wake_call(struct ast_channel *chan,const char *target)
{
    struct ast_json *request,*response,*poll;
    const char *ticket,*call_id;
    int i, dial=1;
    struct timeval started=ast_tvnow();
    char source[64],number[64],caller[129];
    pbx_builtin_setvar_helper(chan,"GATEWAY_READY","0");
    ast_channel_lock(chan);
    ast_copy_string(source,S_OR(pbx_builtin_getvar_helper(chan,"GATEWAY_SOURCE"),""),sizeof(source));
    ast_copy_string(number,S_OR(pbx_builtin_getvar_helper(chan,"GATEWAY_NUMBER"),""),sizeof(number));
    ast_copy_string(caller,S_OR(pbx_builtin_getvar_helper(chan,"GATEWAY_CALLER"),""),sizeof(caller));
    ast_channel_unlock(chan);
    request=ast_json_pack("{s:s,s:s,s:s,s:s}","source",source,"target",target,"number",number,"caller",caller);
    response=request_json("/push/wake",request);ast_json_unref(request);
    if(!response)return 0;
    ticket=ast_json_string_get(ast_json_object_get(response,"ticket"));
    call_id=ast_json_string_get(ast_json_object_get(response,"call_id"));
    if(!ast_strlen_zero(ticket) && !ast_strlen_zero(call_id)) {
        pbx_builtin_setvar_helper(chan,"__GATEWAY_PUSH_CALL_ID",call_id);
        ast_indicate(chan,AST_CONTROL_RINGING);
        request=ast_json_pack("{s:s}","ticket",ticket);
        for(i=0;i<60 && ast_tvdiff_ms(ast_tvnow(),started)<15000;i++) {
            if(ast_safe_sleep(chan,250)) {dial=0;break;}
            poll=request_json("/push/ready",request);
            if(!poll) {dial=0;break;}
            dial=ast_json_is_true(ast_json_object_get(poll,"dial"));
            if(ast_json_is_true(ast_json_object_get(poll,"done"))) {ast_json_unref(poll);break;}
            ast_json_unref(poll);
        }
        ast_json_unref(request);
    }
    ast_json_unref(response);
    if(dial && !ast_check_hangup(chan))pbx_builtin_setvar_helper(chan,"GATEWAY_READY","1");
    return 0;
}
struct call_id_data { struct ast_sip_session *session; char id[65]; };
static int set_call_id(void *opaque)
{
    struct call_id_data *data=opaque;
    pjsip_dialog *dlg=data->session->inv_session->dlg;
    /* Pre-dial handler: no INVITE/transaction exists yet. Dialog lookup is keyed by the unchanged local tag. */
    if(data->session->inv_session->state != PJSIP_INV_STATE_NULL)return -1;
    pjsip_dlg_inc_lock(dlg);
    pj_strdup2(dlg->pool,&dlg->call_id->id,data->id);
    pjsip_dlg_dec_lock(dlg);
    return 0;
}
static int push_call_id(struct ast_channel *chan,const char *unused)
{
    struct ast_sip_channel_pvt *pvt;
    struct call_id_data data={0};
    const char *id;
    int result;
    ast_channel_lock(chan);
    id=pbx_builtin_getvar_helper(chan,"GATEWAY_PUSH_CALL_ID");
    if(!ast_strlen_zero(id) && strlen(id)<sizeof(data.id) && strspn(id,"0123456789abcdef-")==strlen(id)
        && !strcmp(ast_channel_tech(chan)->type,"PJSIP")) {
        pvt=ast_channel_tech_pvt(chan);
        if(pvt && pvt->session) {data.session=ao2_bump(pvt->session);ast_copy_string(data.id,id,sizeof(data.id));}
    }
    ast_channel_unlock(chan);
    if(!data.session)return 0;
    result=ast_sip_push_task_wait_serializer(data.session->serializer,set_call_id,&data);
    ao2_cleanup(data.session);
    return result;
}
static int load_module(void)
{
    serializer=ast_sip_create_serializer("gateway/send");
    if(!serializer)return AST_MODULE_LOAD_DECLINE;
    if(ast_sip_register_service(&module)!=PJ_SUCCESS)return AST_MODULE_LOAD_DECLINE;
    ast_manager_register_xml("GatewayMessageSend",EVENT_FLAG_MESSAGE,action_send);
    if(ast_register_application_xml("GatewayRoute",route_call))return AST_MODULE_LOAD_DECLINE;
    if(ast_register_application_xml("GatewayWake",wake_call))return AST_MODULE_LOAD_DECLINE;
    if(ast_register_application_xml("GatewayPushID",push_call_id))return AST_MODULE_LOAD_DECLINE;
    return AST_MODULE_LOAD_SUCCESS;
}
static int unload_module(void)
{
    int i;
    ast_mutex_lock(&registration_lock);
    for(i=0;i<128;i++) {ast_json_unref(registrations[i].json);registrations[i].json=NULL;}
    ast_mutex_unlock(&registration_lock);
    ast_unregister_application("GatewayRoute");
    ast_unregister_application("GatewayWake");
    ast_unregister_application("GatewayPushID");
    ast_manager_unregister("GatewayMessageSend");ast_sip_unregister_service(&module);ast_taskprocessor_unreference(serializer);return 0;
}
AST_MODULE_INFO(ASTERISK_GPL_KEY,AST_MODFLAG_LOAD_ORDER,"Durable SIP Gateway MESSAGE bridge",
 .load=load_module,.unload=unload_module,.load_pri=AST_MODPRI_APP_DEPEND,.requires="res_pjsip,res_pjsip_session");
