import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
  testDir: ".",
  testMatch: "site-preview.browser.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: "list",
  outputDir: "../test-results/site-preview",
  use: { browserName: "chromium", baseURL: "http://127.0.0.1:4178", viewport: { width: 1440, height: 1000 }, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { cwd: resolve(__dirname, ".."), command: "node scripts/site-preview-server.mjs", url: "http://127.0.0.1:4178", reuseExistingServer: false, timeout: 30_000 },
});
