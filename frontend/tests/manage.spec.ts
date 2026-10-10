import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const env = Object.fromEntries(
  readFileSync("../.env", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => l.split("=")),
);
test("authenticated graphical management and enrollment export", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("密码", { exact: true }).fill(env.ADMIN_PASSWORD);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "设备", exact: true }),
  ).toBeVisible();
  const id = "browser_" + Date.now();
  await page.getByRole("button", { name: "新增", exact: true }).click();
  await page.getByLabel("标识（小写字母开头）").fill(id);
  await page.getByLabel("显示名称").fill("Device " + id);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "Device " + id, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "SIP 用户", exact: true }).click();
  await page.getByRole("button", { name: "新增", exact: true }).click();
  await page.getByLabel("标识（小写字母开头）").fill(id + "_modem");
  await page.getByLabel("显示名称").fill("Modem " + id);
  await page.getByLabel("所属设备").selectOption(id);
  await page.getByLabel("分机号").fill(String(Date.now()).slice(-10));
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "Modem " + id, exact: true }),
  ).toBeVisible();
  const row = page
    .getByRole("row")
    .filter({
      has: page.getByRole("cell", { name: "Modem " + id, exact: true }),
    });
  await row.getByRole("button", { name: "入网配置" }).click();
  const json = JSON.parse(await page.getByLabel("入网 JSON").inputValue());
  expect(json.schema_version).toBe(1);
  expect(json.account_id).toBe(id + "_modem");
  expect(json.transport).toBe("tls");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "应用到 Asterisk" }).click();
  await expect(page.getByRole("status")).toContainText("配置已应用");
  await page.screenshot({
    path: "../artifacts/browser/management.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "SIP 用户", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(
    page.getByRole("button", { name: "登录", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "登录", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
