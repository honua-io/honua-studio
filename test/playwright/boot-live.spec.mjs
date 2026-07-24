/**
 * Boot smoke: `npm run dev:live`'s mode (honua-studio#3 REQ-003, env-config
 * path). CI has no real honua-server to point at, so this spec stands a
 * second, independent instance of the same loopback fixture server in for
 * "a real server" and drives it through `--mode live` (vite.config.ts's
 * live-mode guard) instead of scripts/dev-mock.mjs — proving the
 * HONUA_BASE_URL-driven proxy wiring is a genuinely distinct code path from
 * the fixture path in boot-mock.spec.mjs, not the same thing under a
 * different name. Swap HONUA_BASE_URL for a real honua-server locally to
 * exercise this against the genuine article.
 */
import { expect, test } from "@playwright/test";

import { startMockServer } from "../../mock-server.mjs";
import { startPreviewServer } from "./helpers.mjs";

test("app boots against a server selected purely via HONUA_BASE_URL", async ({ page }) => {
  const liveStandIn = await startMockServer();
  const preview = await startPreviewServer({ HONUA_BASE_URL: liveStandIn.url }, ["--mode", "live"]);
  try {
    await page.goto(preview.url);

    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByTestId("catalog-error")).toHaveCount(0);
    await expect(page.getByTestId("catalog-list")).toContainText("Hawai'i statewide parcels");
    await expect(page.getByTestId("packages-list")).toContainText("Statewide roads condition dashboard");
  } finally {
    await preview.close();
    await liveStandIn.close();
  }
});

test("refuses to start in live mode without HONUA_BASE_URL", async () => {
  // vite.config.ts throws synchronously in --mode live when the env var is
  // unset — this guards REQ-003's "real server via env config" contract at
  // the config layer, not just deep in application code.
  await expect(startPreviewServer({ HONUA_BASE_URL: "" }, ["--mode", "live"])).rejects.toThrow();
});
