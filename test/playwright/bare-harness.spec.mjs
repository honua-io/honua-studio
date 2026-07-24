/**
 * Bare embed harness smoke (honua-studio#5 REQ-003): proves
 * `<honua-studio-app>` mounts, composes, and navigates identically when a
 * third party (no console, no standalone shell chrome) hosts it with only a
 * fixture session and the public element contract. Compare against
 * boot-mock.spec.mjs, which drives the same composition journey
 * (catalog/packages render, theme switch, nav) in the standalone shell — the
 * epic's "same composition journey passes in both hosts" acceptance
 * criterion (honua-studio#2).
 */
import { expect, test } from "@playwright/test";

import { startMockServer } from "../../mock-server.mjs";
import { startPreviewServer } from "./helpers.mjs";

test.describe("bare embed harness (harness/bare)", () => {
  test("mounts honua-studio-app with a fixture session, composes chat + canvas, and navigates — with zero host CSS leakage", async ({
    page,
  }) => {
    const mock = await startMockServer();
    const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
    try {
      await page.goto(`${preview.url}/harness/bare/index.html`);

      // The host page around the element is real and untouched by Studio.
      await expect(page.getByTestId("host-page-marker")).toBeVisible();
      await expect(page.getByTestId("bare-host")).toBeVisible();

      // The element itself, mounted purely through the public contract.
      await expect(page.getByTestId("app-shell")).toBeVisible();
      await expect(page.getByTestId("catalog-list")).toContainText("Hawai'i statewide parcels");
      await expect(page.getByTestId("packages-list")).toContainText("Statewide roads condition dashboard");

      // Default composition: chat + canvas placeholders are present and session-aware.
      await expect(page.getByTestId("studio-chat")).toBeVisible();
      await expect(page.getByTestId("studio-chat-session-status")).toHaveText("authenticated");
      await expect(page.getByTestId("studio-canvas")).toBeVisible();

      // Same navigation journey as the standalone shell (boot-mock.spec.mjs).
      await page.getByTestId("nav-about").click();
      await expect(page.getByTestId("about-section")).toBeVisible();
      await page.getByTestId("nav-home").click();
      await expect(page.getByTestId("catalog-section")).toBeVisible();

      // Theming still works scoped to the element, with zero token CSS
      // loaded by this host page (styles.ts's var(--hn-*, fallback) chain).
      await page.getByTestId("theme-set-console").click();
      const app = page.locator("honua-studio-app");
      await expect(app).toHaveAttribute("data-theme-set", "console");
      await expect(page.locator("html")).not.toHaveAttribute("data-theme-set", "console");

      // Shadow-DOM style encapsulation: the host page's serif/purple chrome
      // never reaches inside the element, and the element's own button
      // styling never leaks out onto the host's <h1>.
      const hostHeadingFont = await page.locator(".host-chrome > h1").evaluate((el) => getComputedStyle(el).fontFamily);
      expect(hostHeadingFont.toLowerCase()).toContain("times");
      const shellFont = await page.getByTestId("app-shell").evaluate((el) => getComputedStyle(el).fontFamily);
      expect(shellFont.toLowerCase()).not.toContain("times");
    } finally {
      await preview.close();
      await mock.close();
    }
  });

  test("dispatches honua-studio-chat-message when the placeholder composer submits", async ({ page }) => {
    const mock = await startMockServer();
    const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
    try {
      await page.goto(`${preview.url}/harness/bare/index.html`);
      await expect(page.getByTestId("studio-chat")).toBeVisible();

      const eventDetail = page.evaluate(
        () =>
          new Promise((resolve) => {
            window.__honuaStudioBareApp
              .querySelector("honua-studio-chat")
              .addEventListener("honua-studio-chat-message", (event) => resolve(event.detail), { once: true });
          }),
      );
      await page.getByTestId("studio-chat-input").fill("Show me the parcels layer");
      await page.getByTestId("studio-chat-send").click();
      expect(await eventDetail).toEqual({ text: "Show me the parcels layer" });
    } finally {
      await preview.close();
      await mock.close();
    }
  });
});
