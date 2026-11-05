# 配置下发格式 v1

设备账户导出的 JSON 包含以下字段，字段名称保持原样：

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

示例域名与密码仅用于说明，请使用平台实际导出的配置。导出文件包含 SIP 密码，不得发布到公开仓库或问题报告中。

## 参数边界

平台不下发 AT/PCM/ADB 路径、本地模组 ID、网络接口、本地 SIP/RTP 端口或可执行命令，这些参数由接收设备在本地选择。配置导入成功与运行时连接成功是不同状态，应分别展示。

## QModem 配置下发接口

配置下发接口拒绝未知字段和不支持的后续格式版本。预览操作不返回密码，也不修改 UCI。应用操作串行执行，先暂存私有 UCI 修改，保留已有的数据库短信模式；提交或服务更新失败时，恢复原有文件。

## Outbound 页面导入

在 QModem 的 Outbound 区域点击“Import enrollment JSON”，粘贴平台线路连接面板导出的 JSON。导入器校验格式版本、TLS 传输方式、必要凭据、端口、注册间隔和服务开关，仅提取支持的 Outbound 字段，其他字段不写入配置。

页面导入会保留本地网络接口、SIP 监听端口和所选模组。导入后先检查表单，再保存应用；仅导入不会自动保存，也不会立即连接服务器。
