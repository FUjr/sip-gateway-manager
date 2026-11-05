import { test, expect } from "@playwright/test";

// Isolated fixtures; these tests never contact the user's device or place calls.
const initial = (): Record<string, any[]> => ({
  devices: [{ id: "gateway", name: "双模组网关" }],
  accounts: [
    {
      id: "gd",
      name: "广电卡",
      kind: "device",
      device_id: "gateway",
      extension: "8801",
      password: "test_password_12345678",
      enabled: true,
      sms_enabled: true,
      voice_enabled: true,
    },
    {
      id: "mobile",
      name: "移动卡",
      kind: "device",
      device_id: "gateway",
      extension: "8802",
      password: "test_password_12345678",
      enabled: true,
      sms_enabled: true,
      voice_enabled: false,
    },
    {
      id: "phone",
      name: "我的手机",
      kind: "client",
      device_id: "",
      extension: "8899",
      password: "test_password_87654321",
      enabled: true,
      sms_enabled: true,
      voice_enabled: true,
    },
  ],
  groups: [{ id: "family", name: "家人", members: ["phone"] }],
  routes: [
    {
      id: "gd_call",
      name: "广电客服通话",
      medium: "voice",
      direction: "outbound",
      sources: ["phone"],
      match: "exact",
      number: "10099",
      priority: 0,
      target_type: "account",
      target: "gd",
      enabled: true,
    },
    {
      id: "gd_sms",
      name: "接收广电回复",
      medium: "sms",
      direction: "inbound",
      sources: ["gd"],
      match: "exact",
      number: "10099",
      priority: 0,
      target_type: "group",
      target: "family",
      enabled: true,
    },
    {
      id: "disabled",
      name: "已暂停规则",
      medium: "voice",
      direction: "outbound",
      sources: ["phone"],
      match: "any",
      number: "",
      priority: 100,
      target_type: "account",
      target: "mobile",
      enabled: false,
    },
  ],
  settings: [
    {
      hostname: "gateway.example.test",
      sip_tls_port: 15061,
      rtp_start: 32000,
      rtp_end: 32199,
      realm: "sip-gateway",
      register_interval: 300,
      sms_ttl: 604800,
    },
  ],
});

test.beforeEach(async ({ page }, info) => {
  const conf = initial();
  if (info.title.startsWith("empty"))
    for (const key of Object.keys(conf)) conf[key] = [];
  if (info.title.startsWith("many"))
    for (let i = 0; i < 6; i++)
      conf.accounts.push({
        ...conf.accounts[0],
        id: "extra_" + i,
        name: "其他线路 " + i,
      });
  let logged = false,
    pending = false;
  let modelReads = 0;
  const model = () => ({
    revision:
      info.title.startsWith("stale") && modelReads++ > 0
        ? "new-revision"
        : "fixture-revision",
    lines: conf.accounts
      .filter((a) => a.kind === "device")
      .map((a) => ({
        ...a,
        services: ["inbound", "outbound"].flatMap((direction) =>
          ["voice", "sms"].map((medium) => {
            const routes = conf.routes.filter(
              (r) =>
                r.direction === direction &&
                r.medium === medium &&
                (direction === "inbound"
                  ? r.sources.includes(a.id)
                  : r.target === a.id),
            );
            const r = routes.length === 1 ? routes[0] : null;
            return {
              direction,
              medium,
              configured: !!routes.length,
              editable:
                routes.length <= 1 &&
                (!r ||
                  direction === "outbound" ||
                  (r.sources.length === 1 && r.match === "any")),
              enabled: !!r?.enabled,
              people: !r
                ? []
                : direction === "outbound"
                  ? r.sources
                  : r.target_type === "group"
                    ? conf.groups.find((g) => g.id === r.target)?.members || []
                    : [r.target],
              scope: r?.match || "any",
              number: r?.number || "",
              route_ids: routes.map((r) => r.id),
              reason:
                "此用途含条件分流或共用规则，需在高级配置中调整，避免改变其他线路。",
            };
          }),
        ),
      })),
  });
  await page.route("**/api/v1/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.replace("/api/v1/", "");
    const send = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "login") {
      logged = true;
      return send({ csrf: "test-csrf" });
    }
    if (!logged) return send({ detail: "authentication required" }, 401);
    if (path === "session") return send({ csrf: "test-csrf" });
    if (path === "config") return send(conf);
    if (path === "experience") return send(model());
    if (path === "status")
      return send({ pending_changes: pending, applied: { revision: "test" } });
    if (path === "deliveries") return send([]);
    if (path === "apply") {
      pending = false;
      return send({ applied: true, restart_required: false });
    }
    if (path === "line-service") {
      const v = req.postDataJSON();
      if (info.title.startsWith("stale") && v.revision !== "new-revision")
        return send({ detail: "配置已被更新，请刷新后重新设置。" }, 409);
      const old = conf.routes.find(
        (r) =>
          r.direction === v.direction &&
          r.medium === v.medium &&
          (v.direction === "inbound"
            ? r.sources.includes(v.line)
            : r.target === v.line),
      );
      const r = {
        id: old?.id || "new-service",
        name: old?.name || "新用途",
        direction: v.direction,
        medium: v.medium,
        sources: v.direction === "outbound" ? v.people : [v.line],
        target_type: "account",
        target: v.direction === "outbound" ? v.line : v.people[0],
        match: v.scope,
        number: v.number,
        priority: old?.priority || 100,
        enabled: v.enabled,
      };
      conf.routes = [...conf.routes.filter((x) => x.id !== r.id), r];
      pending = true;
      return send(model());
    }
    if (path === "rehearse") {
      const v = req.postDataJSON();
      // Fixed responses, not another implementation of the production resolver.
      const allowed =
          v.source === "phone" && ["10099", "8899"].includes(v.number),
        internal = v.number === "8899";
      return send({
        allowed,
        internal,
        targets: allowed
          ? [
              {
                id: internal ? "phone" : "gd",
                name: internal ? "我的手机" : "广电卡",
              },
            ]
          : [],
        reason: allowed
          ? "配置允许，实际连接取决于注册状态。"
          : "没有可用去向。",
      });
    }
    if (path.endsWith("/provision"))
      return send({
        account_id: path.split("/")[1],
        server: conf.settings[0]?.hostname,
        password: "fixture-secret",
      });
    const [kind, id] = path.split("/");
    if (req.method() === "PUT" && conf[kind]) {
      const value = req.postDataJSON();
      if (
        kind === "accounts" &&
        conf.accounts.some(
          (a) => a.extension === value.extension && a.id !== id,
        )
      )
        return send({ detail: "extensions must be unique" }, 422);
      conf[kind] = [
        ...conf[kind].filter((r) => (r.id || "main") !== id),
        value,
      ];
      pending = true;
      return send(value);
    }
    return send({ detail: "Unexpected API request: " + path }, 404);
  });
  await page.goto("/");
  await page.getByLabel("密码", { exact: true }).fill("fixture-admin-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "我的线路", exact: true }),
  ).toBeVisible();
});

