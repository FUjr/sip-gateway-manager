import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type Row = Record<string, any>;
type Config = Record<string, Row[]>;
const titles: Record<string, string> = {
  devices: "设备",
  accounts: "SIP 用户",
  groups: "客户端群组",
  routes: "路由",
  settings: "服务器",
  deliveries: "短信投递",
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
    throw Error(String(error));
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
    [tab, setTab] = useState("devices"),
    [draft, setDraft] = useState<Row | null>(null),
    [editing, setEditing] = useState(false),
    [provision, setProvision] = useState(""),
    [deliveries, setDeliveries] = useState<Row[]>([]);
  async function refresh() {
    setConfig(await api("config"));
    setDeliveries(await api("deliveries"));
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
    api("session")
      .then((s) => {
        csrf = s.csrf;
        setLogged(true);
        return refresh();
      })
      .catch(() => {});
  }, []);
  if (!logged)
    return (
      <main className="login">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            run(async () => {
              const s = await api("login", "POST", Object.fromEntries(data));
              csrf = s.csrf;
              setLogged(true);
              await refresh();
            });
          }}
        >
          <span className="mark">SIP</span>
          <h1>网关管理</h1>
          <p>使用管理员账号登录</p>
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
          <button disabled={busy}>登录</button>
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
    return (
      <label key={key}>
        {label}
        {options ? (
          <select
            value={value}
            multiple={multiple}
            onChange={(e) =>
              setDraft({
                ...draft,
                [key]: multiple
                  ? Array.from(e.target.selectedOptions, (o) => o.value)
                  : e.target.value,
              })
            }
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
            checked={value}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })}
          />
        ) : (
          <input
            type={type}
            value={value}
            required={key !== "number"}
            disabled={key === "id" && editing}
            onChange={(e) =>
              setDraft({
                ...draft,
                [key]:
                  type === "number" ? Number(e.target.value) : e.target.value,
              })
            }
          />
        )}
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
          <strong>Gateway Manager</strong>
        </div>
        <p className="muted">设备 · 通话 · 短信</p>
        <nav>
          {Object.entries(titles).map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => {
                setTab(id);
                setDraft(null);
                setProvision("");
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        <button
          onClick={() =>
            run(async () => {
              await api("logout", "POST");
              setLogged(false);
            })
          }
        >
          退出登录
        </button>
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">SIP 管理平台</p>
            <h1>{titles[tab]}</h1>
          </div>
          <button
            onClick={() =>
              run(async () => {
                const r = await api("apply", "POST");
                setNotice(
                  r.restart_required ? r.detail : "配置已应用 · " + r.revision,
                );
              })
            }
            disabled={busy}
          >
            应用到 Asterisk
          </button>
        </header>
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
        <section className="stats">
          <div>
            <strong>{config.devices.length}</strong>
            <span>设备</span>
          </div>
          <div>
            <strong>{devices.length}</strong>
            <span>模组账号</span>
          </div>
          <div>
            <strong>{clients.length}</strong>
            <span>客户端</span>
          </div>
          <div>
            <strong>{config.routes.length}</strong>
            <span>路由规则</span>
          </div>
        </section>
        {tab === "deliveries" ? (
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
                    <td>{d.source}</td>
                    <td>{d.target}</td>
                    <td>{d.status}</td>
                    <td>{d.attempts}</td>
                    <td>{d.code ?? "—"}</td>
                    <td>
                      {d.status === "pending" && (
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
                          重试
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : (
          <section className="panel">
            <div className="toolbar">
              <p>
                {tab === "routes"
                  ? "优先级从小到大，第一条匹配生效。未匹配时拒绝。"
                  : tab === "accounts"
                    ? "每个模组使用独立设备账号；客户端使用唯一分机号。"
                    : tab === "groups"
                      ? "语音同时振铃，首个应答接通。短信分别投递。"
                      : "保存后点击“应用到 Asterisk”使配置生效。"}
              </p>
              <button
                onClick={() => {
                  setDraft(
                    tab === "settings" && config.settings[0]
                      ? { ...config.settings[0] }
                      : defaults[tab](),
                  );
                  setEditing(false);
                }}
              >
                {tab === "settings" ? "编辑设置" : "新增"}
              </button>
            </div>
            <table>
              <thead>
                <tr>
                  <th>标识</th>
                  <th>名称 / 地址</th>
                  <th>信息</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {config[tab].map((r) => (
                  <tr key={r.id || "main"}>
                    <td>{r.id || "main"}</td>
                    <td>{r.name || r.hostname}</td>
                    <td>
                      {tab === "accounts"
                        ? `${r.kind === "device" ? "设备" : "客户端"} · ${r.extension} · ${r.voice_enabled ? "语音 " : ""}${r.sms_enabled ? "短信" : ""}`
                        : tab === "routes"
                          ? `${r.medium === "voice" ? "语音" : "短信"} · ${r.direction} · ${r.priority} → ${r.target}`
                          : tab === "groups"
                            ? r.members.join(", ")
                            : ""}
                    </td>
                    <td>
                      <button
                        onClick={() => {
                          setDraft({ ...r });
                          setEditing(true);
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
                            })
                          }
                        >
                          入网配置
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!config[tab].length && (
              <div className="empty">
                尚未添加{titles[tab]}。点击新增开始配置。
              </div>
            )}
          </section>
        )}
        {draft && (
          <section className="panel editor">
            <h2>
              {editing ? "编辑" : "新增"}
              {titles[tab]}
            </h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  await api(tab + "/" + (draft.id || "main"), "PUT", draft);
                  setDraft(null);
                  await refresh();
                  setNotice("已保存，请应用配置。");
                });
              }}
            >
              <div className="fields">
                {tab !== "settings" && (
                  <>
                    {field("id", "标识（小写字母开头）")}
                    {field("name", "显示名称")}
                  </>
                )}
                {tab === "accounts" && (
                  <>
                    {field("kind", "账号类型", "text", [
                      ["device", "设备模组"],
                      ["client", "外部 SIP 客户端"],
                    ])}
                    {draft.kind === "device" &&
                      field(
                        "device_id",
                        "所属设备",
                        "text",
                        opts(config.devices),
                      )}
                    {field("extension", "分机号")}
                    {field("password", "SIP 密码", "password")}
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
                    {field("medium", "业务", "text", [
                      ["voice", "语音"],
                      ["sms", "短信"],
                    ])}
                    {field("direction", "方向", "text", [
                      ["inbound", "模组 → 客户端"],
                      ["outbound", "客户端 → 模组"],
                    ])}
                    {field(
                      "sources",
                      "来源账号（可多选）",
                      "text",
                      opts(draft.direction === "inbound" ? devices : clients),
                      true,
                    )}
                    {field("match", "号码匹配", "text", [
                      ["any", "任意"],
                      ["exact", "精确"],
                      ["prefix", "前缀"],
                    ])}
                    {draft.match !== "any" && field("number", "号码 / 前缀")}
                    {field("priority", "优先级", "number")}
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
                    {field("hostname", "公网 TLS 域名")}
                    {field("sip_tls_port", "SIP TLS 端口", "number")}
                    {field("realm", "认证域")}
                    {field("rtp_start", "RTP 起始端口", "number")}
                    {field("rtp_end", "RTP 结束端口", "number")}
                    {field("register_interval", "注册周期（秒）", "number")}
                    {field("sms_ttl", "短信有效期（秒）", "number")}
                  </>
                )}
              </div>
              <div className="actions">
                <button disabled={busy}>保存</button>
                <button type="button" onClick={() => setDraft(null)}>
                  取消
                </button>
              </div>
            </form>
          </section>
        )}
        {provision && (
          <section className="panel">
            <h2>设备入网配置</h2>
            <p>
              在设备的 SIP
              管理页面导入，选择本地模组与网络。配置含密码，请妥善保存。
            </p>
            <textarea aria-label="入网 JSON" readOnly value={provision} />
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
                  a.download = "sip-provision.json";
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                下载 JSON
              </button>
              <button onClick={() => setProvision("")}>关闭</button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
