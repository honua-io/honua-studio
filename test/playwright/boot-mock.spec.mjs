/**
 * Boot smoke: `npm run dev`'s mode (honua-studio#3 REQ-003, fixture path).
 * Builds are produced by `npm run test:browser` before Playwright runs
 * (package.json). This spec proxies the built preview server at the mock
 * fixture, exactly as scripts/dev-mock.mjs wires `npm run dev`.
 */
import { expect, test } from "@playwright/test";

import { startMockServer } from "../../mock-server.mjs";
import { startPreviewServer } from "./helpers.mjs";

test("app boots against the mock honua-server fixture and renders catalog + packages", async ({ page }) => {
  const mock = await startMockServer();
  const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
  try {
    await page.goto(preview.url);

    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByTestId("catalog-error")).toHaveCount(0);
    await expect(page.getByTestId("packages-error")).toHaveCount(0);
    await expect(page.getByTestId("catalog-list")).toContainText("Hawai'i statewide parcels");
    await expect(page.getByTestId("packages-list")).toContainText("Statewide roads condition dashboard");

    // REQ-002: the theme SET switches without any code change — a pure
    // data-theme-set attribute flip that restyles every token consumer.
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme-set", "standalone");
    await page.getByTestId("theme-set-console").click();
    await expect(html).toHaveAttribute("data-theme-set", "console");
    await expect(page.getByTestId("theme-set-console")).toHaveAttribute("aria-pressed", "true");

    // Router stub: a second route renders without reloading.
    await page.getByTestId("nav-about").click();
    await expect(page.getByTestId("about-section")).toBeVisible();
  } finally {
    await preview.close();
    await mock.close();
  }
});