test("line purposes explain inbound/outbound separately and preserve custom routing", async ({
  page,
}) => {
  await expect(page.getByLabel("四个线路用途").getByRole("button")).toHaveCount(
    4,
  );
  await expect(page.locator(".purpose-summary")).toContainText("尚未安排");
  await page
    .getByRole("button", { name: "向外联系，谁能用", exact: true })
    .click();
  await expect(page.locator(".purpose-summary")).toContainText("仅 10099");
  await expect(page.getByLabel("线路用途示意图")).toContainText("我的手机");
  await expect(page.getByLabel("线路用途示意图")).toContainText("双模组网关");
  await expect(page.locator(".circuit-edge span").first()).toHaveText("←");
  await page
    .getByRole("button", { name: "收到后，交给谁", exact: true })
    .click();
  await page
    .getByRole("group", { name: "查看通话或短信" })
    .getByRole("button", { name: "短信", exact: true })
    .click();
  await expect(page.locator(".purpose-summary")).toContainText(
    "自定义方案分流",
  );
  await expect(
    page.getByRole("button", { name: "查看自定义分流" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "安排谁收短信" })).toHaveCount(
    0,
  );
  await page
    .getByRole("group", { name: "选择线路" })
    .getByRole("button", { name: /移动卡/ })
    .click();
  await page
    .getByRole("button", { name: "向外联系，谁能用", exact: true })
    .click();
  await page
    .getByRole("group", { name: "查看通话或短信" })
    .getByRole("button", { name: "通话", exact: true })
    .click();
  await expect(page.locator(".purpose-summary")).toContainText(
    "线路已停用此业务",
  );
});

test("purpose editor retains exact limits and saves intent without technical fields", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "向外联系，谁能用", exact: true })
    .click();
  await page
    .getByRole("button", { name: "安排谁能用它拨号", exact: true })
    .click();
  await expect(page.getByLabel("允许的号码范围")).toHaveValue("exact");
  await expect(page.getByLabel("允许的号码", { exact: true })).toHaveValue(
    "10099",
  );
  await expect(page.getByRole("checkbox", { name: /我的手机/ })).toBeChecked();
  const request = page.waitForRequest((r) =>
    r.url().endsWith("/api/v1/line-service"),
  );
  await page.getByRole("button", { name: "保存用途", exact: true }).click();
  expect((await request).postDataJSON()).toMatchObject({
    line: "gd",
    medium: "voice",
    direction: "outbound",
    scope: "exact",
    number: "10099",
    people: ["phone"],
  });
  await expect(page.locator(".notice")).toContainText("用途已保存");
  await expect(page.locator(".apply-state")).toContainText("尚未应用");
});

