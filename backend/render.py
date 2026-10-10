from pathlib import Path
from .models import Settings

def render(config):
    s = config['settings'][0] if config['settings'] else Settings().model_dump()
    pjsip = f'''[global]
type=global
user_agent=SIP Gateway Manager
endpoint_identifier_order=auth_username,username,ip
[transport-tls]
type=transport
protocol=tls
bind=0.0.0.0:{s['sip_tls_port']}
cert_file=/run/gateway/tls/fullchain.pem
priv_key_file=/run/gateway/tls/privkey.pem
method=tlsv1_2
verify_client=no
verify_server=yes
'''
    for a in config['accounts']:
        if not a['enabled']:
            continue
        pjsip += f'''
[{a['id']}-auth]
type=auth
auth_type=userpass
username={a['id']}
password={a['password']}
realm={s['realm']}
[{a['id']}]
type=aor
max_contacts=1
remove_existing=yes
qualify_frequency=30
[{a['id']}]
type=endpoint
transport=transport-tls
identify_by=auth_username,username
from_domain={s['hostname']}
context=managed-{a['id']}
message_context=managed-message
auth={a['id']}-auth
outbound_auth={a['id']}-auth
aors={a['id']}
disallow=all
allow=alaw,ulaw
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
trust_id_inbound=yes
send_pai=yes
'''
    # Every source gets its own authenticated context. No unmatched fallback route.
    dialplan = '[general]\nstatic=yes\nwriteprotect=yes\n'
    clients = [a for a in config['accounts'] if a['kind'] == 'client' and a['enabled'] and a['voice_enabled']]
    accounts = {a['id']: a for a in config['accounts']}
    groups = {g['id']: g for g in config['groups']}
    for a in config['accounts']:
        dialplan += f"\n[managed-{a['id']}]\n"
        if not a['enabled'] or not a['voice_enabled']:
            dialplan += 'exten => _.,1,Hangup(21)\n'
            continue
        if a['kind'] == 'client':
            for c in clients:
                dialplan += f"exten => {c['extension']},1,Dial(PJSIP/{c['id']},45)\nsame => n,Hangup()\n"
        dialplan += 'exten => _.,1,NoOp(Authenticated managed route)\n'
        # Use ordered GotoIf tests rather than Asterisk pattern specificity (which defeats priority).
        routes = sorted(config['routes'], key=lambda r: (r['priority'], r['id']))
        routes = [r for r in routes if r['enabled'] and r['medium'] == 'voice' and a['id'] in r['sources']]
        for i, r in enumerate(routes):
            if r['match'] == 'any':
                expr = '1'
            elif r['match'] == 'exact':
                expr = f'"${{EXTEN}}" = "{r["number"]}"'
            else:
                expr = f'"${{EXTEN:0:{len(r["number"])}}}" = "{r["number"]}"'
            dialplan += f'same => n,GotoIf($[{expr}]?route{i})\n'
        dialplan += 'same => n,Hangup(21)\n'
        for i, r in enumerate(routes):
            targets = groups[r['target']]['members'] if r['target_type'] == 'group' else [r['target']]
            targets = [t for t in targets if accounts[t]['enabled'] and accounts[t]['voice_enabled']]
            destinations = '&'.join(f'PJSIP/{t}' if a['kind'] == 'device' else f'PJSIP/${{EXTEN}}@{t}' for t in targets)
            if a['kind'] == 'device':
                dialplan += f'same => n(route{i}),NoOp(Cellular caller identity preserved)\n'
                dialplan += f'same => n,Dial({destinations},45)\n' if destinations else 'same => n,Hangup(21)\n'
            else:
                dialplan += f'same => n(route{i}),Dial({destinations},45)\n' if destinations else f'same => n(route{i}),Hangup(21)\n'
            dialplan += 'same => n,Hangup()\n'
    return {'pjsip.conf': pjsip, 'extensions.conf': dialplan,
            'rtp.conf': f"[general]\nrtpstart={s['rtp_start']}\nrtpend={s['rtp_end']}\n",
            'asterisk.conf': '[directories]\nastetcdir=/etc/asterisk\nastmoddir=/usr/lib/asterisk/modules\nastvarlibdir=/var/lib/asterisk\nastspooldir=/var/spool/asterisk\nastrundir=/var/run/asterisk\nastlogdir=/var/log/asterisk\n[options]\nrunuser=asterisk\nrungroup=asterisk\n',
             'modules.conf': '[modules]\nautoload=no\n' + ''.join('load=' + name + '.so\n' for name in (
                'res_sorcery_config','res_sorcery_astdb','res_sorcery_memory','res_sorcery_memory_cache',
                'res_pjproject','res_pjsip','res_pjsip_authenticator_digest','res_pjsip_outbound_authenticator_digest',
                'res_pjsip_endpoint_identifier_user','res_pjsip_registrar','res_pjsip_pubsub','res_pjsip_nat',
                'res_pjsip_session','res_pjsip_sdp_rtp','res_pjsip_caller_id','res_pjsip_header_funcs',
                'res_pjsip_dtmf_info','res_rtp_asterisk','res_timing_timerfd','res_sip_gateway',
                'chan_pjsip','pbx_config','app_dial','app_stack','func_callerid','func_channel',
                'bridge_simple','bridge_softmix','bridge_builtin_features','bridge_builtin_interval_features',
                'codec_alaw','codec_ulaw','format_pcm','format_wav')),
            'manager.conf': '[general]\nenabled=yes\nport=5038\nbindaddr=127.0.0.1\n[backend]\nsecret=' + __import__('os').environ.get('AMI_SECRET', 'development-only') + '\nread=system,call,user\nwrite=system,call,message\n',
            'logger.conf': '[general]\n[logfiles]\nconsole=notice,warning,error\n',
            'res_sip_gateway.conf': '[general]\nsocket=/run/gateway/ingest.sock\n'}
