# Provisioning v1

Device-account exports contain exactly these fields:

```json
{
  "schema_version": 1,
  "account_id": "modem1",
  "server": "sip.example.com",
  "port": 5061,
  "transport": "tls",
  "username": "modem1",
  "password": "replace-with-generated-secret",
  "realm": "sip-gateway",
  "register_interval": 300,
  "sms_enabled": true,
  "voip_enabled": true,
  "sms_ingress_uri": "sips:sms@sip.example.com:5061;transport=tls"
}
```

No AT/PCM/ADB path, local modem ID, interface, local SIP/RTP port, or executable command comes
from the gateway. The receiving device selects these locally. Unknown fields and future versions
are rejected. Preview returns no password and does not change UCI. Apply is serialized, stages
private UCI changes, preserves an existing database SMS mode, and restores prior files if commit
or service updates fail. Runtime connectivity is shown separately from successful configuration import.
