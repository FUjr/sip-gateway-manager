import React, { useEffect, useState } from "react";
import { t } from "./i18n";

type API = (path: string, method?: string, body?: unknown) => Promise<any>;
type Config = { enabled: boolean; api_url: string; from_address: string; username: string;
  has_api_key: boolean; has_password: boolean };
const endpoint = "platform/linphone-push";

export function PushSettings({ api, run }: { api: API; run: (fn: () => Promise<void>) => Promise<void> }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [key, setKey] = useState("");
  const [password, setPassword] = useState("");
  const [clear, setClear] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  useEffect(() => {
    let active = true;
    api(endpoint).then(value => { if (active) setConfig(value); })
      .catch(() => { if (active) setResult(t("无法读取推送配置，请刷新页面重试")); });
    return () => { active = false; };
  }, []);
  const edit = (value: Partial<Config>) => { setConfig(c => c && { ...c, ...value }); setDirty(true); setResult(""); };
  const execute = (action: "save" | "generate" | "check") => run(async () => {
    setBusy(true); setResult("");
    try {
      const value = action === "save"
        ? await api(endpoint, "PUT", { enabled: config!.enabled, api_url: config!.api_url,
          from_address: config!.from_address, username: config!.username, api_key: key,
          password, clear_credentials: clear })
        : await api(endpoint + "/" + action, "POST", {});
      setConfig(value); setKey(""); setPassword(""); setClear(false); setDirty(false);
      setResult(action === "save" ? t("推送配置已保存，下一次来电生效")
        : (value.ok ? t("密钥验证成功，锁屏来电仍需实测") : t("验证失败，请检查账户、密钥和服务器网络"))
          + (value.code ? ` (HTTP ${value.code})` : ""));
    } finally { setBusy(false); }
  });
  return <section className="panel" aria-label={t("Linphone 推送服务")}>
    <h2>{t("Linphone 推送服务")}</h2>
    <p>{t("供所有租户共用，保存后立即生效，无需应用电话路由。密钥和密码不会回显。")}</p>
    {config && <form onSubmit={event => { event.preventDefault(); execute("save"); }}>
      <fieldset disabled={busy}>
        <label><input type="checkbox" checked={config.enabled} onChange={event => edit({ enabled: event.target.checked })} />{t("启用后台来电推送")}</label>
        <div className="fields">
          <label>{t("推送服务地址")}<select value={config.api_url} onChange={event => edit({ api_url: event.target.value })}>
            <option value="https://subscribe.linphone.org/api">subscribe.linphone.org</option>
            <option value="https://linphone.pro/api">linphone.pro</option>
          </select></label>
          <label>{t("Linphone 官方 SIP 地址")}<input required value={config.from_address} placeholder="sip:username@sip.linphone.org" onChange={event => edit({ from_address: event.target.value })} /></label>
          <label>API key<input type="password" autoComplete="new-password" value={key} placeholder={t(config.has_api_key ? "已保存，留空保留" : "尚未配置")} onChange={event => { setKey(event.target.value); setDirty(true); setResult(""); }} /></label>
        </div>
        <details className="advanced">
          <summary>{t("由服务器获取密钥与自动续期")}</summary>
          <p>{t("填写已激活的 Linphone 官方账户，保存后点击获取密钥。请求从本服务器发出，密码用于获取密钥和失效后的自动续期。")}</p>
          <div className="fields">
            <label>{t("Linphone 官方用户名")}<input autoComplete="off" value={config.username} onChange={event => edit({ username: event.target.value })} /></label>
            <label>{t("Linphone 官方密码")}<input type="password" autoComplete="new-password" value={password} placeholder={t(config.has_password ? "已保存，留空保留" : "尚未配置")} onChange={event => { setPassword(event.target.value); setDirty(true); setResult(""); }} /></label>
          </div>
          <label><input type="checkbox" checked={clear} onChange={event => { setClear(event.target.checked); setDirty(true); }} />{t("清除官方账户凭据，仅使用 API key")}</label>
        </details>
        <p>{t("留空保留已有密钥和密码；更换服务或官方 SIP 地址后需重新提供。修改后请先保存。")}</p>
        <div className="actions">
          <button className="primary" type="submit">{t("保存推送配置")}</button>
          <button type="button" disabled={dirty || !config.enabled || !config.has_password} onClick={() => execute("generate")}>{t("从服务器获取 API key")}</button>
          <button type="button" disabled={dirty || !config.enabled || !config.has_api_key} onClick={() => execute("check")}>{t("验证 API key")}</button>
        </div>
      </fieldset>
    </form>}
    {result && <p role="status">{result}</p>}
    <details className="advanced">
      <summary>{t("API key 申请与配置说明")}</summary>
      <ol>
        <li>{t("在 Linphone 官方网站注册账户并完成邮箱激活。此账户用于推送，与本系统的 SIP 分机账户不同。")}{" "}<a href="https://subscribe.linphone.org/register" target="_blank" rel="noreferrer">{t("注册 Linphone 账户")}</a></li>
        <li>{t("选择账户所属服务，填写其官方 SIP 地址。推荐填写官方用户名和密码，保存后从服务器获取 API key；也可手动填写已从相同出口 IP 获取的密钥。")}</li>
        <li>{t("用户级密钥绑定生成时的出口 IP，不能直接使用在个人电脑上生成的密钥。获取新密钥可能替换旧密钥，请勿与其他服务器共用账户。")}</li>
        <li>{t("验证成功仅表示账户 API 可访问。手机需允许通知并启用推送、重新注册，再通过锁屏来电确认。")}</li>
      </ol>
      <p>{t("注册和取得密钥不代表无限免费推送，服务权限、配额及费用以运营方为准。SIP 和语音仍连接自己的服务器。")}</p>
      <a href="https://subscribe.linphone.org/api#using-the-api-key" target="_blank" rel="noreferrer">{t("官方 API 文档")}</a>
    </details>
  </section>;
}
