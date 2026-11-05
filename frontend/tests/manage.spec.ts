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
  let provisioning = 0;
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
    if (path === "auth/state")
      return send({ bootstrap: false, registration_open: false });
    if (path === "login") {
      logged = true;
      return send({
        csrf: "test-csrf",
        id: "tfixture",
        username: "owner",
        admin: 1,
        timezone: "Asia/Shanghai",
      });
    }
    if (!logged) return send({ detail: "authentication required" }, 401);
    if (path === "session")
      return send({
        csrf: "test-csrf",
        id: "tfixture",
        username: "owner",
        admin: 1,
        timezone: "Asia/Shanghai",
      });
    if (path === "accounts/phone/linphone") {
      if (req.method() === "DELETE") return send({ ok: true });
      return send({ path: "/api/v1/linphone/" + (++provisioning) + ".xml", expires: Date.now() / 1000 + 600 });
    }
    if (path === "config") return send(conf);
    if (path === "experience") return send(model());
    if (path === "status")
      return send({
        registrations: { gd: true, mobile: false, phone: true },
        pending_changes: pending,
        applied: { revision: "test" },
      });
    if (path === "deliveries") return send([]);
    if (path === "apply") {
      pending = false;
      return send({ applied: true, restart_required: false });
    }
    if (path === "rule-set") {
      const v = req.postDataJSON();
      if (info.title.startsWith("stale") && v.revision !== "new-revision")
        return send({ detail: "配置已被更新，请刷新后重新设置。" }, 409);
      conf.routes = v.routes;
      conf.groups = v.groups;
      pending = true;
      return send(model());
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
  await expect(page.getByLabel("用户名", { exact: true })).toHaveValue("");
  await page.getByLabel("用户名", { exact: true }).fill("owner");
  await page.getByLabel("密码", { exact: true }).fill("fixture-admin-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "概览", exact: true }),
  ).toBeVisible();
});

test("dashboard shows real registration and independent routing navigation", async ({
  page,
}) => {
  await expect(page.getByLabel("平台概览")).toContainText("在线账户");
  await expect(
    page.locator(".resource-row").filter({ hasText: "广电卡" }),
  ).toContainText("在线");
  await expect(
    page.locator(".resource-row").filter({ hasText: "移动卡" }),
  ).toContainText("离线");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "电话路由", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "编辑拓扑 广电客服通话" }),
  ).toContainText("10099");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "短信路由", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "编辑拓扑 接收广电回复" }),
  ).toContainText("来源线路");
});
test("account creation validates duplicate extension and marks connection credentials unapplied", async ({
  page,
}) => {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "SIP 账户", exact: true })
    .click();
  await page.getByRole("button", { name: "添加账号", exact: true }).click();
  await page.getByLabel("显示名称").fill("Mac");
  await page.getByLabel("账户类型").selectOption("client");
  await page.getByLabel("分机号", { exact: true }).fill("8801");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("分机号已被使用");
  await page.getByLabel("分机号", { exact: true }).fill("1001");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".apply-state")).toContainText("配置未应用");
  const row = page
    .getByRole("row")
    .filter({ has: page.getByText("Mac", { exact: true }) });
  await row.getByRole("button", { name: "连接配置", exact: true }).click();
  await expect(page.locator("#configuration-editor > .notice")).toContainText(
    "配置未应用",
  );
  await expect(page.locator(".connection-details")).toContainText("1001");
  await page.getByRole("button", { name: "应用配置", exact: true }).click();
  await expect(page.locator(".apply-state")).toContainText("配置已应用");
  await expect(page.locator("#configuration-editor > .notice")).toHaveCount(0);
});
test("connection password is hidden and mobile stays within viewport", async ({
  page,
}) => {
  await page
    .locator(".resource-row")
    .filter({ hasText: "我的手机" })
    .getByRole("button", { name: "连接配置", exact: true })
    .click();
  await expect(page.locator(".connection-details")).not.toContainText(
    "test_password_87654321",
  );
  await page.getByRole("button", { name: "显示密码", exact: true }).click();
  await expect(page.locator(".connection-details")).toContainText(
    "test_password_87654321",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "../artifacts/browser/redesign-mobile.png",
    fullPage: true,
  });
});
test("graphical route editor preserves conditions and clears incompatible direction", async ({
  page,
}) => {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "电话路由", exact: true })
    .click();
  await page.getByRole("button", { name: "编辑拓扑 广电客服通话" }).click();
  await expect(page.getByLabel("匹配号码", { exact: true })).toHaveValue(
    "10099",
  );
  await expect(
    page.getByRole("checkbox", { name: "我的手机", exact: true }),
  ).toBeChecked();
  await page.getByLabel("方向", { exact: true }).selectOption("inbound");
  await expect(
    page.getByRole("checkbox", { name: "广电卡", exact: true }),
  ).not.toBeChecked();
  await page.getByRole("checkbox", { name: "广电卡", exact: true }).check();
  await page.getByRole("checkbox", { name: "我的手机", exact: true }).check();
  await page.getByRole("checkbox", { name: "仅在指定时间生效" }).check();
  await page.getByLabel("开始时间", { exact: true }).fill("22:00");
  await page.getByLabel("结束时间", { exact: true }).fill("02:00");
  await page.getByRole("button", { name: "保存规则", exact: true }).click();
  await expect(page.locator(".apply-state")).toContainText("配置未应用");
  await expect(
    page.getByRole("button", { name: "编辑拓扑 广电客服通话" }),
  ).toBeVisible();
});
test("route tests distinguish applied and draft and clear stale results", async ({
  page,
}) => {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "电话路由", exact: true })
    .click();
  await page.getByText("路由测试", { exact: true }).click();
  await page.getByLabel("来源账户").selectOption("phone");
  await page.getByRole("textbox", { name: "号码", exact: true }).fill("10099");
  await page.getByRole("button", { name: "测试路由", exact: true }).click();
  await expect(page.getByRole("status").last()).toContainText("广电卡");
  await page.getByRole("textbox", { name: "号码", exact: true }).fill("10086");
  await expect(page.getByText("匹配：广电卡", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "测试路由", exact: true }).click();
  await expect(page.getByRole("status").last()).toContainText("无匹配路由");
});
test("empty install can add a gateway and SIM account", async ({ page }) => {
  await expect(page.getByText("暂无 SIM 线路", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "添加线路", exact: true }).click();
  await page.getByLabel("显示名称").fill("Gateway");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page
    .getByRole("button", { name: "添加 SIM 线路", exact: true })
    .click();
  await page.getByLabel("显示名称").fill("SIM");
  await expect(page.getByLabel("所属设备")).not.toHaveValue("");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page
      .getByRole("row")
      .filter({ has: page.getByText("SIM", { exact: true }) }),
  ).toBeVisible();
});
test("stale rule edits keep original revision across refresh", async ({
  page,
}) => {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "电话路由", exact: true })
    .click();
  await page.getByRole("button", { name: "编辑拓扑 广电客服通话" }).click();
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await page.getByRole("button", { name: "保存规则", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("配置已被更新");
  await expect(page.getByLabel("匹配号码", { exact: true })).toHaveValue(
    "10099",
  );
});

