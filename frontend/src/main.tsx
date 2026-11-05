import { t, LanguageSwitcher, useLocale } from "./i18n";
import { Rules } from "./rules";
import { LinphoneImport } from "./linphone";
import { TenantPanel, ScheduleEditor } from "./tenant";
import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import {
  Flow,
  Icon,
  routeText,
  labelOf,
  matchName,
  type Row,
  type Config,
} from "./guide";
import { Dashboard, Registration } from "./dashboard";
const titles: Record<string, string> = {
  overview: "概览",
  devices: "网关",
  accounts: "SIP 账户",
  groups: "分机组",
  voice: "电话路由",
  sms: "短信路由",
  deliveries: "短信记录",
  settings: "服务器设置",
  tenant: "账户与租户",
};
const icons: Record<string, string> = {
  overview: "home",
  devices: "device",
  accounts: "phone",
  groups: "group",
  voice: "route",
  sms: "message",
  deliveries: "message",
  settings: "server",
  tenant: "group",
};
let csrf = "";
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch("/api/v1/" + path, {
    method,
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let error = await response.text();
    try {
      error = JSON.parse(error).detail;
    } catch {}
    if (response.status === 401)
      error =
        path === "login"
          ? t("账号或密码不正确，请重新输入。")
          : t("登录已过期，请刷新页面重新登录。");
    if (typeof error !== "string") error = JSON.stringify(error);
    const translations: Record<string, string> = {
      "invalid weekdays": t("无效的星期设置"),
      "extensions must be unique": t("分机号已被使用，请换一个。"),
      "device account needs a physical device": t(
        "请先添加网关设备，再选择账号所属设备。",
      ),
      "route sources have wrong account type": t(
        "来源账号与规则方向不一致，请重新选择。",
      ),
      "route target has wrong account type": t(
        "目标账号与规则方向不一致，请重新选择。",
      ),
      "exact/prefix route requires a number": t("请填写要匹配的号码或前缀。"),
      "invalid RTP range": t("媒体结束端口必须大于起始端口。"),
    };
    throw Error(translations[error] || String(error));
  }
  return response.json();
}
function password() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
const defaults: Record<string, () => Row> = {
  devices: () => ({ id: "", name: "" }),
  accounts: () => ({
    id: "",
    name: "",
    kind: "device",
    device_id: "",
    extension: "",
    password: password(),
    sms_enabled: true,
    voice_enabled: true,
    enabled: true,
  }),
  groups: () => ({ id: "", name: "", members: [] }),
  routes: () => ({
    id: "",
    name: "",
    medium: "voice",
    direction: "inbound",
    sources: [],
    match: "any",
    number: "",
    priority: 100,
    target_type: "account",
    target: "",
    enabled: true,
  }),
  settings: () => ({
    hostname: "sip.example.com",
    sip_tls_port: 5061,
    rtp_start: 20000,
    rtp_end: 20199,
    realm: "sip-gateway",
    register_interval: 300,
    sms_ttl: 604800,
  }),
};
function App() {
  useLocale();
  const [user, setUser] = useState<Row>({}),
    [auth, setAuth] = useState<Row>({}),
    [registering, setRegistering] = useState(false);
  const [logged, setLogged] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [config, setConfig] = useState<Config>({
      devices: [],
      accounts: [],
      groups: [],
      routes: [],
      settings: [],
    }),
    [experience, setExperience] = useState<Row>({ lines: [] }),
    [tab, setTab] = useState("overview"),
    [draft, setDraft] = useState<Row | null>(null),
    [editing, setEditing] = useState(false),
    [friendlyEntity, setFriendlyEntity] = useState(false),
    [provision, setProvision] = useState(""),
    [deliveries, setDeliveries] = useState<Row[]>([]),
    [status, setStatus] = useState<Row>({}),
    [connection, setConnection] = useState<Row | null>(null),
    [showPassword, setShowPassword] = useState(false);
  async function refresh() {
    const [conf, jobs, state, model] = await Promise.all([
      api("config"),
      api("deliveries"),
      api("status"),
      api("experience"),
    ]);
    setConfig(conf);
    setDeliveries(jobs);
    setStatus(state);
    setExperience(model);
  }
  async function run(fn: () => Promise<void>) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    api("auth/state")
      .then(setAuth)
      .catch(() => {});
    api("session")
      .then((s) => {
        setUser(s);
        csrf = s.csrf;
        setLogged(true);
        return refresh();
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!logged) return;
    const timer = window.setInterval(() => {
      Promise.all([api("status"), api("deliveries")])
        .then(([state, jobs]) => {
          setStatus(state);
          setDeliveries(jobs);
        })
        .catch(() => {});
    }, 15000);
    return () => window.clearInterval(timer);
  }, [logged]);
  useEffect(() => {
    if (draft || provision || connection)
      document
        .getElementById("configuration-editor")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [Boolean(draft), Boolean(provision), Boolean(connection)]);
  function go(next: string) {
    setTab(next);
    setDraft(null);
    setFriendlyEntity(false);
    setProvision("");
    setConnection(null);
    setError("");
    setNotice("");
  }
  function create(next: string, values: Row = {}) {
    go(next);
    let extension = 1001;
    while (config.accounts.some((a) => a.extension === String(extension)))
      extension++;
    const value =
      next === "settings" && config.settings[0]
        ? { ...config.settings[0] }
        : defaults[next]();
    if (next !== "settings")
      value.id =
        user.id +
        "_" +
        (next === "accounts" ? "account" : next.slice(0, -1)) +
        "_" +
        crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
    if (next === "accounts") {
      value.extension = String(extension);
      value.device_id = config.devices[0]?.id || "";
    }
    setFriendlyEntity(next === "accounts" && Boolean(values.kind));
    setDraft({ ...value, ...values });
    setEditing(false);
  }
  function edit(next: string, row: Row) {
    go(next);
    setDraft({ ...row });
    setEditing(true);
  }
  if (!logged)
    return (
      <main className="login">
        <div className="login-language">
          <LanguageSwitcher />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            run(async () => {
              const s = await api(
                registering || auth.bootstrap ? "register" : "login",
                "POST",
                {
                  ...Object.fromEntries(data),
                  ...(registering || auth.bootstrap
                    ? {
                        timezone:
                          Intl.DateTimeFormat().resolvedOptions().timeZone ||
                          "UTC",
                      }
                    : {}),
                },
              );
              setUser(s);
              csrf = s.csrf;
              setLogged(true);
              await refresh();
            });
          }}
        >
          <span className="mark">SIP</span>
          <h1>SIP Gateway</h1>
          <p>
            {auth.bootstrap
              ? t("创建管理员账户")
              : registering
                ? t("注册账户")
                : t("登录管理平台")}
          </p>
          <label>
            {t("用户名")}
            <input name="username" autoComplete="username" required />
          </label>
          <label>
            {t("密码")}
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          {error && (
            <p role="alert" className="error">
              {t(error)}
            </p>
          )}
          <button disabled={busy}>
            {registering || auth.bootstrap
              ? auth.bootstrap
                ? t("注册首个管理员")
                : t("注册租户")
              : t("登录")}
          </button>
          {auth.registration_open && !auth.bootstrap && (
            <button type="button" onClick={() => setRegistering(!registering)}>
              {registering ? t("返回登录") : t("注册租户")}
            </button>
          )}
        </form>
      </main>
    );
  function field(
    key: string,
    label: string,
    type = "text",
    options?: [string, string][],
    multiple = false,
  ) {
    if (!draft) return null;
    const value = draft[key];
    const hints: Record<string, string> = {
      priority: t("数值越小越优先"),
      hostname: t("域名或 IP，不含协议前缀"),
    };
    function update(value: any) {
      const next = { ...draft, [key]: value };
      if (key === "direction") {
        next.sources = [];
        next.target = "";
        next.target_type = "account";
      }
      if (key === "target_type") next.target = "";
      if (key === "kind")
        next.device_id = value === "client" ? "" : config.devices[0]?.id || "";
      setDraft(next);
    }
    if (options && multiple)
      return (
        <fieldset className="choice-field" key={key}>
          <legend>{label}</legend>
          {hints[key] && <p className="help">{hints[key]}</p>}
          {options.length ? (
            options.map(([v, l]) => (
              <label className="check-option" key={v}>
                <input
                  type="checkbox"
                  checked={value.includes(v)}
                  onChange={(e) =>
                    update(
                      e.target.checked
                        ? [...value, v]
                        : value.filter((x: string) => x !== v),
                    )
                  }
                />
                <span>{l}</span>
              </label>
            ))
          ) : (
            <p className="help">
              {t("还没有可选账号，请先在“SIM 卡与客户端”中添加。")}
            </p>
          )}
        </fieldset>
      );
    return (
      <label key={key} className={type === "checkbox" ? "toggle-field" : ""}>
        <span>{label}</span>
        {options ? (
          <select
            aria-label={label}
            value={value}
            multiple={multiple}
            onChange={(e) => update(e.target.value)}
            required
          >
            {!multiple && <option value="">{t("请选择")}</option>}
            {options.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        ) : type === "checkbox" ? (
          <input
            type="checkbox"
            aria-label={label}
            checked={value}
            onChange={(e) => update(e.target.checked)}
          />
        ) : (
          <input
            type={type}
            aria-label={label}
            value={value}
            required
            disabled={key === "id" && editing}
            onChange={(e) =>
              update(
                type === "number" ? Number(e.target.value) : e.target.value,
              )
            }
          />
        )}
        {hints[key] && <small className="help">{hints[key]}</small>}
      </label>
    );
  }
  const accounts = config.accounts,
    clients = accounts.filter((a) => a.kind === "client"),
    devices = accounts.filter((a) => a.kind === "device");
  const opts = (rows: Row[]) =>
    rows.map((r) => [r.id, r.name] as [string, string]);
  return (
    <div className="layout">
      <aside>
        <div className="brand">
          <span className="mark">SIP</span>
          <strong>
            SIP Gateway<small>{t("通话与短信")}</small>
          </strong>
        </div>
        <nav aria-label={t("主导航")}>
          {[
            "overview",
            "devices",
            "accounts",
            "groups",
            "voice",
            "sms",
            "deliveries",
            ...(user.admin ? ["settings"] : []),
            "tenant",
          ].map((id) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => go(id)}
            >
              <Icon name={icons[id]} size={19} />
              {t(titles[id])}
            </button>
          ))}
        </nav>
        <div className="sidebar-account">
          <strong>{user.username}</strong>
          <small>{user.admin ? t("管理员") : t("租户")}</small>
        </div>
        <button
          onClick={() =>
            run(async () => {
              await api("logout", "POST");
              setLogged(false);
              go("overview");
              setAuth(await api("auth/state"));
              setShowPassword(false);
            })
          }
        >
          {t("退出登录")}
        </button>
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">SIP GATEWAY</p>
            <h1>{t(titles[tab])}</h1>
          </div>
          <div className="header-actions">
            <LanguageSwitcher />
            <button disabled={busy} onClick={() => run(refresh)}>
              {t("刷新状态")}
            </button>
            <button
              className="primary"
              onClick={() =>
                run(async () => {
                  const r = await api("apply", "POST");
                  setNotice(
                    r.restart_required
                      ? t("端口变更尚未生效，需要管理员重启服务。")
                      : t("配置已应用。"),
                  );
                  await refresh();
                })
              }
              disabled={busy}
            >
              {busy ? t("处理中…") : t("应用配置")}
            </button>
          </div>
        </header>
        <div
          className={`apply-state ${status.pending_changes ? "pending" : ""}`}
          role="status"
        >
          <span className="legend-dot" />
          {status.pending_changes === true
            ? t("配置未应用")
            : status.pending_changes === false
              ? t("配置已应用")
              : status.applied
                ? t("配置已应用")
                : t("尚未应用配置")}
          <span>
            {status.pending_changes
              ? t("新建或修改的账户与路由尚未生效")
              : user.timezone}
          </span>
        </div>
        {error && (
          <p role="alert" className="error">
            {t(error)}
          </p>
        )}
        {notice && (
          <p role="status" className="notice">
            {t(notice)}
          </p>
        )}
        {tab === "overview" ? (
          <Dashboard
            config={config}
            status={status}
            go={go}
            create={create}
            connect={(row) =>
              run(async () => {
                setDraft(null);
                setShowPassword(false);
                if (row.kind === "device") {
                  setConnection(null);
                  setProvision(
                    JSON.stringify(
                      await api("accounts/" + row.id + "/provision"),
                      null,
                      2,
                    ),
                  );
                } else {
                  setProvision("");
                  setConnection(row);
                }
              })
            }
          />
        ) : tab === "tenant" ? (
          <TenantPanel api={api} user={user} />
        ) : tab === "voice" || tab === "sms" ? (
          <Rules
            key={tab}
            api={api}
            config={config}
            experience={experience}
            user={user}
            medium={tab}
            refresh={refresh}
          />
        ) : tab === "deliveries" ? (
          <section className="panel">
            <button onClick={() => run(refresh)}>{t("刷新")}</button>
            <table>
              <thead>
                <tr>
                  <th>{t("来源")}</th>
                  <th>{t("目标")}</th>
                  <th>{t("状态")}</th>
                  <th>{t("尝试")}</th>
                  <th>{t("SIP 响应")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td>{labelOf(accounts, d.source)}</td>
                    <td>{labelOf(accounts, d.target)}</td>
                    <td>
                      <span
                        className={`badge ${["failed", "expired"].includes(d.status) ? "warning" : ""}`}
                      >
                        {(
                          {
                            delivered: t("已交付目标账号"),
                            pending: t("等待投递 / 重试"),
                            sending: t("正在投递"),
                            failed: t("投递失败"),
                            expired: t("已过期"),
                          } as Record<string, string>
                        )[d.status] || d.status}
                      </span>
                    </td>
                    <td>{d.attempts}</td>
                    <td>{d.code ?? "—"}</td>
                    <td>
                      {["pending", "failed"].includes(d.status) && (
                        <button
                          onClick={() =>
                            run(async () => {
                              await api(
                                "deliveries/" + d.id + "/retry",
                                "POST",
                              );
                              await refresh();
                            })
                          }
                        >
                          {t("重新投递")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!deliveries.length && (
              <div className="empty">
                <Icon name="message" size={32} />
                <h3>{t("暂时没有短信投递记录")}</h3>
                <p>{t("配置短信规则并实际收发后，这里会显示投递结果。")}</p>
              </div>
            )}
          </section>
        ) : (
          <section className="panel">
            <div className="toolbar">
              <button
                onClick={() => {
                  create(tab);
                }}
              >
                {tab === "settings"
                  ? t("编辑设置")
                  : tab === "devices"
                    ? t("添加网关")
                    : tab === "accounts"
                      ? t("添加账号")
                      : tab === "routes"
                        ? t("添加规则")
                        : t("添加群组")}
              </button>
            </div>
            <table>
              <thead>
                <tr>
                  <th>{t("名称 / 地址")}</th>
                  <th>{t("信息")}</th>
                  <th>{t("操作")}</th>
                </tr>
              </thead>
              <tbody>
                {config[tab].map((r) => (
                  <tr key={r.id || "main"}>
                    <td>
                      <strong>{r.name || r.hostname}</strong>
                      {r.id && <small className="table-id">{r.id}</small>}
                    </td>
                    <td>
                      {tab === "accounts" && (
                        <Registration account={r} status={status} />
                      )}
                      {tab === "accounts"
                        ? `${r.kind === "device" ? t("SIM 线路") : t("分机")} · ${t("分机 {number}", { number: r.extension })} · ${r.enabled ? [r.voice_enabled && t("通话"), r.sms_enabled && t("短信")].filter(Boolean).join(" / ") || t("无启用业务") : t("已停用")}`
                        : tab === "routes"
                          ? `${r.enabled ? t("启用") : t("停用")} · ${r.medium === "voice" ? t("通话") : t("短信")} · ${routeText(r, config)} ${t("优先级")} ${r.priority}`
                          : tab === "groups"
                            ? r.members
                                .map((id: string) => labelOf(clients, id))
                                .join("、")
                            : tab === "devices"
                              ? t("{count} 个 SIM 线路账号", {
                                  count: devices.filter(
                                    (a) => a.device_id === r.id,
                                  ).length,
                                })
                              : t("加密连接端口 {port}", {
                                  port: String(r.sip_tls_port),
                                })}
                    </td>
                    <td>
                      <button
                        onClick={() => {
                          edit(tab, r);
                        }}
                      >
                        {t("编辑")}
                      </button>
                      {tab !== "settings" && (
                        <button
                          onClick={() => {
                            if (
                              window.confirm(
                                t("删除 {name}？", { name: r.name }),
                              )
                            )
                              run(async () => {
                                await api(tab + "/" + r.id, "DELETE");
                                await refresh();
                              });
                          }}
                        >
                          {t("删除")}
                        </button>
                      )}
                      {tab === "accounts" && r.kind === "device" && (
                        <button
                          onClick={() =>
                            run(async () => {
                              setProvision(
                                JSON.stringify(
                                  await api("accounts/" + r.id + "/provision"),
                                  null,
                                  2,
                                ),
                              );
                              setDraft(null);
                              setConnection(null);
                            })
                          }
                        >
                          {t("连接配置")}
                        </button>
                      )}
                      {tab === "accounts" && r.kind === "client" && (
                        <button
                          onClick={() => {
                            setConnection(r);
                            setShowPassword(false);
                            setDraft(null);
                            setProvision("");
                          }}
                        >
                          {t("连接配置")}
                        </button>
                      )}
                      {tab === "devices" && (
                        <button
                          onClick={() =>
                            create("accounts", {
                              kind: "device",
                              device_id: r.id,
                            })
                          }
                        >
                          {t("添加 SIM 线路")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!config[tab].length && (
              <div className="empty">
                <Icon name={icons[tab]} size={36} />
                <h3>{t("暂无{type}", { type: t(titles[tab]) })}</h3>
                <p>{t("暂无记录")}</p>
              </div>
            )}
          </section>
        )}
        {draft && (
          <section className="panel editor" id="configuration-editor">
            <h2>
              {t(editing ? "编辑{type}" : "新增{type}", {
                type:
                  friendlyEntity && tab === "accounts"
                    ? draft.kind === "device"
                      ? t("SIM 线路")
                      : t("分机")
                    : t(titles[tab]),
              })}
            </h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  if (tab === "routes" && !draft.sources.length)
                    throw Error(t("请至少勾选一个来源账号。"));
                  if (tab === "groups" && !draft.members.length)
                    throw Error(t("请至少勾选一个接听客户端。"));
                  await api(tab + "/" + (draft.id || "main"), "PUT", draft);
                  setDraft(null);
                  await refresh();
                  setNotice(t("已保存，尚未应用。"));
                });
              }}
            >
              <div className="fields">
                {tab !== "settings" && <>{field("name", t("显示名称"))}</>}
                {tab === "accounts" && (
                  <>
                    {!friendlyEntity &&
                      field("kind", t("账户类型"), "text", [
                        ["device", t("SIM 线路")],
                        ["client", t("分机")],
                      ])}
                    {draft.kind === "device" &&
                      field(
                        "device_id",
                        t("所属设备"),
                        "text",
                        opts(config.devices),
                      )}
                    {field("extension", t("分机号"))}
                    {field("voice_enabled", t("启用语音"), "checkbox")}
                    {field("sms_enabled", t("启用短信"), "checkbox")}
                    {field("enabled", t("账号启用"), "checkbox")}
                  </>
                )}
                {tab === "groups" &&
                  field(
                    "members",
                    t("客户端（可多选）"),
                    "text",
                    opts(clients),
                    true,
                  )}
                {tab === "routes" && (
                  <>
                    <ScheduleEditor
                      value={draft.schedule}
                      onChange={(schedule) => setDraft({ ...draft, schedule })}
                    />
                    {field("medium", t("业务"), "text", [
                      ["voice", t("语音")],
                      ["sms", t("短信")],
                    ])}
                    {field("direction", t("方向"), "text", [
                      ["inbound", t("收到后转交：SIM 卡 → 分机")],
                      ["outbound", t("向外拨号 / 发短信：分机 → SIM 卡")],
                    ])}
                    {field(
                      "sources",
                      t("哪些账号发起？（可多选）"),
                      "text",
                      opts(draft.direction === "inbound" ? devices : clients),
                      true,
                    )}
                    {field("match", t("号码匹配"), "text", [
                      ["any", t("所有号码")],
                      ["exact", t("仅一个指定号码")],
                      ["prefix", t("号码以指定数字开头")],
                    ])}
                    {draft.match !== "any" && field("number", t("号码 / 前缀"))}
                    {field(
                      "target_type",
                      t("目标类型"),
                      "text",
                      draft.direction === "inbound"
                        ? [
                            ["account", t("客户端")],
                            ["group", t("客户端群组")],
                          ]
                        : [["account", t("模组")]],
                    )}
                    {field(
                      "target",
                      t("目标"),
                      "text",
                      opts(
                        draft.target_type === "group"
                          ? config.groups
                          : draft.direction === "inbound"
                            ? clients
                            : devices,
                      ),
                    )}
                    {field("enabled", t("规则启用"), "checkbox")}
                  </>
                )}
                {tab === "settings" && (
                  <>
                    {field("hostname", t("服务器地址（域名或 IP）"))}
                    {field("sip_tls_port", t("SIP TLS 端口"), "number")}
                  </>
                )}
              </div>
              {tab === "accounts" &&
                draft.kind === "device" &&
                !config.devices.length && (
                  <p className="error">
                    {t("请先添加一台网关设备，再创建 SIM 线路账号。")}
                    <button type="button" onClick={() => create("devices")}>
                      {t("去添加网关")}
                    </button>
                  </p>
                )}
              {tab === "routes" && (
                <div className="route-preview">
                  <h3>{t("配置效果预览")}</h3>
                  <Flow route={draft} config={config} />
                  <p>{routeText(draft, config)}</p>
                  <small>
                    {t("号码条件：")}
                    {matchName(draft)}
                    {t("。保存并应用后参与匹配。")}
                  </small>
                </div>
              )}
              <details className="advanced">
                <summary>{t("高级设置")}</summary>
                <div className="fields">
                  {tab !== "settings" && field("id", t("标识（小写字母开头）"))}
                  {tab === "accounts" &&
                    field("password", t("SIP 密码"), "password")}
                  {tab === "routes" && field("priority", t("优先级"), "number")}
                  {tab === "settings" && (
                    <>
                      {field("realm", t("认证域"))}
                      {field("rtp_start", t("RTP 起始端口"), "number")}
                      {field("rtp_end", t("RTP 结束端口"), "number")}
                      {field(
                        "register_interval",
                        t("注册周期（秒）"),
                        "number",
                      )}
                      {field("sms_ttl", t("短信有效期（秒）"), "number")}
                    </>
                  )}
                </div>
              </details>
              <div className="actions">
                <button className="primary" disabled={busy}>
                  {t("保存")}
                </button>
                <button type="button" onClick={() => setDraft(null)}>
                  {t("取消")}
                </button>
              </div>
            </form>
          </section>
        )}
        {provision && (
          <section className="panel" id="configuration-editor">
            <h2>{t("设备配置")}</h2>
            <details className="advanced">
              <summary>{t("查看配置内容（包含密码）")}</summary>
              <textarea
                aria-label={t("入网 JSON")}
                readOnly
                value={provision}
              />
            </details>
            <div className="actions">
              <button
                onClick={() =>
                  run(async () => {
                    await navigator.clipboard.writeText(provision);
                    setNotice(t("已复制"));
                  })
                }
              >
                {t("复制")}
              </button>
              <button
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob([provision], { type: "application/json" }),
                  );
                  const a = document.createElement("a");
                  a.href = url;
                  a.download =
                    JSON.parse(provision).account_id + "-sip-provision.json";
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                {t("下载连接配置")}
              </button>
              <button onClick={() => setProvision("")}>{t("关闭")}</button>
            </div>
          </section>
        )}
        {connection && (
          <section className="panel" id="configuration-editor">
            <h2>{t("连接「{name}」", { name: connection.name })}</h2>
            {status.pending_changes && (
              <p className="notice">
                {t("配置未应用，此账户或其修改可能尚未生效。请先应用配置。")}
              </p>
            )}
            <dl className="connection-details">
              <dt>{t("服务器 / 域名")}</dt>
              <dd>{config.settings[0]?.hostname || t("请先配置服务器地址")}</dd>
              <dt>{t("端口")}</dt>
              <dd>{config.settings[0]?.sip_tls_port || 5061}</dd>
              <dt>{t("传输方式")}</dt>
              <dd>TLS</dd>
              <dt>{t("用户名 / 认证用户名")}</dt>
              <dd>{connection.id}</dd>
              <dt>{t("账号密码")}</dt>
              <dd>
                <code>
                  {showPassword ? connection.password : "••••••••••••••••"}
                </code>
                <button onClick={() => setShowPassword(!showPassword)}>
                  {showPassword ? t("隐藏密码") : t("显示密码")}
                </button>
                <button
                  onClick={() =>
                    run(async () => {
                      await navigator.clipboard.writeText(connection.password);
                      setNotice(t("已复制客户端账号密码。"));
                    })
                  }
                >
                  {t("复制密码")}
                </button>
              </dd>
              <dt>{t("分机号")}</dt>
              <dd>{connection.extension}</dd>
            </dl>
            {connection.kind === "client" && <LinphoneImport key={connection.id} identity={connection.id} api={api} run={run} />}
            <button onClick={() => setConnection(null)}>{t("关闭")}</button>
          </section>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
