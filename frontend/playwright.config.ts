import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  use: {
    baseURL: process.env.WEB_TEST_URL || "https://localhost:28443",
    ignoreHTTPSErrors: true,
  },
  outputDir: "../artifacts/browser",
});
