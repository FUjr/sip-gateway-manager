import { useState } from "react";
import { Icon, labelOf, type Row, type Config } from "./guide";

type Props = {
  config: Config;
  experience: Row;
  status: Row;
  peopleOnly?: boolean;
  go: (tab: string) => void;
  create: (tab: string, values?: Row) => void;
  edit: (tab: string, row: Row) => void;
  connect: (row: Row) => void;
  save: (value: Row) => Promise<void>;
  rehearse: (value: Row) => Promise<Row>;
};
const purposeName = (s: Row) =>
  s.direction === "inbound"
    ? s.medium === "voice"
      ? "谁接电话"
      : "谁收短信"
    : s.medium === "voice"
      ? "谁能用它拨号"
      : "谁能用它发短信";
const scopeName = (s: Row) =>
  s.scope === "exact"
    ? `仅 ${s.number}`
    : s.scope === "prefix"
      ? `以 ${s.number} 开头的外部号码`
      : "所有外部号码";
const enabledFor = (a: Row, medium: string) =>
  a.enabled && a[medium === "voice" ? "voice_enabled" : "sms_enabled"];

function Circuit({
  line,
  people,
  config,
  medium,
  direction,
  custom,
}: {
  line: Row;
  people: Row[];
  config: Config;
  medium: string;
  direction: string;
  custom: boolean;
}) {
  const incoming = direction === "inbound";
  return (
    <div
      className={`service-circuit ${incoming ? "incoming" : "outgoing"}`}
      aria-label="线路用途示意图"
    >
      <div className="circuit-node outside">
        <Icon name={medium === "voice" ? "phone" : "message"} size={28} />
        <strong>外面的电话与短信</strong>
        <small>运营商网络</small>
      </div>
      <div className="circuit-edge">
        <span>{incoming ? "→" : "←"}</span>
        <small>蜂窝网络</small>
      </div>
      <div className="circuit-node line">
        <Icon name="sim" size={28} />
        <strong>{line.name}</strong>
        <small>装在 {labelOf(config.devices, line.device_id)}</small>
        <span className="badge">一张 SIM 卡对应一条线路</span>
      </div>
      <div className="circuit-edge">
        <span>{incoming ? "→" : "←"}</span>
        <small>网关桥接</small>
      </div>
      <div className="circuit-node desk">
        <Icon name="server" size={28} />
        <strong>你的共享总机</strong>
        <small>
          {incoming ? "把收到的内容交给指定终端" : "检查使用权限和号码范围"}
        </small>
        <span className="badge">Asterisk 提供通话能力</span>
      </div>
      <div className="circuit-edge">
        <span>{incoming ? "→" : "←"}</span>
        <small>{medium === "voice" ? "通话" : "短信"}</small>
      </div>
      <div className="circuit-node people">
        <Icon name="group" size={28} />
        <strong>{incoming ? "负责接收的终端" : "获准使用的终端"}</strong>
        <div className="terminal-chips">
          {custom ? (
            <span>按条件分流 · 用号码预演确认</span>
          ) : people.length ? (
            people.map((p) => (
              <span
                key={p.id}
                className={!enabledFor(p, medium) ? "unavailable" : ""}
              >
                {p.name}
              </span>
            ))
          ) : (
            <span>尚未指定</span>
          )}
        </div>
        <small>
          {incoming && people.length > 1
            ? medium === "voice"
              ? "同时响铃，先接者接通"
              : "每个终端各收一份"
            : "手机或电脑上的 SIP 软件"}
        </small>
      </div>
    </div>
  );
}

