"""User-facing line services compiled to existing validated PBX objects.

A line is one modem endpoint; a person here is one client, not a login user.
The projection never infers online state, SIM number or caller-ID filtering.
"""
import copy
import hashlib
import json
import uuid
from typing import Literal
from pydantic import Field
from .models import Strict, Route, Group
from .routing import validate, resolve


def revision(config):
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()


class ServiceIntent(Strict):
    revision: str
    line: str
    medium: Literal['voice', 'sms']
    direction: Literal['inbound', 'outbound']
    people: list[str] = Field(min_length=1, max_length=64)
    scope: Literal['any', 'exact', 'prefix'] = 'any'
    number: str = Field(default='', pattern=r'^\+?[0-9]{0,24}$')
    enabled: bool = True


class Rehearsal(Strict):
    applied: bool = False
    at: str | None = None
    source: str
    medium: Literal['voice', 'sms']
    number: str = Field(pattern=r'^\+?[0-9]{1,24}$')


def service(config, line, medium, direction):
    routes = [r for r in config['routes'] if r['medium'] == medium and r['direction'] == direction and
              (line['id'] in r['sources'] if direction == 'inbound' else r['target'] == line['id'])]
    basic = len(routes) <= 1 and not any(r.get('schedule') for r in routes)
    r = routes[0] if len(routes) == 1 else None
    # Shared source lists and conditional incoming dialplans cannot be safely
    # represented as a single "who receives this line" service.
    if r and direction == 'inbound':
        basic = r['sources'] == [line['id']] and r['match'] == 'any'
    people = []
    if r:
        people = r['sources'] if direction == 'outbound' else (
            next(g['members'] for g in config['groups'] if g['id'] == r['target'])
            if r['target_type'] == 'group' else [r['target']])
    reason = ''
    if r and basic and direction == 'outbound' and r['enabled']:
        peers = [p for p in config['routes'] if p['id'] != r['id'] and p['enabled'] and p['direction'] == 'outbound' and p['medium'] == medium]
        if any(set(p['sources']) & set(r['sources']) and overlaps(p, r) for p in peers):
            basic = False
            reason = '此用途与其他线路存在重叠号码范围，请用号码预演确认去向，并在高级配置中调整。'
    return {'medium': medium, 'direction': direction, 'editable': basic,
            'configured': bool(routes), 'enabled': bool(r and r['enabled']),
            'people': people, 'scope': r['match'] if r else 'any', 'number': r['number'] if r else '',
            'route_ids': [r['id'] for r in routes],
            'reason': '' if basic else reason or '此用途含条件分流或共用规则，需在高级配置中调整，避免改变其他线路。'}


def describe(config):
    return {'revision': revision(config), 'lines': [
        {'id': a['id'], 'name': a['name'], 'device_id': a['device_id'], 'enabled': a['enabled'],
         'voice_enabled': a['voice_enabled'], 'sms_enabled': a['sms_enabled'],
         'services': [service(config, a, medium, direction)
                      for direction in ('inbound', 'outbound') for medium in ('voice', 'sms')]}
        for a in config['accounts'] if a['kind'] == 'device']}


def overlaps(a, b):
    if a['match'] == 'any' or b['match'] == 'any':
        return True
    if a['match'] == 'exact' and b['match'] == 'exact':
        return a['number'] == b['number']
    if a['match'] == 'prefix' and b['match'] == 'prefix':
        return a['number'].startswith(b['number']) or b['number'].startswith(a['number'])
    exact, prefix = (a, b) if a['match'] == 'exact' else (b, a)
    return exact['number'].startswith(prefix['number'])


