import { t } from "./i18n";
import { Icon, labelOf, type Config, type Row } from "./guide";
export function Registration({
  account,
  status,
}: {
  account: Row;
  status: Row;
}) {
  const online = status.registrations?.[account.id];
  return (
    <span
      className={`badge ${!account.enabled ? "neutral" : online === true ? "" : "warning"}`}
    >
      {!account.enabled
        ? t("已停用")
        : online === true
          ? t("在线")
          : online === false
            ? t("离线")
            : t("状态未知")}
    </span>
  );
}
export function Dashboard({
  config,
  status,
  go,
  create,
  connect,
}: {
  config: Config;
  status: Row;
  go: (s: string) => void;
  create: (s: string, v?: Row) => void;
  connect: (r: Row) => void;
}) {
  const lines = config.accounts.filter((a) => a.kind === "device"),
    clients = config.accounts.filter((a) => a.kind === "client");
  const online = Object.values(status.registrations || {}).filter(
    Boolean,
  ).length;
  return (
    <>
      <section className="stats" aria-label={t("平台概览")}>
        {[
          [config.devices.length, t("网关")],
          [lines.length, t("SIM 线路")],
          [clients.length, t("分机")],
          [status.registrations ? online : "—", t("在线账户")],
        ].map(([n, label]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{n}</strong>
          </div>
        ))}
      </section>
      <div className="dashboard-grid">
        <section className="panel">
          <div className="section-heading">
            <h2>{t("SIM 线路")}</h2>
            <button
              onClick={() =>
                create(
                  config.devices.length ? "accounts" : "devices",
                  config.devices.length ? { kind: "device" } : {},
                )
              }
            >
              {t("添加线路")}
            </button>
          </div>
          {lines.length ? (
            <div className="resource-list">
              {lines.map((a) => (
                <article className="resource-row" key={a.id}>
                  <span className="node-icon sim">
                    <Icon name="sim" />
                  </span>
                  <div className="resource-info">
                    <strong>{a.name}</strong>
                    <small>
                      {labelOf(config.devices, a.device_id)}
                      {t("· 分机")} {a.extension}
                    </small>
                  </div>
                  <Registration account={a} status={status} />
                  <button onClick={() => connect(a)}>{t("连接配置")}</button>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty">
              <Icon name="sim" />
              <p>{t("暂无 SIM 线路")}</p>
            </div>
          )}
        </section>
        <section className="panel">
          <div className="section-heading">
            <h2>{t("分机")}</h2>
            <button onClick={() => create("accounts", { kind: "client" })}>
              {t("添加分机")}
            </button>
          </div>
          {clients.length ? (
            <div className="resource-list">
              {clients.map((a) => (
                <article className="resource-row" key={a.id}>
                  <span className="node-icon client">
                    <Icon name="phone" />
                  </span>
                  <div className="resource-info">
                    <strong>{a.name}</strong>
                    <small>{t("分机 {number}", { number: a.extension })}</small>
                  </div>
                  <Registration account={a} status={status} />
                  <button onClick={() => connect(a)}>{t("连接配置")}</button>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty">
              <Icon name="phone" />
              <p>{t("暂无分机")}</p>
            </div>
          )}
        </section>
      </div>
      <section className="panel">
        <div className="section-heading">
          <h2>{t("路由")}</h2>
          <span className="subtle">
            {t("{count} 条已启用", {
              count: config.routes.filter((r) => r.enabled).length,
            })}
          </span>
        </div>
        <div className="route-shortcuts">
          {[
            ["voice", t("电话路由"), "phone"],
            ["sms", t("短信路由"), "message"],
          ].map(([medium, title, icon]) => (
            <button key={medium} onClick={() => go(medium)}>
              <Icon name={icon} />
              <strong>{title}</strong>
              <span>
                {t("{count} 条规则", {
                  count: config.routes.filter(
                    (r) => r.medium === medium && r.enabled,
                  ).length,
                })}{" "}
              </span>
              <Icon name="arrow" />
            </button>
          ))}
        </div>
      </section>
    </>
  );
}
