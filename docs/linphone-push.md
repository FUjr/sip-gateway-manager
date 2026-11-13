# Linphone 后台来电推送

手机 SIP 注册、INVITE 和 RTP 仍连接自己的 Asterisk。仅唤醒请求经 Linphone 的 HTTPS 推送服务交给 Apple APNs 或 Google FCM，无需编译客户端或提供自己的 Apple 开发者证书。

## 服务配置

### 从管理页面配置（推荐）

使用平台管理员登录，打开 **服务器设置 → Linphone 推送服务**。该配置由所有租户共用，普通租户无权读写服务配置，但可查看自己分机的推送状态。

1. 打开 [Linphone 官方注册页](https://subscribe.linphone.org/register)，填写用户名、邮箱和密码，按页面要求完成人机验证、接受条款，并通过邮件激活。已有官方账户可直接使用。这里的账户不是本系统创建的 SIP 分机账户。
2. 启用后台来电推送，选择账户所属的服务地址。对于上述注册站点，选择 `subscribe.linphone.org`，官方 SIP 地址填写 `sip:用户名@sip.linphone.org`。不要填写自建服务器上的分机地址。`linphone.pro` 应使用该站点对应的账户和服务权限。
3. 展开“由服务器获取密钥与自动续期”，填写官方用户名和密码，点击“保存推送配置”，再点击“从服务器获取 API key”。服务器使用 Digest 认证请求官方 `/accounts/me/api_key`，将结果保存到受限配置文件；浏览器不会收到密钥。保留这些凭据可在推送遇到 `401` 时自动续期。
4. 也可以手工填写 API key，不保存官方密码。此时请使用 **从 PBX 相同出口 IP 生成** 的密钥；个人电脑浏览器上生成的用户级密钥通常不能直接用于服务器。已有凭据可勾选“清除官方账户凭据，仅使用 API key”后保存。
5. 点击“验证 API key”。此操作仅从服务器调用官方 `/accounts/me`，不产生来电推送。成功代表密钥能访问账户 API，不代表已获所有推送权限或手机一定响铃。
6. 在手机启用通知和推送并重新注册，打开该分机的“连接配置”，刷新推送状态。最后将手机切到后台并锁屏，通过实际来电确认。

保存后下一次请求即使用新配置，不需要重启，也不需要点击“应用配置”。API key 和密码只写不读，留空保留原值；更换服务或官方 SIP 地址会清除旧凭据，必须重新提供。更换官方用户名需重新填写密码。停用推送保留密钥，方便之后重新启用；清除账户凭据不会删除已保存的 API key。

官方文档说明用户级 API key 绑定生成时的 IP，闲置一段时间后可能销毁；稳定管理级密钥需要服务方管理面板权限，普通注册账户不可假设拥有此权限。获取新密钥可能替换原密钥，建议每台服务器使用独立的官方账户，避免互相失效。固定服务器出口后再生成；容器出口、VPN 和代理设置改变后需重新验证。

**费用与范围：** 本部署已实际验证 `subscribe.linphone.org` 接受推送并使现成 iPhone Linphone 锁屏响铃，无需自己的 Apple 开发者账户或编译 App。这是当前账户的实测结果，不是运营方对永久免费、无限配额或 Android 交付的承诺。服务权限、配额和费用应向所选运营方确认。

### 管理接口

所有接口都需要现有登录会话；修改、获取密钥和验证请求还需要 `X-CSRF-Token`，并限定平台管理员。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/v1/platform/linphone-push` | 返回启用状态、服务地址、官方 SIP 地址、用户名及 `has_api_key` / `has_password` 标记，不返回秘密 |
| `PUT /api/v1/platform/linphone-push` | 原子保存配置，文件权限 `0600` |
| `POST /api/v1/platform/linphone-push/generate` | 使用已保存凭据，从 PBX 出口生成并保存密钥，然后验证 |
| `POST /api/v1/platform/linphone-push/check` | 验证已保存密钥，不自动重新生成、不推送 |

PUT 请求示例（均为占位符，非真实凭据）：

```json
{
  "enabled": true,
  "api_url": "https://subscribe.linphone.org/api",
  "from_address": "sip:YOUR_ACCOUNT@sip.linphone.org",
  "api_key": "",
  "username": "YOUR_ACCOUNT",
  "password": "YOUR_OFFICIAL_ACCOUNT_PASSWORD",
  "clear_credentials": false
}
```

生成、验证接口接受空 JSON 对象。响应中的 `ok` 和 `code` 表示服务验证结果；网络失败 `code` 为 `null`。`401` 应检查密钥、出口 IP 和官方凭据；`403` 应确认账户激活和服务权限；网络失败应检查服务器 DNS、HTTPS 出口和证书信任。接口不会返回运营方原始响应中的账户信息或敏感错误内容。只有上述两个官方服务地址可选。

### 直接配置文件

在 PBX 数据卷的 `/data/linphone-push.json` 写入服务器专用配置，权限设为 `0600`。该文件不属于网页配置，不通过 API 导出，也不进入版本库。

```json
{
  "enabled": true,
  "api_url": "https://subscribe.linphone.org/api",
  "from": "sip:YOUR_ACCOUNT@sip.linphone.org",
  "api_key": "GENERATE_FROM_THE_PBX_EGRESS_IP"
}
```

当前支持官方的 `https://subscribe.linphone.org/api` 和 `https://linphone.pro/api`。两者的账户、服务权限和密钥不可假设通用，应使用密钥所属站点。用户级 API key 绑定生成时的出口 IP，长期不用可能过期；应从 PBX 出口生成。如需自动恢复，可在同一个受限文件增加该服务账户的 `username`、`password`，服务遇到 `401` 时通过 Digest 重新生成密钥并重试一次。没有这些字段时只记录失败，不改变密钥。

注册和获得 key 不代表运营方承诺无限免费推送。服务权限、配额和费用以所用服务的实际返回及条款为准。

## 手机配置

在客户端连接配置中重新生成 Linphone 配置链接，导入手机。导入会覆盖首个账户和认证信息，已有账户须先确认。新配置启用推送通知、远程推送参数和收到推送后强制重新注册；手机系统还应允许 Linphone 通知。

也可在已有账户中启用对应选项后重新注册。在“后台来电推送”区域刷新状态，直到显示已收到手机推送参数。服务器自动读取认证成功的 REGISTER Contact 中的 `pn-provider`、`pn-param`、`pn-prid`，不需要手工粘贴 APNs token。iOS 组合 token 中选取 `voip` 服务；显式注销或客户端不再携带推送参数时清除旧 token。一个账户目前只有一个 SIP 联系人，多个设备应分别使用不同账户。

## 来电处理

只有正常路由允许的、已启用的客户端才会收到推送。带推送参数的目标通过独立 Local 通道处理，因此一个手机的唤醒等待不会阻塞同组其他分机振铃。服务器生成 Call-ID 并发送 `type=call`，等待手机完成新的认证注册，随后创建到最新联系地址的 PJSIP 通话。在尚未发送 INVITE 的预拨号阶段，将 SIP 对话 Call-ID 设置为推送中的值。

等待最长约 15 秒；主叫取消会结束等待。超过等待时间仍尝试普通拨号，支持前台客户端不重新注册的情况。来电期间会再次检查账户、租户和已应用路由，已被撤销的目标不会继续拨号。未配置服务或未收到推送参数的账户沿用普通 SIP 拨号。

设备参数保存在现有 SQLite 数据库中，最近一次注册超过 30 天的参数不用于推送。后台服务接受请求仅记录为 `accepted`，不等于手机响铃。连接配置显示最近 API HTTP 状态，但不显示密钥、设备 token 或外部响应正文。

## 验证

后端测试覆盖参数转换、注销清除、路由撤销、鉴权隔离、密钥续期和 API 失败记录。浏览器测试覆盖设备参数未就绪、刷新及服务已接受状态。

`tests/push_protocol.py` 只允许对 Compose project `sip-push-test` 运行。先用 `tests/protocol.py` 在此可丢弃环境创建协议测试账户，再运行推送场景：

```sh
PUSH_CAPTURE_FILE=/absolute/path/to/test-push-capture.jsonl \
  /path/to/venv/bin/python /path/to/repository/tests/push_protocol.py
```

测试栈需要将 `subscribe.linphone.org` 仅在隔离 Docker 网络内解析至本地 HTTPS 接收器，接收器向捕获文件追加请求 JSON 并返回 `204`。接收器的测试证书仅加入这个可丢弃 PBX 的 certifi 信任文件。测试使用虚构 API key，不调用真实推送服务，覆盖认证 SIP 参数采集、HTTPS 请求、旧 TLS 连接关闭、新连接注册、实际 INVITE Call-ID 匹配、双向 RTP、挂断及不带推送参数的普通通话恢复。

真实验收仍需在指定 iPhone 上确认：前台接听、锁屏来电、接听后双向语音、主叫取消和手机拒接。不可用模拟 APNs 或 HTTP 成功代替实机验收。

参考：[Linphone 第三方服务器推送流程](https://wiki.linphone.org/xwiki/wiki/public/view/Linphone/Sending%20push%20notification%20to%20Linphone%20mobile%20Apps/)、[推送配置](https://wiki.linphone.org/xwiki/wiki/public/view/Lib/Features/Push%20notifications/)、[FlexiAPI](https://subscribe.linphone.org/api)。
