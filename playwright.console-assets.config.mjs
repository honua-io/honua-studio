import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/console-assets",
  outputDir: ".tmp/console-assets-output",
  timeout: 30_000,
  retries: 0,
  workers: 1,
  use: { browserName: "chromium", headless: true, trace: "retain-on-failure" },
});