function ServiceEditor({
  line,
  service,
  revision,
  clients,
  onSave,
  onCancel,
}: {
  line: Row;
  service: Row;
  revision: string;
  clients: Row[];
  onSave: (value: Row) => Promise<void>;
  onCancel: () => void;
}) {
  const [baseRevision] = useState(revision);
  const [people, setPeople] = useState<string[]>(service.people);
  const [scope, setScope] = useState(
      service.configured
        ? service.scope
        : service.direction === "outbound"
          ? "exact"
          : "any",
    ),
    [number, setNumber] = useState(service.number);
  const [enabled, setEnabled] = useState(
    service.configured ? service.enabled : true,
  );
  const [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="purpose-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        setError("");
        try {
          await onSave({
            revision: baseRevision,
            line: line.id,
            medium: service.medium,
            direction: service.direction,
            people,
            scope,
            number,
            enabled,
          });
          onCancel();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setSaving(false);
        }
      }}
    >
      <h3>
        {line.name} · {purposeName(service)}
      </h3>
      <p>
        {service.direction === "inbound"
          ? service.medium === "voice"
            ? "选中多个终端时会同时响铃，由先接听的人接通。"
            : "选中多个终端时，每个终端都会收到一份短信。"
          : "选中的终端可以使用这张卡对外联系，其他终端不会因此获得权限。"}
      </p>
      <fieldset disabled={saving}>
        <legend>
          {service.direction === "inbound"
            ? "交给哪些终端？"
            : "允许哪些终端使用？"}
        </legend>
        <div className="people-options">
          {clients.map((p) => (
            <label key={p.id}>
              <input
                type="checkbox"
                checked={people.includes(p.id)}
                disabled={
                  !enabledFor(p, service.medium) && !people.includes(p.id)
                }
                onChange={(e) =>
                  setPeople(
                    e.target.checked
                      ? [...people, p.id]
                      : people.filter((id) => id !== p.id),
                  )
                }
              />
              {p.name}
              <small>
                {enabledFor(p, service.medium)
                  ? `内部短号 ${p.extension}`
                  : "此业务已停用"}
              </small>
            </label>
          ))}
        </div>
        {!clients.length && <p>先添加一个接听终端，再回来分配用途。</p>}
        {service.direction === "outbound" && (
          <div className="intent-scope">
            <label>
              可以联系哪些外部号码？
              <select
                aria-label="允许的号码范围"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="exact">只允许一个号码</option>
                <option value="prefix">允许某个号段</option>
                <option value="any">允许所有外部号码</option>
              </select>
            </label>
            {scope !== "any" && (
              <label>
                {scope === "exact" ? "允许的号码" : "号码开头"}
                <input
                  aria-label="允许的号码"
                  required
                  pattern="\+?[0-9]{1,24}"
                  value={number}
                  onChange={(e) => setNumber(e.target.value)}
                  placeholder="例如 10099"
                />
              </label>
            )}
          </div>
        )}
        <label className="purpose-toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          启用这个用途
        </label>
      </fieldset>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <p className="purpose-confirm">
        保存后：
        {people.map((id) => labelOf(clients, id)).join("、") || "尚未选择终端"}
        ，
        {service.direction === "outbound"
          ? `使用「${line.name}」${service.medium === "voice" ? "拨号" : "发短信"}，范围为${scopeName({ scope, number })}`
          : `接收「${line.name}」的${service.medium === "voice" ? "来电" : "短信"}`}
        。{!enabled && "这个用途将暂停。"}
      </p>
      <div className="actions">
        <button className="primary" disabled={saving || !people.length}>
          {saving ? "保存中…" : "保存用途"}
        </button>
        <button type="button" disabled={saving} onClick={onCancel}>
          取消
        </button>
      </div>
      <small>
        保存后还需点击页面右上角“应用配置”。不会自动拨号或发送短信。
      </small>
    </form>
  );
}

