import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/playwright",
  outputDir: ".tmp/playwright-output",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "dot" : "list",
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  use: {
    headless: true,
  },
});
