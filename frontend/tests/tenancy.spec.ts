import { test, expect } from "@playwright/test";
import fs from "node:fs";
test("real tenant login, graphical scheduled rules and isolation", async ({
  page,
  request,
}) => {
  test.skip(
    !process.env.TENANT_TEST_URL,
    "Requires the disposable multitenant stack",
  );
  const base = process.env.TENANT_TEST_URL!;
  const env = fs.readFileSync(new URL("../../.env", import.meta.url), "utf8");
  const secret = env
    .split("\n")
    .find((s) => s.startsWith("ADMIN_PASSWORD="))!
    .slice("ADMIN_PASSWORD=".length);
  const admin = await request.post(base + "/api/v1/login", {
    data: { username: "admin", password: secret },
  });
  expect(admin.ok()).toBeTruthy();
  const owner = await admin.json();
  const username = "browser_" + Date.now();
  const password = "browser-validation-password-123";
  const added = await request.post(base + "/api/v1/platform/tenants", {
    headers: { "x-csrf-token": owner.csrf },
    data: { username, password, timezone: "UTC" },
  });
  expect(added.ok()).toBeTruthy();
  const tenant = await added.json();
  await page.goto(base);
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page
      .getByRole("navigation")
      .getByRole("button", { name: "电话路由", exact: true }),
  ).toBeVisible();
  const session = await (
    await page.request.get(base + "/api/v1/session")
  ).json();
  async function put(kind: string, value: any) {
    const r = await page.request.put(
      base + "/api/v1/" + kind + "/" + value.id,
      { headers: { "x-csrf-token": session.csrf }, data: value },
    );
    expect(r.ok(), await r.text()).toBeTruthy();
  }
  const gateway = tenant.id + "_gateway",
    line = tenant.id + "_line",
    phone = tenant.id + "_phone";
  await put("devices", { id: gateway, name: "Browser Gateway" });
  for (const [id, kind, name, extension] of [
    [line, "device", "SIM Alpha", "100"],
    [phone, "client", "Phone Alpha", "200"],
  ])
    await put("accounts", {
      id,
      name,
      kind,
      extension,
      device_id: kind === "device" ? gateway : "",
      password: "sip-browser-password-123",
    });
  await page.reload();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "电话路由", exact: true })
    .click();
  await page.getByRole("button", { name: "添加规则", exact: true }).click();
  await page.getByLabel("规则名称").fill("Weekday reception");
  await page.getByRole("checkbox", { name: "SIM Alpha", exact: true }).check();
  await page
    .getByRole("checkbox", { name: "Phone Alpha", exact: true })
    .check();
  await page.getByRole("checkbox", { name: "仅在指定时间生效" }).check();
  await page.getByLabel("开始时间", { exact: true }).fill("22:00");
  await page.getByLabel("结束时间", { exact: true }).fill("02:00");
  await page.getByRole("button", { name: "保存规则", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "1. Weekday reception", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "编辑拓扑 Weekday reception" })
    .click();
  await expect(page.getByLabel("开始时间", { exact: true })).toHaveValue(
    "22:00",
  );
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "应用配置", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(base + "/api/v1/status")).json())
          .pending_changes,
    )
    .toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "添加规则", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "../artifacts/browser/tenant-scheduled-rules-mobile.png",
    fullPage: true,
  });
  const cfg = await (await page.request.get(base + "/api/v1/config")).json();
  expect(cfg.accounts.map((a: any) => a.id).sort()).toEqual(
    [line, phone].sort(),
  );
  await page.getByRole("button", { name: "账户与租户", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "账户与租户", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("租户管理", { exact: true })).toHaveCount(0);
  const removed = await request.delete(
    base + "/api/v1/platform/tenants/" + tenant.id,
    { headers: { "x-csrf-token": owner.csrf } },
  );
  expect(removed.ok(), await removed.text()).toBeTruthy();
  expect((await page.request.get(base + "/api/v1/session")).status()).toBe(401);
});
