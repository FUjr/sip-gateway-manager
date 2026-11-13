import React, { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { t } from "./i18n";

type API = (path: string, method?: string, body?: unknown) => Promise<any>;
export function LinphoneImport({ identity, api, run }: {
  identity: string; api: API; run: (fn: () => Promise<void>) => Promise<void>;
}) {
  const [link, setLink] = useState("");
  const [expires, setExpires] = useState(0);
  const [busy, setBusy] = useState(false);
  const [push, setPush] = useState<{ configured: boolean; device_registered: boolean; last_attempt?: { status: string; code: number | null } } | null>(null);
  const refreshPush = async () => setPush(await api("accounts/" + identity + "/push"));
  useEffect(() => { let active = true; api("accounts/" + identity + "/push").then(value => { if (active) setPush(value); }).catch(() => {}); return () => { active = false; }; }, [identity]);
  return <div className="linphone-import">
    <h3>{t("Linphone 快速配置")}</h3>
    <p>{t("使用已应用的账户配置。手机端扫描二维码，或在 Linphone 的配置链接入口粘贴链接。")}</p>
    <h4>{t("后台来电推送")}</h4>
    {push && <p>{t(!push.configured ? "服务器尚未配置推送服务" : push.device_registered ? "已收到手机推送参数，可尝试锁屏来电" : "等待手机注册并上报推送参数")}</p>}
    <p>{t("在手机上允许 Linphone 通知，并启用账户的推送通知。重新导入配置或重新注册后刷新状态。")}</p>
    {push?.last_attempt && <p>{t(push.last_attempt.status === "accepted" ? "最近推送已被服务接受，手机响铃仍需实测" : push.last_attempt.status === "sending" ? "正在发送推送" : "最近推送未成功，请检查服务器配置")}{push.last_attempt.code ? ` (HTTP ${push.last_attempt.code})` : ""}</p>}
    <button onClick={() => run(refreshPush)}>{t("刷新推送状态")}</button>
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