test("number rehearsal rejects unsupported numbers and invalidates old answers", async ({
  page,
}) => {
  await page.getByLabel("从哪里发起？").selectOption("phone");
  await page.getByLabel("目标号码", { exact: true }).fill("10099");
  await page.getByRole("button", { name: "看看会到哪里" }).click();
  await expect(page.locator(".rehearsal-answer")).toContainText("广电卡");
  await page.getByLabel("目标号码", { exact: true }).fill("10086");
  await expect(page.locator(".rehearsal-answer")).toHaveCount(0);
  await page.getByRole("button", { name: "看看会到哪里" }).click();
  await expect(page.locator(".rehearsal-answer")).toContainText("这次不会转发");
  await page.getByLabel("目标号码", { exact: true }).fill("8899");
  await page.getByRole("button", { name: "看看会到哪里" }).click();
  await expect(page.locator(".rehearsal-answer")).toContainText(
    "不使用 SIM 卡",
  );
});

test("semantic diagram and terminal connection controls fit mobile", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "向外联系，谁能用", exact: true })
    .click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "/tmp/sip-line-experience-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("线路用途示意图")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/sip-line-experience-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "接听终端", exact: true })
    .click();
  await page
    .getByRole("button", { name: "连接到手机 / 电脑", exact: true })
    .click();
  await expect(page.locator(".connection-details")).not.toContainText(
    "test_password_87654321",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("account creation, duplicate validation, enrollment and apply remain available", async ({
  page,
}) => {
  await page.getByText("高级配置与连接", { exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "SIM 卡与客户端" })
    .click();
  await page.getByRole("button", { name: "添加账号", exact: true }).click();
  await page.getByLabel("显示名称", { exact: false }).fill("新手机");
  await page.getByLabel("这个账号连接什么？").selectOption("client");
  await page.getByLabel("分机号", { exact: false }).fill("8801");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "分机号已被使用，请换一个。",
  );
  await page.getByLabel("分机号", { exact: false }).fill("1001");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.reload();
  await expect(page.locator(".apply-state")).toContainText("尚未应用");
  await page.getByRole("button", { name: "应用配置", exact: true }).click();
  await expect(page.locator(".apply-state")).toContainText(
    "当前保存配置已应用",
  );
  await page.getByRole("button", { name: "连接这条线路" }).click();
  await page.getByText("查看配置内容（包含密码）", { exact: true }).click();
  expect(
    JSON.parse(await page.getByLabel("入网 JSON").inputValue()).account_id,
  ).toBe("gd");
});

test("advanced route editor resets incompatible direction choices", async ({
  page,
}) => {
  await page.getByText("高级配置与连接", { exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "通话与短信规则" })
    .click();
  await page.getByRole("button", { name: "添加规则", exact: true }).click();
  await page.getByLabel("显示名称", { exact: false }).fill("仅广电客服");
  await page.getByLabel("方向", { exact: true }).selectOption("outbound");
  await page.getByRole("checkbox", { name: /我的手机/ }).check();
  await page.getByLabel("号码匹配").selectOption("exact");
  await page.getByLabel("号码 / 前缀", { exact: false }).fill("10099");
  await page
    .getByLabel("目标", { exact: false })
    .filter({ has: page.locator("option[value=gd]") })
    .selectOption("gd");
  await expect(page.locator(".route-preview")).toContainText("仅号码 10099");
  await page.getByLabel("方向", { exact: true }).selectOption("inbound");
  await expect(
    page.getByRole("checkbox", { name: /广电卡/ }),
  ).not.toBeChecked();
});

test("empty install starts with a gateway then a line and terminal", async ({
  page,
}) => {
  await expect(
    page.getByRole("heading", { name: "从第一张卡开始" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "登记第一台网关", exact: true })
    .click();
  await page.getByLabel("显示名称", { exact: false }).fill("我的第一台网关");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  const row = page
    .getByRole("row")
    .filter({ has: page.getByText("我的第一台网关", { exact: true }) });
  await row.getByRole("button", { name: "添加 SIM 卡账号" }).click();
  await expect(page.getByLabel("所属设备")).not.toHaveValue("");
  await page.getByLabel("显示名称", { exact: false }).fill("广电 SIM 卡");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "我的线路", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "广电 SIM 卡", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "先添加接听终端" }).click();
  await page.getByRole("button", { name: /添加接听终端/ }).click();
  await expect(
    page.getByRole("heading", { name: "新增接听终端" }),
  ).toBeVisible();
  await expect(page.getByLabel("这个账号连接什么？")).toHaveCount(0);
});

test("many lines use a compact gateway-grouped picker", async ({ page }) => {
  const picker = page.getByLabel("切换线路", { exact: true });
  await expect(picker).toHaveValue("gd");
  await picker.selectOption("extra_5");
  await expect(
    page.getByRole("heading", { name: "其他线路 5", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("stale purpose form keeps its original revision after a global refresh", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "向外联系，谁能用", exact: true })
    .click();
  await page
    .getByRole("button", { name: "安排谁能用它拨号", exact: true })
    .click();
  const refreshed = page.waitForResponse((r) =>
    r.url().endsWith("/api/v1/experience"),
  );
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await refreshed;
  await page.getByRole("button", { name: "保存用途", exact: true }).click();
  await expect(
    page.locator(".purpose-editor").getByRole("alert"),
  ).toContainText("配置已被更新");
  await expect(page.getByLabel("允许的号码", { exact: true })).toHaveValue(
    "10099",
  );
});