test("language changes preserve route edits and user names", async ({
  page,
}) => {
  await page
    .getByRole("combobox", { name: "语言", exact: true })
    .selectOption("en");
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".resource-row").filter({ hasText: "广电卡" }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Call routing", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Edit routing diagram: 广电客服通话",
      exact: true,
    })
    .click();
  await expect(page.getByLabel("Number to match", { exact: true })).toHaveValue(
    "10099",
  );
  await page.getByLabel("Number to match", { exact: true }).fill("10000");
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-TW");
  await expect(page.getByLabel("匹配號碼", { exact: true })).toHaveValue(
    "10000",
  );
  await expect(
    page.getByRole("checkbox", { name: "我的手机", exact: true }),
  ).toBeChecked();
  await page.getByRole("checkbox", { name: "僅在指定時間生效" }).check();
  await expect(
    page.getByRole("checkbox", { name: "週一", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "語言", exact: true })
    .selectOption("en");
  await expect(
    page.getByRole("checkbox", { name: "Mon", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
});

test("translated errors follow language changes and SIP ports stay literal", async ({
  page,
}) => {
  await page
    .getByRole("combobox", { name: "语言", exact: true })
    .selectOption("en");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "SIP accounts", exact: true })
    .click();
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await page.getByLabel("Display name", { exact: true }).fill("测试账户");
  await page.getByLabel("Extension number", { exact: true }).fill("8801");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/extension/i);
  await page
    .getByRole("combobox", { name: "Language", exact: true })
    .selectOption("zh-CN");
  await expect(page.getByRole("alert")).toContainText("分机号已被使用");
  await page
    .getByRole("combobox", { name: "语言", exact: true })
    .selectOption("en");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Server settings", exact: true })
    .click();
  await expect(page.getByRole("table")).toContainText("15061");
  await expect(page.getByRole("table")).not.toContainText("15,061");
});


test("Linphone QR provisioning generates, rotates and revokes a link on mobile", async ({ page }) => {
  await page.locator(".resource-row").filter({ hasText: "我的手机" })
    .getByRole("button", { name: "连接配置", exact: true }).click();
  await expect(page.getByRole("button", { name: "生成二维码与配置链接" })).toBeVisible();
  await page.getByRole("button", { name: "生成二维码与配置链接" }).click();
  await expect(page.getByLabel("配置链接", { exact: true })).toHaveValue(/\/api\/v1\/linphone\/1\.xml$/);
  await expect(page.locator(".linphone-export svg")).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "重新生成配置链接" }).click();
  await expect(page.getByLabel("配置链接", { exact: true })).toHaveValue(/\/2\.xml$/);
  await page.getByRole("button", { name: "撤销配置链接" }).click();
  await expect(page.locator(".linphone-export")).toHaveCount(0);
});
