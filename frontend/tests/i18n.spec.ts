import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const catalog: Record<
  string,
  Record<string, string | Record<string, string>>
> = JSON.parse(
  readFileSync(new URL("../src/messages.json", import.meta.url), "utf8"),
);
test("catalog preserves interpolation parameters in every translation", () => {
  const parameters = (s: string) =>
    [...s.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]).sort();
  for (const [source, translations] of Object.entries(catalog))
    for (const message of Object.values(translations))
      for (const value of typeof message === "string"
        ? [message]
        : Object.values(message)) {
        expect(value, source).toBeTruthy();
        expect(parameters(value), source).toEqual(parameters(source));
      }
});
for (const [browserLanguage, expected] of [
  ["en-US", "en"],
  ["zh-HK", "zh-TW"],
  ["zh-CN", "zh-CN"],
]) {
  test(`login follows browser ${browserLanguage} and persists selection`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      locale: browserLanguage,
      baseURL,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    await page.route("**/api/v1/**", (route) =>
      route.fulfill({
        status: route.request().url().endsWith("/session") ? 401 : 200,
        contentType: "application/json",
        body: JSON.stringify({ bootstrap: false, registration_open: false }),
      }),
    );
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", expected);
    await expect(page.locator('input[autocomplete="username"]')).toHaveValue(
      "",
    );
    await page.getByRole("combobox").selectOption("en");
    await page.getByLabel("Username", { exact: true }).fill("我的账号");
    await page.getByRole("combobox").selectOption("zh-TW");
    await expect(page.locator('input[autocomplete="username"]')).toHaveValue(
      "我的账号",
    );
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-TW");
    await context.close();
  });
}
