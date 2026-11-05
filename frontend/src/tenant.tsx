import { useEffect, useState } from "react";
type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
export function TenantPanel({ api, user }: { api: Api; user: any }) {
  const [rows, setRows] = useState<any[]>([]),
    [open, setOpen] = useState(false),
    [error, setError] = useState(""),
    [zone, setZone] = useState(user.timezone);
  async function load() {
    if (user.admin) {
      setRows(await api("platform/tenants"));
      setOpen((await api("auth/state")).registration_open);
    }
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  async function run(fn: () => Promise<void>) {
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="panel tenant-panel">
      <h2>账户与租户</h2>
      <p>
        {user.username} · {user.admin ? "平台管理员" : "租户"}
      </p>
      <label>
        规则时区
        <input value={zone} onChange={(e) => setZone(e.target.value)} />
      </label>
      <button
        onClick={() =>
          run(async () => {
            await api("me/timezone", "PUT", { timezone: zone });
            location.reload();
          })
        }
      >
        保存时区
      </button>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const d = Object.fromEntries(new FormData(e.currentTarget));
          run(async () => {
            await api("me/password", "PUT", d);
            location.reload();
          });
        }}
      >
        <h3>修改登录密码</h3>
        <input
          name="current_password"
          type="password"
          placeholder="原密码"
          required
        />
        <input
          name="password"
          type="password"
          minLength={12}
          placeholder="新密码（至少12字符）"
          required
        />
        <button>修改并退出</button>
      </form>
      {!!user.admin && (
        <>
          <h3>租户管理</h3>
          <label>
            <input
              type="checkbox"
              checked={open}
              onChange={(e) =>
                run(async () => {
                  await api("platform/registration", "PUT", {
                    enabled: e.target.checked,
                  });
                })
              }
            />
            允许公开注册
          </label>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const d = Object.fromEntries(new FormData(e.currentTarget));
              run(async () => {
                await api("platform/tenants", "POST", { ...d, timezone: zone });
              });
            }}
          >
            <input name="username" placeholder="新租户用户名" required />
            <input
              name="password"
              type="password"
              minLength={12}
              placeholder="初始密码"
              required
            />
            <button>创建租户</button>
          </form>
          <div className="tenant-list">
            {rows.map((r) => (
              <article key={r.id}>
                <strong>{r.username}</strong> · {r.timezone}{" "}
                {!r.active && "删除待重试"}{" "}
                {r.id !== user.id && (
                  <>
                    <button
                      onClick={() => {
                        const value = prompt("输入新密码（至少12字符）");
                        if (value)
                          run(async () => {
                            await api(
                              `platform/tenants/${r.id}/reset-password`,
                              "POST",
                              { password: value },
                            );
                          });
                      }}
                    >
                      重置密码
                    </button>
                    <button
                      onClick={() => {
                        if (
                          confirm(
                            `删除 ${r.username} 的全部配置与短信记录？新通信立即禁止，已接通电话自然结束。`,
                          )
                        )
                          run(async () => {
                            await api(`platform/tenants/${r.id}`, "DELETE");
                          });
                      }}
                    >
                      删除租户
                    </button>
                  </>
                )}
              </article>
            ))}
          </div>{" "}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
export function ScheduleEditor({
  value,
  onChange,
}: {
  value: any;
  onChange: (v: any) => void;
}) {
  const schedule = value || {
    weekdays: [0, 1, 2, 3, 4],
    windows: [{ start: "09:00", end: "18:00" }],
  };
  return (
    <fieldset>
      <legend>生效时间</legend>
      <label>
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => onChange(e.target.checked ? schedule : null)}
        />
        仅在指定时间生效
      </label>
      {value && (
        <>
          <div className="weekdays">
            {["一", "二", "三", "四", "五", "六", "日"].map((d, i) => (
              <label key={i}>
                <input
                  type="checkbox"
                  checked={schedule.weekdays.includes(i)}
                  onChange={(e) =>
                    onChange({
                      ...schedule,
                      weekdays: e.target.checked
                        ? [...schedule.weekdays, i]
                        : schedule.weekdays.filter((v: number) => v !== i),
                    })
                  }
                />
                周{d}
              </label>
            ))}
          </div>
          {schedule.windows.map((w: any, i: number) => (
            <div className="time-window" key={i}>
              {["start", "end"].map((k) => (
                <input
                  key={k}
                  aria-label={k === "start" ? "开始时间" : "结束时间"}
                  type="time"
                  value={w[k]}
                  onChange={(e) =>
                    onChange({
                      ...schedule,
                      windows: schedule.windows.map((x: any, j: number) =>
                        i === j ? { ...x, [k]: e.target.value } : x,
                      ),
                    })
                  }
                />
              ))}
              <button
                type="button"
                onClick={() =>
                  onChange({
                    ...schedule,
                    windows: schedule.windows.filter(
                      (_: any, j: number) => j !== i,
                    ),
                  })
                }
              >
                移除时段
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              onChange({
                ...schedule,
                windows: [
                  ...schedule.windows,
                  { start: "09:00", end: "18:00" },
                ],
              })
            }
          >
            添加时段
          </button>
          <small className="help">结束早于开始时跨午夜</small>
        </>
      )}
    </fieldset>
  );
}
