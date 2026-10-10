def resolve(config, source, recipient, medium):
    accounts = {a['id']: a for a in config['accounts'] if a['enabled']}
    account = accounts.get(source)
    flag = 'sms_enabled' if medium == 'sms' else 'voice_enabled'
    if not account or not account[flag]:
        return []
    if account['kind'] == 'client':
        for target in accounts.values():
            if target['kind'] == 'client' and target['extension'] == recipient and target[flag]:
                return [target['id']]
    direction = 'inbound' if account['kind'] == 'device' else 'outbound'
    for route in sorted(config['routes'], key=lambda r: (r['priority'], r['id'])):
        if not route['enabled'] or route['medium'] != medium or route['direction'] != direction or source not in route['sources']:
            continue
        if route['match'] == 'exact' and recipient != route['number']:
            continue
        if route['match'] == 'prefix' and not recipient.startswith(route['number']):
            continue
        targets = [route['target']]
        if route['target_type'] == 'group':
            targets = next((g['members'] for g in config['groups'] if g['id'] == route['target']), [])
        return [t for t in targets if t in accounts and accounts[t][flag]]
    return []


def validate(config):
    accounts = {a['id']: a for a in config['accounts']}
    devices = {d['id'] for d in config['devices']}
    groups = {g['id']: g for g in config['groups']}
    extensions = set()
    for account in accounts.values():
        if account['id'] in ('global', 'system', 'transport_tls', 'anonymous'):
            raise ValueError('reserved account ID')
        if account['extension'] in extensions:
            raise ValueError('extensions must be unique')
        extensions.add(account['extension'])
        if account['kind'] == 'device' and account['device_id'] not in devices:
            raise ValueError('device account needs a physical device')
    for group in groups.values():
        if len(set(group['members'])) != len(group['members']):
            raise ValueError('duplicate group member')
        if any(t not in accounts or accounts[t]['kind'] != 'client' for t in group['members']):
            raise ValueError('groups contain client accounts only')
    for route in config['routes']:
        source_kind = 'device' if route['direction'] == 'inbound' else 'client'
        if any(s not in accounts or accounts[s]['kind'] != source_kind for s in route['sources']):
            raise ValueError('route sources have wrong account type')
        if route['match'] != 'any' and not route['number']:
            raise ValueError('exact/prefix route requires a number')
        if route['direction'] == 'outbound' and route['target_type'] != 'account':
            raise ValueError('outbound routes select one modem account')
        if route['target_type'] == 'group':
            if route['target'] not in groups:
                raise ValueError('unknown group')
        else:
            target = accounts.get(route['target'])
            target_kind = 'client' if route['direction'] == 'inbound' else 'device'
            if not target or target['kind'] != target_kind:
                raise ValueError('route target has wrong account type')
    if config['settings']:
        s = config['settings'][0]
        if s['rtp_end'] <= s['rtp_start']:
            raise ValueError('invalid RTP range')
