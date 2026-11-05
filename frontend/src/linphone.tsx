import React, { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { t } from "./i18n";

type API = (path: string, method?: string, body?: unknown) => Promise<any>;
export function LinphoneImport({ identity, api, run }: {
  identity: string; api: API; run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [link, setLink] = useState("");
  const [expires, setExpires] = useState(0);
  const [busy, setBusy] = useState(false);
  return <div className="linphone-import">
    <h3>{t("Linphone 快速配置")}</h3>
    <p>{t("使用已应用的账户配置。手机端扫描二维码，或在 Linphone 的配置链接入口粘贴链接。")}</p>
    <p className="notice">{t("导入会覆盖 Linphone 的首个账户，请先确认。链接包含账户访问权限，10 分钟后失效，请勿公开分享。")}</p>
    <button disabled={busy} onClick={() => run(async () => {
      setBusy(true);
      try {
      const result = await api("accounts/" + identity + "/linphone", "POST");
      setLink(new URL(result.path, window.location.origin).href);
      setExpires(result.expires);
      } finally { setBusy(false); }
    })}>{t(link ? "重新生成配置链接" : "生成二维码与配置链接")}</button>
    {link && <div className="linphone-export">
      <QRCodeSVG value={link} size={224} level="M" title={t("Linphone 配置二维码")} />
      <label>{t("配置链接")}<input readOnly value={link} onFocus={e => e.target.select()} /></label>
      <p>{t("失效时间：{time}", { time: new Date(expires * 1000).toLocaleString() })}</p>
      <button onClick={() => run(async () => { await navigator.clipboard.writeText(link); })}>{t("复制配置链接")}</button>
      <button onClick={() => run(async () => {
        await api("accounts/" + identity + "/linphone", "DELETE");
        setLink(""); setExpires(0);
      })}>{t("撤销配置链接")}</button>
    </div>}
  </div>;
}
