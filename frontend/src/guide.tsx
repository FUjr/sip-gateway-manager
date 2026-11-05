export type Row = Record<string, any>;
export type Config = Record<string, Row[]>;
export const labelOf = (rows: Row[], id: string) =>
  rows.find((r) => r.id === id)?.name || id || "尚未选择";
export const mediumName = (value: string) =>
  value === "voice" ? "通话" : "短信";
export const matchName = (r: Row) =>
  r.match === "exact"
    ? `仅号码 ${r.number || "…"}`
    : r.match === "prefix"
      ? `号码以 ${r.number || "…"} 开头`
      : "所有号码";
export function routeText(r: Row, config: Config) {
  const source =
    (r.sources || [])
      .map((id: string) => labelOf(config.accounts, id))
      .join("、") || "尚未选择来源";
  const target = labelOf(
    r.target_type === "group" ? config.groups : config.accounts,
    r.target,
  );
  return r.direction === "outbound"
    ? `${source} 向外${r.medium === "voice" ? "拨号" : "发短信"}时，${matchName(r)}，使用「${target}」的 SIM 卡。`
    : `「${source}」收到${mediumName(r.medium)}时，按被叫号码匹配（${matchName(r)}），转交给「${target}」。`;
}

export function Icon({ name, size = 22 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    home: (
      <>
        <path d="m3 10 9-7 9 7v10H3Z" />
        <path d="M9 20v-7h6v7" />
      </>
    ),
    device: (
      <>
        <rect x="3" y="8" width="18" height="12" rx="3" />
        <path d="M7 8V3m10 5V3M7 15h.01M11 15h6" />
      </>
    ),
    phone: (
      <>
        <rect x="6" y="2" width="12" height="20" rx="3" />
        <path d="M10 18h4M10 5h4" />
      </>
    ),
    sim: (
      <>
        <path d="M6 3h8l4 4v14H6Z" />
        <rect x="9" y="10" width="6" height="7" rx="1" />
      </>
    ),
    route: (
      <>
        <path d="M4 7h15l-4-4m4 4-4 4M20 17H5l4 4m-4-4 4-4" />
      </>
    ),
    server: (
      <>
        <rect x="3" y="3" width="18" height="7" rx="2" />
        <rect x="3" y="14" width="18" height="7" rx="2" />
        <path d="M7 6.5h.01M7 17.5h.01M12 7h5M12 18h5" />
      </>
    ),
    message: (
      <>
        <path d="M21 15a3 3 0 0 1-3 3H8l-5 4V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3Z" />
        <path d="M7 8h10M7 12h6" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    group: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6m1 4a5 5 0 0 1 3 5" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.home}
    </svg>
  );
}

export function Flow({ route, config }: { route: Row; config: Config }) {
  const outbound = route.direction === "outbound";
  const nodes = [
    {
      icon: outbound ? "phone" : "sim",
      title: outbound
        ? "发起的客户端"
        : route.medium === "voice"
          ? "接到来电的 SIM 卡"
          : "收到短信的 SIM 卡",
      text:
        (route.sources || [])
          .map((s: string) => labelOf(config.accounts, s))
          .join("、") || "选择来源",
    },
    {
      icon: "server",
      title: "Asterisk 转发服务",
      text: `${mediumName(route.medium)} · ${matchName(route)}`,
    },
    {
      icon: outbound
        ? "sim"
        : route.target_type === "group"
          ? "group"
          : "phone",
      title: outbound ? "使用这张 SIM 卡" : "交给这里处理",
      text: labelOf(
        route.target_type === "group" ? config.groups : config.accounts,
        route.target,
      ),
    },
  ];
  const external = {
    icon: "phone",
    title: "运营商网络 / 外部号码",
    text: outbound ? matchName(route) : `${route.medium === "voice" ? "主叫" : "发信号码"} · ${matchName(route)}`,
  };
  if (outbound) nodes.push(external);
  else nodes.unshift(external);
  return (
    <div className="flow" aria-label="规则流向示意">
      {nodes.map((n, i) => (
        <div className="flow-piece" key={i}>
          {i > 0 && (
            <span className="flow-arrow">
              <Icon name="arrow" />
            </span>
          )}
          <div className={`flow-node ${n.icon === "server" ? "flow-hub" : ""}`}>
            <Icon name={n.icon} />
            <small>{n.title}</small>
            <strong>{n.text}</strong>
          </div>
        </div>
      ))}
    </div>
  );
}
