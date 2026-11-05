import { t } from "./i18n";
import { useEffect, useState } from "react";
import { ScheduleEditor } from "./tenant";
import { Flow } from "./guide";
export function Rules({
  api,
  config,
  experience,
  user,
  medium,
  refresh,
}: {
  api: any;
  config: any;
  experience: any;
  user: any;
  medium: string;
  refresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<any>(null),
    [error, setError] = useState(""),
    [answer, setAnswer] = useState<any>(null),
    [base, setBase] = useState("");
  const rows = config.routes
    .filter((r: any) => r.medium === medium)
    .sort(
      (a: any, b: any) => a.priority - b.priority || a.id.localeCompare(b.id),
    );
  const clients = config.accounts.filter((a: any) => a.kind === "client"),
    lines = config.accounts.filter((a: any) => a.kind === "device");
  useEffect(() => {
    if (draft)
      document
        .getElementById("rule-editor")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [!!draft]);
  function edit(r?: any) {
    setBase(experience.revision);
    setDraft(
      r
        ? {
            ...r,
            receivers:
              r.target_type === "group"
                ? config.groups.find((g: any) => g.id === r.target)?.members ||
                  []
                : [r.target],
          }
        : {
            id:
              user.id +
              "_r_" +
              crypto.randomUUID().replaceAll("-", "").slice(0, 20),
            name: "",
            medium,
            direction: "inbound",
            sources: [],
            match: "any",
            number: "",
            priority: rows.length,
            target_type: "account",
            target: "",
            enabled: true,
            receivers: [],
            schedule: null,
          },
    );
  }
  async function save(
    routes: any[],
    groups = config.groups,
    revision = experience.revision,
  ) {
    setError("");
    try {
      await api("rule-set", "POST", { revision, routes, groups });
      await refresh();
      setDraft(null);
      setAnswer(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function move(from: number, to: number) {
    const copy = [...rows];
    const [item] = copy.splice(from, 1);
    copy.splice(to, 0, item);
    save([
      ...config.routes.filter((x: any) => x.medium !== medium),
      ...copy.map((x: any, j: number) => ({ ...x, priority: j })),
    ]);
  }
  function patch(v: any) {
    setDraft({ ...draft, ...v });
    setAnswer(null);
  }
  return (
    <section className="rules-page">
      <div className="toolbar">
        <span className="subtle">
          {t("{count} 条规则 · 按顺序匹配 · {timezone}", {
            count: rows.length,
            timezone: user.timezone,
          })}
        </span>
        <button className="primary" onClick={() => edit()}>
          {t("添加规则")}
        </button>
      </div>
      {rows.map((r: any, i: number) => (
        <article
          className="panel rule-card"
          key={r.id}
          draggable
          onDragStart={(e) => e.dataTransfer.setData("text/plain", String(i))}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const from = Number(e.dataTransfer.getData("text/plain"));
            if (Number.isInteger(from) && from >= 0 && from < rows.length)
              move(from, i);
          }}
        >
          <h3>
            {i + 1}. {r.name} {!r.enabled && t("（已暂停）")}
          </h3>
          <button
            className="topology-edit"
            onClick={() => edit(r)}
            aria-label={t("编辑拓扑 {name}", { name: r.name })}
          >
            <Flow route={r} config={config} />
            {answer?.targets.some((t: any) => t.id === r.target) && (
              <strong>{t("测试目标")}</strong>
            )}
          </button>
          <p className="subtle">
            {r.schedule
              ? r.schedule.windows
                  .map((w: any) => w.start + "–" + w.end)
                  .join(" / ")
              : t("全天")}{" "}
            · {r.direction === "inbound" ? t("来源号码") : t("目标号码")}
          </p>
          {rows
            .slice(0, i)
            .some(
              (p: any) =>
                p.direction === r.direction &&
                p.match === "any" &&
                !p.schedule &&
                p.enabled &&
                p.sources.some((id: string) => r.sources.includes(id)),
            ) && <p role="status">{t("可能被前面的规则覆盖")}</p>}
          <div className="rule-actions">
            <button onClick={() => edit(r)}>{t("编辑")}</button>
            <button disabled={!i} onClick={() => move(i, i - 1)}>
              {t("上移")}
            </button>
            <button
              disabled={i === rows.length - 1}
              onClick={() => move(i, i + 1)}
            >
              {t("下移")}
            </button>
            <button
              onClick={() => {
                if (confirm(t("删除规则“{name}”？", { name: r.name })))
                  save(config.routes.filter((x: any) => x.id !== r.id));
              }}
            >
              {t("删除规则")}
            </button>
          </div>
        </article>
      ))}
      {!rows.length && <p>{t("暂无路由规则")}</p>}
      {draft && (
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            let groups = [...config.groups],
              r = { ...draft };
            delete r.receivers;
            if (r.direction === "inbound") {
              if (draft.receivers.length > 1) {
                const existing = groups.find(
                  (g: any) =>
                    g.members.length === draft.receivers.length &&
                    g.members.every((id: string) =>
                      draft.receivers.includes(id),
                    ),
                );
                r.target_type = "group";
                r.target =
                  existing?.id ||
                  user.id +
                    "_g_" +
                    crypto.randomUUID().replaceAll("-", "").slice(0, 20);
                if (!existing)
                  groups.push({
                    id: r.target,
                    name: r.name.slice(0, 75) + " " + t("分机组"),
                    members: draft.receivers,
                  });
              } else {
                r.target_type = "account";
                r.target = draft.receivers[0];
              }
            }
            save(
              [...config.routes.filter((x: any) => x.id !== r.id), r],
              groups,
              base,
            );
          }}
        >
          <label>
            {t("规则名称")}
            <input
              required
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </label>
          <label>
            {t("方向")}
            <select
              aria-label={t("方向")}
              value={draft.direction}
              onChange={(e) =>
                patch({
                  direction: e.target.value,
                  sources: [],
                  target: "",
                  receivers: [],
                })
              }
            >
              <option value="inbound">
                {medium === "voice" ? t("呼入") : t("接收")}
              </option>
              <option value="outbound">
                {medium === "voice" ? t("呼出") : t("发送")}
              </option>
            </select>
          </label>
          <fieldset>
            <legend>{t("来源")}</legend>
            {(draft.direction === "inbound" ? lines : clients).map((a: any) => (
              <label key={a.id}>
                <input
                  type="checkbox"
                  checked={draft.sources.includes(a.id)}
                  onChange={(e) =>
                    patch({
                      sources: e.target.checked
                        ? [...draft.sources, a.id]
                        : draft.sources.filter((id: string) => id !== a.id),
                    })
                  }
                />
                {a.name}
              </label>
            ))}
          </fieldset>
          <label>
            {draft.direction === "inbound" ? t("来源号码") : t("目标号码")}
            <select
              value={draft.match}
              onChange={(e) => patch({ match: e.target.value })}
            >
              <option value="any">{t("全部号码")}</option>
              <option value="exact">{t("指定号码")}</option>
              <option value="prefix">{t("号码前缀")}</option>
            </select>
          </label>
          {draft.match !== "any" && (
            <input
              aria-label={t("匹配号码")}
              required
              pattern="\+?[0-9]{1,24}"
              value={draft.number}
              onChange={(e) => patch({ number: e.target.value })}
            />
          )}
          <ScheduleEditor
            value={draft.schedule}
            onChange={(schedule) => patch({ schedule })}
          />
          {draft.direction === "inbound" ? (
            <fieldset>
              <legend>{t("接收分机")}</legend>
              {clients.map((a: any) => (
                <label key={a.id}>
                  <input
                    type="checkbox"
                    checked={draft.receivers.includes(a.id)}
                    onChange={(e) =>
                      patch({
                        receivers: e.target.checked
                          ? [...draft.receivers, a.id]
                          : draft.receivers.filter((id: string) => id !== a.id),
                      })
                    }
                  />
                  {a.name}
                </label>
              ))}
            </fieldset>
          ) : (
            <label>
              {t("出口线路")}
              <select
                required
                value={draft.target}
                onChange={(e) => patch({ target: e.target.value })}
              >
                <option value="">{t("请选择")}</option>
                {lines.map((a: any) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            {t("启用规则")}
          </label>
          <button
            className="primary"
            disabled={
              !draft.sources.length ||
              (draft.direction === "inbound" && !draft.receivers.length)
            }
          >
            {t("保存规则")}
          </button>
          <button type="button" onClick={() => setDraft(null)}>
            {t("取消")}
          </button>
        </form>
      )}
      <details className="panel route-test">
        <summary>{t("路由测试")}</summary>
        <form
          onChange={() => setAnswer(null)}
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            try {
              const d = Object.fromEntries(new FormData(e.currentTarget));
              setAnswer(
                await api("rehearse", "POST", {
                  source: d.source,
                  number: d.number,
                  medium,
                  applied: d.version === "applied",
                  ...(d.at ? { at: new Date(String(d.at)).toISOString() } : {}),
                }),
              );
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <label>
            {t("配置版本")}
            <select name="version">
              <option value="draft">{t("已保存")}</option>
              <option value="applied">{t("已应用")}</option>
            </select>
          </label>
          <label>
            {t("来源账户")}
            <select name="source" required>
              {config.accounts.map((a: any) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("号码")}
            <input name="number" placeholder={t("号码")} required />
          </label>
          <label>
            {t("测试时间")}
            <input
              name="at"
              type="datetime-local"
              aria-label={t("测试时间（浏览器时区）")}
            />
          </label>
          <button>{t("测试路由")}</button>
          {answer && (
            <p role="status">
              {answer.allowed
                ? t("匹配：") +
                  answer.targets.map((t: any) => t.name).join("、")
                : t("无匹配路由")}
            </p>
          )}
        </form>
      </details>
      {error && <p role="alert">{t(error)}</p>}
    </section>
  );
}