def compile_service(config, intent):
    if intent.revision != revision(config):
        raise ValueError('配置已被更新，请刷新后重新设置。')
    conf = copy.deepcopy(config)
    line = next((a for a in conf['accounts'] if a['id'] == intent.line and a['kind'] == 'device'), None)
    if not line:
        raise ValueError('找不到这张卡对应的线路。')
    current = service(conf, line, intent.medium, intent.direction)
    if not current['editable']:
        raise ValueError(current['reason'])
    flag = 'voice_enabled' if intent.medium == 'voice' else 'sms_enabled'
    people = list(dict.fromkeys(intent.people))
    clients = {a['id']: a for a in conf['accounts'] if a['kind'] == 'client'}
    if any(p not in clients for p in people):
        raise ValueError('请选择已有的接听终端。')
    if intent.enabled and (not line['enabled'] or not line[flag] or any(not clients[p]['enabled'] or not clients[p][flag] for p in people)):
        raise ValueError('线路或终端已停用此业务，请先在连接设置中启用。')
    if intent.direction == 'inbound' and intent.scope != 'any':
        raise ValueError('接收用途不支持按来电号码筛选；条件拨号计划请使用高级配置。')
    if intent.scope != 'any' and not intent.number:
        raise ValueError('请填写允许的号码或号段。')
    old = next((r for r in conf['routes'] if r['id'] in current['route_ids']), None)
    identity = old['id'] if old else line['id'].split('_')[0] + '_service_' + uuid.uuid4().hex[:20]
    target_type, target = 'account', line['id']
    if intent.direction == 'inbound':
        target = people[0]
        if len(people) > 1:
            group = next((g for g in conf['groups'] if set(g['members']) == set(people)), None)
            if not group:
                group = Group(id=line['id'].split('_')[0] + '_receivers_' + uuid.uuid4().hex[:20], name=line['name'][:68] + ' · 接收终端', members=people).model_dump()
                conf['groups'].append(group)
            target_type, target = 'group', group['id']
    value = Route(id=identity, name=old['name'] if old else line['name'][:68] + ' · ' + ('接收' if intent.direction == 'inbound' else '外发') + ('通话' if intent.medium == 'voice' else '短信'),
                  medium=intent.medium, direction=intent.direction,
                  sources=[line['id']] if intent.direction == 'inbound' else people,
                  match=intent.scope, number=intent.number if intent.scope != 'any' else '',
                  priority=old['priority'] if old else 100, target_type=target_type, target=target, enabled=intent.enabled).model_dump()
    if intent.direction == 'outbound' and intent.enabled:
        if intent.scope == 'exact' and any(a['enabled'] and a[flag] and a['extension'] == intent.number for a in clients.values()):
            raise ValueError('这个号码属于内部终端，系统会优先内部互通，请换一个外部号码。')
        for r in conf['routes']:
            if r['id'] != identity and r['enabled'] and r['medium'] == intent.medium and r['direction'] == 'outbound' and set(r['sources']) & set(people) and overlaps(r, value):
                raise ValueError('这些终端已有重叠的外发用途。请缩小号码范围，或到高级配置设置条件与顺序。')
    conf['routes'] = [r for r in conf['routes'] if r['id'] != identity] + [value]
    validate(conf)
    return conf


def rehearse(config, request):
    accounts = {a['id']: a for a in config['accounts']}
    source = accounts.get(request.source)
    if not source:
        raise ValueError('请选择已有线路或终端。')
    flag = 'voice_enabled' if request.medium == 'voice' else 'sms_enabled'
    from datetime import datetime
    now = datetime.fromisoformat(request.at) if request.at else None
    if now is not None and now.tzinfo is None: raise ValueError('测试时间需要包含时区偏移')
    targets = resolve(config, request.source, request.number, request.medium, caller=request.number, now=now)
    internal = source['kind'] == 'client' and any(a['kind'] == 'client' and a['enabled'] and a[flag] and a['extension'] == request.number for a in accounts.values())
    reason = ('来源已停用此业务。' if not source['enabled'] or not source[flag] else
              '内部短号优先，直接连接终端，不使用 SIM 卡。' if internal else
              '按已保存配置可转发；实际连接仍取决于注册、网络和 SIM 卡状态。' if targets else
              '没有可用去向：未设置对应用途、号码不在允许范围，或目标已停用。')
    return {'allowed': bool(targets), 'internal': internal, 'targets': [{'id': t, 'name': accounts[t]['name'], 'kind': accounts[t]['kind']} for t in targets], 'reason': reason}
