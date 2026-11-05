import {Rules} from './rules';
import {TenantPanel, ScheduleEditor} from './tenant';
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
import { Experience } from "./experience";
const titles: Record<string, string> = {
  overview: "我的线路",
  people: "接听终端",
  devices: "网关设备",
  accounts: "SIM 卡与客户端",
  groups: "接听群组",
  routes: "通话与短信规则",
  deliveries: "短信投递记录",
  settings: "服务器连接",
};
const icons: Record<string, string> = {
  overview: "home",
  people: "phone",
  devices: "device",
  accounts: "sim",
  groups: "group",
  routes: "route",
  settings: "server",
  deliveries: "message",
};
const descriptions: Record<string, string> = {
  overview: "一张卡一条线路，分别安排接听、收信与对外联系。",
  people: "给手机和电脑分配连接身份，再为它们授权使用线路。",
  devices: "先登记你手中的网关，再为其中每个 SIM 卡模组创建账号。",
  accounts:
    "SIM 卡账号连接网关，客户端账号连接手机或电脑。每个账号都有独立分机号。",
  groups:
    "想让多个客户端一起接听？把它们放进一个群组，再将规则的目标选为这个群组。",
  routes: "告诉平台：谁发起、什么号码、交给谁。通话和短信需要分别配置。",
  settings:
    "设备和客户端将使用这里的地址连接平台。高级参数不熟悉时可保留默认值。",
  deliveries: "检查平台是否将短信交给目标账号；“已交付”不等于运营商送达回执。",
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
          ? "账号或密码不正确，请重新输入。"
          : "登录已过期，请刷新页面重新登录。";
    if (typeof error !== "string") error = JSON.stringify(error);
    const translations: Record<string, string> = {
      "extensions must be unique": "分机号已被使用，请换一个。",
      "device account needs a physical device":
        "请先添加网关设备，再选择账号所属设备。",
      "route sources have wrong account type":
        "来源账号与规则方向不一致，请重新选择。",
      "route target has wrong account type":
        "目标账号与规则方向不一致，请重新选择。",
      "exact/prefix route requires a number": "请填写要匹配的号码或前缀。",
      "invalid RTP range": "媒体结束端口必须大于起始端口。",
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
  const [routingMedium,setRoutingMedium]=useState("");
  const [user,setUser]=useState<Row>({}),[auth,setAuth]=useState<Row>({}),[registering,setRegistering]=useState(false),[accountPanel,setAccountPanel]=useState(false);
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
    api("auth/state").then(setAuth).catch(()=>{});
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
        user.id + "_" + (next === "accounts" ? "account" : next.slice(0, -1)) +
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
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            run(async () => {
              const s = await api(registering || auth.bootstrap ? "register" : "login", "POST", {...Object.fromEntries(data), ...(registering || auth.bootstrap ? {timezone:Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}:{})});
              setUser(s);
              csrf = s.csrf;
              setLogged(true);
              await refresh();
            });
          }}
        >
          <span className="mark">SIP</span>
          <h1>通话与短信网关</h1>
          <p>把 SIM 卡上的通话和短信，连接到你的手机与电脑。</p>
          <label>
            用户名
            <input
              name="username"
              defaultValue="admin"
              autoComplete="username"
              required
            />
          </label>
          <label>
            密码
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button disabled={busy}>{registering || auth.bootstrap ? (auth.bootstrap?"注册首个管理员":"注册租户"):"登录"}</button>
          {auth.registration_open && !auth.bootstrap && <button type="button" onClick={()=>setRegistering(!registering)}>{registering?"返回登录":"注册租户"}</button>}
        </form>
      </main>
    );
  if(routingMedium) return <main className="rule-workspace"><button onClick={()=>setRoutingMedium("")}>返回我的线路</button><button onClick={()=>run(async()=>{await api("apply","POST");await refresh()})}>应用配置</button><Rules api={api} config={config} experience={experience} user={user} medium={routingMedium} refresh={refresh}/></main>;
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
      id: "系统自动生成，通常无需修改。只允许小写字母、数字和下划线。",
      name: "起一个看得懂的名字，例如“客厅网关”“广电卡”“我的手机”。",
      extension: "平台内部的短号码，不是 SIM 卡手机号。每个账号必须不同。",
      password: "用于设备或客户端连接平台，已自动生成。与管理员登录密码不同。",
      device_id: "选择这张 SIM 卡模组装在哪台网关里。",
      sources: "只处理这里勾选的账号。每张 SIM 卡 / 每个客户端都可单独设置。",
      target:
        draft.direction === "outbound"
          ? "向外拨号或发短信时，使用这张卡。"
          : "收到后转交给这个客户端或群组。",
      priority: "数字越小越先匹配。多条规则都命中时，只执行第一条。",
      number:
        draft.match === "exact"
          ? "只允许这个完整号码，例如 10099。"
          : "匹配以这些数字开头的号码。",
      hostname:
        "填写设备和手机能访问的域名或 IP；需与服务器证书匹配。不要加 https://。",
      sip_tls_port: "账号连接端口，必须与部署时开放的 SIP TLS 端口一致。",
      members: "勾选参与接听的客户端。语音同时响铃；短信每人收到一份。",
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
              还没有可选账号，请先在“SIM 卡与客户端”中添加。
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
            {!multiple && <option value="">请选择</option>}
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
    rows.map((r) => [r.id, r.name + " (" + r.id + ")"] as [string, string]);
  return (
    <div className="layout">
      <aside>
        <div className="brand">
          <span className="mark">SIP</span>
          <strong>
            通话与短信网关<small>Gateway Manager</small>
          </strong>
        </div>
        <p className="muted">连接你的设备，安排每一次转发。</p>
        <button onClick={()=>setAccountPanel(!accountPanel)}>账号与租户</button>
        <button onClick={()=>setRoutingMedium("voice")}>电话规则</button><button onClick={()=>setRoutingMedium("sms")}>短信规则</button>
        <nav aria-label="主导航">
          {["overview", "people", "deliveries"].map((id) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => go(id)}
            >
              <Icon name={icons[id]} size={20} />
              {titles[id]}
            </button>
          ))}
          <details
            className="advanced-navigation"
            open={
              !["overview", "people", "deliveries"].includes(tab)
                ? true
                : undefined
            }
          >
            <summary>高级配置与连接</summary>
            {["devices", "accounts", "groups", "routes", "settings"].filter(id=>id!=="settings"||user.admin).map(
              (id) => (
                <button
                  key={id}
                  className={tab === id ? "active" : ""}
                  onClick={() => go(id)}
                >
                  <Icon name={icons[id]} size={18} />
                  {titles[id]}
                </button>
              ),
            )}
          </details>
        </nav>
        <div className="sidebar-tip">
          <Icon name="sim" />
          <strong>一张卡，四种用途</strong>
          <p>
            接电话、收短信、拨号、发短信分别安排。没有安排的用途不会自动开放。
          </p>
        </div>
        <button
          onClick={() =>
            run(async () => {
              await api("logout", "POST");
              setLogged(false);
              go("overview");
              setShowPassword(false);
            })
          }
        >
          退出登录
        </button>
      </aside>
      <main>
        {accountPanel && <TenantPanel api={api} user={user}/>}
        <header>
          <div>
            <p className="eyebrow">工作台 / {titles[tab]}</p>
            <h1>{titles[tab]}</h1>
            <p className="page-description">{descriptions[tab]}</p>
          </div>
          <div className="header-actions">
            <button disabled={busy} onClick={() => run(refresh)}>
              刷新状态
            </button>
            <button
              className="primary"
              onClick={() =>
                run(async () => {
                  const r = await api("apply", "POST");
                  setNotice(
                    r.restart_required
                      ? "配置已保存，但连接端口发生变化，需要管理员重启平台服务后才能生效。"
                      : "配置已应用，转发服务已更新。",
                  );
                  await refresh();
                })
              }
              disabled={busy}
            >
              {busy ? "处理中…" : "应用配置"}
            </button>
          </div>
        </header>
        <div
          className={`apply-state ${status.pending_changes ? "pending" : ""}`}
          role="status"
        >
          <span className="legend-dot" />
          {status.pending_changes === true
            ? "有保存的配置尚未应用"
            : status.pending_changes === false
              ? "当前保存配置已应用"
              : status.applied
                ? "平台已有应用记录"
                : "尚未应用配置"}
          <span>设备导入与实际注册状态需在设备端确认</span>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        {!["overview", "people"].includes(tab) && (
          <section className="stats">
            <div>
              <strong>{config.devices.length}</strong>
              <span>网关设备</span>
            </div>
            <div>
              <strong>{devices.length}</strong>
              <span>SIM 卡模组账号</span>
            </div>
            <div>
              <strong>{clients.length}</strong>
              <span>手机 / 电脑客户端</span>
            </div>
            <div>
              <strong>
                {config.routes.filter((r) => r.enabled).length}
                <small> / {config.routes.length}</small>
              </strong>
              <span>启用 / 全部转发规则</span>
            </div>
          </section>
        )}
        {["overview", "people"].includes(tab) ? (
          <Experience
            config={config}
            status={status}
            experience={experience}
            peopleOnly={tab === "people"}
            save={async (value) => {
              await api("line-service", "POST", value);
              await refresh();
              setNotice("用途已保存。点击右上角“应用配置”后生效。");
            }}
            rehearse={(value) => api("rehearse", "POST", value)}
            connect={(row) =>
              run(async () => {
                setDraft(null);
                if (row.kind === "device") {
                  const value = await api("accounts/" + row.id + "/provision");
                  setConnection(null);
                  setProvision(JSON.stringify(value, null, 2));
                } else {
                  setProvision("");
                  setShowPassword(false);
                  setConnection(row);
                }
              })
            }
            go={go}
            create={create}
            edit={(next, row) => {
              edit(next, row);
              if (next === "accounts") setFriendlyEntity(true);
            }}
          />
        ) : tab === "deliveries" ? (
          <section className="panel">
            <button onClick={() => run(refresh)}>刷新</button>
            <table>
              <thead>
                <tr>
                  <th>来源</th>
                  <th>目标</th>
                  <th>状态</th>
                  <th>尝试</th>
                  <th>SIP 响应</th>
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
                            delivered: "已交付目标账号",
                            pending: "等待投递 / 重试",
                            sending: "正在投递",
                            failed: "投递失败",
                            expired: "已过期",
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
                          重新投递
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
                <h3>暂时没有短信投递记录</h3>
                <p>配置短信规则并实际收发后，这里会显示投递结果。</p>
              </div>
            )}
          </section>
        ) : (
          <section className="panel">
            <div className="toolbar">
              <p>
                {tab === "routes"
                  ? "规则按优先级从小到大匹配，第一条命中生效。没有匹配规则时，外部通话 / 短信不会转发。"
                  : tab === "accounts"
                    ? "每个模组使用独立设备账号；客户端使用唯一分机号。"
                    : tab === "groups"
                      ? "语音同时振铃，首个应答接通。短信分别投递。"
                      : "保存后点击右上角“应用配置”使配置生效。"}
              </p>
              <button
                onClick={() => {
                  create(tab);
                }}
              >
                {tab === "settings"
                  ? "编辑设置"
                  : tab === "devices"
                    ? "添加网关"
                    : tab === "accounts"
                      ? "添加账号"
                      : tab === "routes"
                        ? "添加规则"
                        : "添加群组"}
              </button>
            </div>
            <table>
              <thead>
                <tr>
                  <th>名称 / 地址</th>
                  <th>信息</th>
                  <th>操作</th>
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
                      {tab === "accounts"
                        ? `${r.kind === "device" ? "SIM 卡模组" : "手机 / 电脑"} · 分机 ${r.extension} · ${r.enabled ? [r.voice_enabled && "通话", r.sms_enabled && "短信"].filter(Boolean).join(" / ") || "无启用业务" : "已停用"}`
                        : tab === "routes"
                          ? `${r.enabled ? "启用" : "停用"} · ${r.medium === "voice" ? "通话" : "短信"} · ${routeText(r, config)} 优先级 ${r.priority}`
                          : tab === "groups"
                            ? r.members
                                .map((id: string) => labelOf(clients, id))
                                .join("、")
                            : tab === "devices"
                              ? `${devices.filter((a) => a.device_id === r.id).length} 个 SIM 卡模组账号`
                              : `加密连接端口 ${r.sip_tls_port}`}
                    </td>
                    <td>
                      <button
                        onClick={() => {
                          edit(tab, r);
                        }}
                      >
                        编辑
                      </button>
                      {tab !== "settings" && (
                        <button
                          onClick={() => {
                            if (window.confirm("删除 " + r.name + "？"))
                              run(async () => {
                                await api(tab + "/" + r.id, "DELETE");
                                await refresh();
                              });
                          }}
                        >
                          删除
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
                          入网配置
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
                          连接手机 / 电脑
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
                          添加 SIM 卡账号
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
                <h3>
                  从添加{tab === "devices" ? "第一台网关" : titles[tab]}开始
                </h3>
                <p>{descriptions[tab]}</p>
              </div>
            )}
          </section>
        )}
        {draft && (
          <section className="panel editor" id="configuration-editor">
            <h2>
              {editing ? "编辑" : "新增"}
              {friendlyEntity && tab === "accounts"
                ? draft.kind === "device"
                  ? "线路"
                  : "接听终端"
                : titles[tab]}
            </h2>
            <p className="help">
              {tab === "accounts"
                ? "一张 SIM 卡模组或一个接听客户端，对应一个账号。"
                : tab === "routes"
                  ? "按顺序选择下面的项目，右下方会预览转发效果。"
                  : "填写完成后保存，再应用到平台。"}
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  if (tab === "routes" && !draft.sources.length)
                    throw Error("请至少勾选一个来源账号。");
                  if (tab === "groups" && !draft.members.length)
                    throw Error("请至少勾选一个接听客户端。");
                  await api(tab + "/" + (draft.id || "main"), "PUT", draft);
                  setDraft(null);
                  await refresh();
                  if (friendlyEntity && tab === "accounts")
                    go(draft.kind === "device" ? "overview" : "people");
                  setNotice("已保存。下一步点击右上角“应用配置”。");
                });
              }}
            >
              <div className="fields">
                {tab !== "settings" && <>{field("name", "显示名称")}</>}
                {tab === "accounts" && (
                  <>
                    {!friendlyEntity &&
                      field("kind", "这个账号连接什么？", "text", [
                        ["device", "网关里的 SIM 卡模组"],
                        ["client", "手机 / 电脑上的 SIP 客户端"],
                      ])}
                    {draft.kind === "device" &&
                      field(
                        "device_id",
                        "所属设备",
                        "text",
                        opts(config.devices),
                      )}
                    {!friendlyEntity && field("extension", "分机号")}
                    {field("voice_enabled", "启用语音", "checkbox")}
                    {field("sms_enabled", "启用短信", "checkbox")}
                    {field("enabled", "账号启用", "checkbox")}
                  </>
                )}
                {tab === "groups" &&
                  field(
                    "members",
                    "客户端（可多选）",
                    "text",
                    opts(clients),
                    true,
                  )}
                {tab === "routes" && (
                  <>
                    <ScheduleEditor value={draft.schedule} onChange={schedule=>setDraft({...draft,schedule})}/>
                    {field("medium", "业务", "text", [
                      ["voice", "语音"],
                      ["sms", "短信"],
                    ])}
                    {field("direction", "方向", "text", [
                      ["inbound", "收到后转交：SIM 卡 → 手机 / 电脑"],
                      ["outbound", "向外拨号 / 发短信：手机 / 电脑 → SIM 卡"],
                    ])}
                    {field(
                      "sources",
                      "哪些账号发起？（可多选）",
                      "text",
                      opts(draft.direction === "inbound" ? devices : clients),
                      true,
                    )}
                    {field("match", "号码匹配", "text", [
                      ["any", "所有号码"],
                      ["exact", "仅一个指定号码"],
                      ["prefix", "号码以指定数字开头"],
                    ])}
                    {draft.match !== "any" && field("number", "号码 / 前缀")}
                    {field(
                      "target_type",
                      "目标类型",
                      "text",
                      draft.direction === "inbound"
                        ? [
                            ["account", "客户端"],
                            ["group", "客户端群组"],
                          ]
                        : [["account", "模组"]],
                    )}
                    {field(
                      "target",
                      "目标",
                      "text",
                      opts(
                        draft.target_type === "group"
                          ? config.groups
                          : draft.direction === "inbound"
                            ? clients
                            : devices,
                      ),
                    )}
                    {field("enabled", "规则启用", "checkbox")}
                  </>
                )}
                {tab === "settings" && (
                  <>
                    {field("hostname", "服务器地址（域名或 IP）")}
                    {field("sip_tls_port", "SIP TLS 端口", "number")}
                  </>
                )}
              </div>
              {tab === "accounts" &&
                draft.kind === "device" &&
                !config.devices.length && (
                  <p className="error">
                    请先添加一台网关设备，再创建 SIM 卡模组账号。
                    <button type="button" onClick={() => create("devices")}>
                      去添加网关
                    </button>
                  </p>
                )}
              {tab === "routes" && (
                <div className="route-preview">
                  <h3>配置效果预览</h3>
                  <Flow route={draft} config={config} />
                  <p>{routeText(draft, config)}</p>
                  <small>
                    号码条件：{matchName(draft)}。保存并应用后参与匹配。
                  </small>
                </div>
              )}
              <details className="advanced">
                <summary>
                  高级设置
                  {tab === "settings"
                    ? "（不熟悉时保留原值）"
                    : "（系统标识 / 连接参数）"}
                </summary>
                <div className="fields">
                  {tab !== "settings" && field("id", "标识（小写字母开头）")}
                  {tab === "accounts" &&
                    friendlyEntity &&
                    field("extension", "内部短号（自动分配）")}
                  {tab === "accounts" &&
                    field("password", "SIP 密码", "password")}
                  {tab === "routes" && field("priority", "优先级", "number")}
                  {tab === "settings" && (
                    <>
                      {field("realm", "认证域")}
                      {field("rtp_start", "RTP 起始端口", "number")}
                      {field("rtp_end", "RTP 结束端口", "number")}
                      {field("register_interval", "注册周期（秒）", "number")}
                      {field("sms_ttl", "短信有效期（秒）", "number")}
                    </>
                  )}
                </div>
              </details>
              <div className="actions">
                <button className="primary" disabled={busy}>
                  保存
                </button>
                <button type="button" onClick={() => setDraft(null)}>
                  取消
                </button>
              </div>
            </form>
          </section>
        )}
        {provision && (
          <section className="panel" id="configuration-editor">
            <h2>设备入网配置</h2>
            <ol className="instruction-list">
              <li>下载下方入网配置文件。</li>
              <li>打开网关设备的 SIP 管理页面，选择“导入入网配置”。</li>
              <li>选择实际插卡的本地模组及可连接平台的网络，再应用。</li>
              <li>
                在设备端确认账号已注册。双模组需要分别导入各自的配置文件。
              </li>
            </ol>
            <p className="help">
              文件内包含该账号密码，请只交给对应设备使用。创建账号本身不会自动连接设备。
            </p>
            <details className="advanced">
              <summary>查看配置内容（包含密码）</summary>
              <textarea aria-label="入网 JSON" readOnly value={provision} />
            </details>
            <div className="actions">
              <button
                onClick={() =>
                  run(async () => {
                    await navigator.clipboard.writeText(provision);
                    setNotice("已复制");
                  })
                }
              >
                复制
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
                下载入网配置
              </button>
              <button onClick={() => setProvision("")}>关闭</button>
            </div>
          </section>
        )}
        {connection && (
          <section className="panel" id="configuration-editor">
            <h2>连接「{connection.name}」</h2>
            <p>
              在支持 SIP TLS
              的手机或电脑客户端中添加账号，按下表填写。客户端软件应保持运行才能接听。
            </p>
            <dl className="connection-details">
              <dt>服务器 / 域名</dt>
              <dd>{config.settings[0]?.hostname || "请先配置服务器地址"}</dd>
              <dt>端口</dt>
              <dd>{config.settings[0]?.sip_tls_port || 5061}</dd>
              <dt>传输方式</dt>
              <dd>TLS（加密连接）</dd>
              <dt>用户名 / 认证用户名</dt>
              <dd>{connection.id}</dd>
              <dt>账号密码</dt>
              <dd>
                <code>
                  {showPassword ? connection.password : "••••••••••••••••"}
                </code>
                <button onClick={() => setShowPassword(!showPassword)}>
                  {showPassword ? "隐藏密码" : "显示密码"}
                </button>
                <button
                  onClick={() =>
                    run(async () => {
                      await navigator.clipboard.writeText(connection.password);
                      setNotice("已复制客户端账号密码。");
                    })
                  }
                >
                  复制密码
                </button>
              </dd>
              <dt>内部短号码</dt>
              <dd>{connection.extension}（分机号，不是手机号）</dd>
            </dl>
            <p className="help">
              服务器证书需要被客户端信任。外部来电与短信还需要对应的转发规则；当前页面不执行拨号或发送短信。
            </p>
            <button onClick={() => setConnection(null)}>关闭</button>
          </section>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