function Rehearsal({
  config,
  run,
}: {
  config: Config;
  run: Props["rehearse"];
}) {
  const [source, setSource] = useState(""),
    [medium, setMedium] = useState("voice"),
    [number, setNumber] = useState("");
  const [answer, setAnswer] = useState<Row | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const update = (setter: (value: string) => void, value: string) => {
    setter(value);
    setAnswer(null);
    setError("");
  };
  return (
    <section className="panel rehearsal">
      <div className="section-heading">
        <div>
          <span className="eyebrow">先看看会发生什么</span>
          <h2>号码预演</h2>
          <p>按当前保存配置推演，不会真的拨号或发送短信。</p>
        </div>
        <Icon name="route" size={30} />
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setAnswer(null);
          setError("");
          try {
            setAnswer(await run({ source, medium, number }));
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy}>
          <div className="rehearsal-inputs">
            <label>
              从哪里发起？
              <select
                required
                value={source}
                onChange={(e) => update(setSource, e.target.value)}
              >
                <option value="">请选择</option>
                <optgroup label="终端向外联系">
                  {config.accounts
                    .filter((a) => a.kind === "client")
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </optgroup>
                <optgroup label="线路收到外部请求">
                  {config.accounts
                    .filter((a) => a.kind === "device")
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </optgroup>
              </select>
            </label>
            <label>
              做什么？
              <select
                value={medium}
                onChange={(e) => update(setMedium, e.target.value)}
              >
                <option value="voice">打电话</option>
                <option value="sms">发短信</option>
              </select>
            </label>
            <label>
              目标号码
              <input
                required
                pattern="\+?[0-9]{1,24}"
                value={number}
                onChange={(e) => update(setNumber, e.target.value)}
                placeholder="例如 10099"
              />
            </label>
            <button className="primary">
              {busy ? "推演中…" : "看看会到哪里"}
            </button>
          </div>
        </fieldset>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {answer && (
        <div
          className={`rehearsal-answer ${answer.allowed ? "allowed" : "blocked"}`}
          role="status"
        >
          <strong>
            {answer.allowed
              ? answer.internal
                ? "内部互通，不使用 SIM 卡"
                : "配置允许这次转发"
              : "这次不会转发"}
          </strong>
          <p>
            {labelOf(config.accounts, source)} →{" "}
            {answer.allowed
              ? answer.targets.map((t: Row) => t.name).join("、")
              : "没有可用去向"}
          </p>
          <p>{answer.reason}</p>
        </div>
      )}
      <details className="rehearsal-detail">
        <summary>收到的来电如何预演？</summary>
        <p>
          来源选线路，目标号码填网关实际提交给平台的被叫号码。这里不按主叫号码筛选；高级入站条件匹配的也是被叫号码。内部短号优先连接终端。
        </p>
      </details>
    </section>
  );
}

export function Experience(props: Props) {
  const { config, experience, status, go, create, edit, connect } = props;
  const relevance = (line: Row) =>
    line.enabled
      ? line.services.filter(
          (s: Row) => s.configured && (s.enabled || !s.editable),
        ).length
      : -1;
  const lines: Row[] = [...(experience.lines || [])].sort(
    (a, b) => relevance(b) - relevance(a),
  );
  const clients = config.accounts.filter((a) => a.kind === "client");
  const [selected, setSelected] = useState(""),
    [direction, setDirection] = useState("inbound"),
    [medium, setMedium] = useState("voice"),
    [editing, setEditing] = useState<string | null>(null);
  const line = lines.find((l) => l.id === selected) || lines[0];
  const services: Row[] = line?.services || [];
  const service = services.find(
    (s) => s.direction === direction && s.medium === medium,
  );
  const people = clients.filter((p) => service?.people.includes(p.id));
  const terminalCards = (
    <div className="terminal-grid">
      {clients.map((p) => (
        <article className="terminal-card" key={p.id}>
          <span className="node-icon client">
            <Icon name="phone" />
          </span>
          <h3>{p.name}</h3>
          <p>内部短号 {p.extension}</p>
          <small>
            {p.enabled
              ? [p.voice_enabled && "通话", p.sms_enabled && "短信"]
                  .filter(Boolean)
                  .join(" / ") || "业务未启用"
              : "已停用"}{" "}
            · 一个终端连接身份
          </small>
          <div className="actions">
            <button onClick={() => connect(p)}>连接到手机 / 电脑</button>
            <button onClick={() => edit("accounts", p)}>编辑终端</button>
          </div>
        </article>
      ))}
      <button
        className="add-terminal"
        onClick={() => create("accounts", { kind: "client", device_id: "" })}
      >
        <Icon name="phone" />
        <strong>添加接听终端</strong>
        <small>例如自己的手机、家人的电脑</small>
      </button>
    </div>
  );
  if (props.peopleOnly)
    return (
      <>
        <section className="panel">
          <h2>一个终端，就是一个接听位置</h2>
          <p>
            先为手机或电脑创建连接身份，再回到“我的线路”分配接听、收信和对外联系的权限。名称代表终端，不代表管理员账号。
          </p>
          {terminalCards}
          <p className="help">
            终端之间可用内部短号互相通话和发消息；联系外部号码则需要线路授权。
          </p>
        </section>
        <Rehearsal
          key={experience.revision}
          config={config}
          run={props.rehearse}
        />
      </>
    );
  return (
    <>
      <section className="line-welcome">
        <div>
          <span className="eyebrow">把一张 SIM 卡，分享给自己的终端</span>
          <h2>先选卡，再安排谁来接、谁能用。</h2>
          <p>
            线路是网关中的一张 SIM
            卡；终端是手机或电脑上的接听软件。共享总机负责把它们接起来。
          </p>
        </div>
        <div className="line-count">
          <strong>{lines.length}</strong> 条线路 ·{" "}
          <strong>{clients.length}</strong> 个终端
        </div>
      </section>
      {!lines.length ? (
        <section className="panel empty-start">
          <Icon name="sim" size={42} />
          <h2>从第一张卡开始</h2>
          <p>登记网关 → 添加其中一张卡的线路 → 添加接听终端 → 安排用途。</p>
          <button
            className="primary"
            onClick={() =>
              config.devices.length
                ? create("accounts", { kind: "device" })
                : create("devices")
            }
          >
            {config.devices.length ? "添加第一条线路" : "登记第一台网关"}
          </button>
        </section>
      ) : (
        <>
          <div className="line-selector" role="group" aria-label="选择线路">
            {lines.length > 4 ? (
              <label className="compact-line-picker">
                选择一条线路
                <select
                  aria-label="切换线路"
                  value={line.id}
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setEditing(null);
                  }}
                >
                  {config.devices.map((d) => (
                    <optgroup key={d.id} label={d.name}>
                      {lines
                        .filter((l) => l.device_id === d.id)
                        .map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                            {l.enabled ? "" : "（已停用）"}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </select>
              </label>
            ) : (
              lines.map((l) => (
                <button
                  key={l.id}
                  aria-pressed={line.id === l.id}
                  onClick={() => {
                    setSelected(l.id);
                    setEditing(null);
                  }}
                >
                  <Icon name="sim" />
                  <span>
                    <strong>{l.name}</strong>
                    <small>{labelOf(config.devices, l.device_id)}</small>
                  </span>
                  <span className={`badge ${!l.enabled ? "warning" : ""}`}>
                    {l.enabled ? "已创建" : "已停用"}
                  </span>
                </button>
              ))
            )}
            <button
              className="add-line"
              onClick={() => create("accounts", { kind: "device" })}
            >
              ＋ 添加线路
            </button>
          </div>
          <section className="panel line-workspace">
            <div className="section-heading">
              <div>
                <span className="eyebrow">这张卡如何为你服务</span>
                <h2>{line.name}</h2>
                <p>
                  {labelOf(config.devices, line.device_id)} 中的独立线路 · SIM
                  手机号与实际模组需在网关端核实
                </p>
              </div>
              <button
                onClick={() =>
                  connect(config.accounts.find((a) => a.id === line.id)!)
                }
              >
                连接这条线路
              </button>
            </div>
            <div className="purpose-switch">
              <div role="group" aria-label="查看接收或外发">
                <button
                  aria-pressed={direction === "inbound"}
                  onClick={() => {
                    setDirection("inbound");
                    setEditing(null);
                  }}
                >
                  收到后，交给谁
                </button>
                <button
                  aria-pressed={direction === "outbound"}
                  onClick={() => {
                    setDirection("outbound");
                    setEditing(null);
                  }}
                >
                  向外联系，谁能用
                </button>
              </div>
              <div role="group" aria-label="查看通话或短信">
                <button
                  aria-pressed={medium === "voice"}
                  onClick={() => {
                    setMedium("voice");
                    setEditing(null);
                  }}
                >
                  <Icon name="phone" size={16} />
                  通话
                </button>
                <button
                  aria-pressed={medium === "sms"}
                  onClick={() => {
                    setMedium("sms");
                    setEditing(null);
                  }}
                >
                  <Icon name="message" size={16} />
                  短信
                </button>
              </div>
            </div>
            <Circuit
              line={line}
              people={people}
              config={config}
              medium={medium}
              direction={direction}
              custom={service ? !service.editable : false}
            />
            <div className="circuit-caption">
              <span className="legend-dot" />
              <span>
                用途示意，表示已保存的安排；不代表设备在线或运营商已接通。Web
                管理页面负责设置，不参与通话路径。
              </span>
            </div>
            {service && (
              <div
                className={`purpose-summary ${service.enabled && enabledFor(line, medium) ? "ready" : "incomplete"}`}
              >
                <strong>
                  {!service.editable
                    ? "按自定义方案分流"
                    : !service.configured
                      ? "这个用途尚未安排"
                      : !line.enabled ||
                          !line[
                            medium === "voice" ? "voice_enabled" : "sms_enabled"
                          ]
                        ? "线路已停用此业务"
                        : !service.enabled
                          ? "这个用途已暂停"
                          : `${purposeName(service)}：${people.map((p) => p.name).join("、")}`}
                </strong>
                <p>
                  {!service.editable
                    ? service.reason
                    : !service.configured
                      ? `${direction === "inbound" ? "收到后不会自动交给终端" : "终端尚未获得通过这张卡外发的权限"}。其他用途各自独立。`
                      : direction === "outbound"
                        ? `允许联系：${scopeName(service)}。内部短号另行互通。`
                        : medium === "voice"
                          ? "接听方保持客户端运行；多人接听时同时响铃。"
                          : "每个接收终端独立投递；离线可等待重试。"}
                  {people.some((p) => !enabledFor(p, medium)) &&
                    " 包含已停用此业务的终端，它们不会参与转发。"}
                </p>
              </div>
            )}
            <div className="purpose-grid" aria-label="四个线路用途">
              {services.map((s) => (
                <button
                  key={s.direction + s.medium}
                  className={s === service ? "selected" : ""}
                  onClick={() => {
                    setDirection(s.direction);
                    setMedium(s.medium);
                    setEditing(null);
                  }}
                >
                  <span className="purpose-kind">
                    {s.medium === "voice" ? "通话" : "短信"} ·{" "}
                    {s.direction === "inbound" ? "接收" : "外发"}
                  </span>
                  <strong>{purposeName(s)}</strong>
                  <span>
                    {!s.editable
                      ? "自定义分流"
                      : !s.configured
                        ? "尚未安排"
                        : !s.enabled
                          ? "已暂停"
                          : s.people
                              .map((id: string) => labelOf(clients, id))
                              .join("、")}
                  </span>
                  {s.configured && s.direction === "outbound" && (
                    <small>{scopeName(s)}</small>
                  )}
                </button>
              ))}
            </div>
            {editing && service?.editable ? (
              <ServiceEditor
                key={line.id + editing}
                line={line}
                service={service}
                revision={experience.revision}
                clients={clients}
                onSave={props.save}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div className="actions">
                {service?.editable ? (
                  <button
                    className="primary"
                    onClick={() => setEditing(direction + medium)}
                  >
                    安排{purposeName(service)}
                  </button>
                ) : (
                  <button onClick={() => go("routes")}>查看自定义分流</button>
                )}
                <button onClick={() => go("people")}>
                  {clients.length ? "管理接听终端" : "先添加接听终端"}
                </button>
                <button
                  onClick={() =>
                    edit(
                      "accounts",
                      config.accounts.find((a) => a.id === line.id)!,
                    )
                  }
                >
                  线路连接设置
                </button>
              </div>
            )}
          </section>
        </>
      )}
      <Rehearsal
        key={experience.revision}
        config={config}
        run={props.rehearse}
      />
      <section className="next-steps">
        <article>
          <Icon name="device" />
          <strong>连上设备，才有实际线路</strong>
          <p>
            新建线路后，将入网配置导入网关中的对应模组。双模组分别连接，不会自动合并成一张卡。
          </p>
          <button onClick={() => go("devices")}>管理网关设备 ↗</button>
        </article>
        <article>
          <Icon name="check" />
          <strong>
            {status.pending_changes ? "有安排等待生效" : "设置与运行分开确认"}
          </strong>
          <p>
            保存用途后，点击“应用配置”更新总机；再确认设备注册和终端连接。号码预演只检查配置。
          </p>
          <button onClick={() => go("settings")}>服务器连接设置 ↗</button>
        </article>
      </section>
    </>
  );
}
