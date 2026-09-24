import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { startPreviewServer } from "./helpers.mjs";

for (const themeSet of ["standalone", "console"]) {
  for (const mode of ["light", "dark"]) {
    test(`main app accessibility: ${themeSet} ${mode}`, async ({ page }, testInfo) => {
      const mock = await startMockServer();
      const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
      try {
        await page.addInitScript(
          ({ themeSet, mode }) => {
            localStorage.setItem("honua-studio:theme-set", themeSet);
            localStorage.setItem("honua-studio:theme-mode", mode);
          },
          { themeSet, mode },
        );
        await page.goto(preview.url);
        await expect(page.getByTestId("app-shell")).toBeVisible();
        await page.waitForFunction(() => Boolean(window.__honuaStudioApp));

        for (const state of ["signed-out", "signed-in"]) {
          if (state === "signed-in") {
            await page.evaluate((token) => {
              window.__honuaStudioApp.session = { getToken: async () => token, onExpired: () => () => {} };
            }, mintFixtureAccessToken());
          }
          await expect(page.getByTestId("studio-canvas-readout")).toBeVisible();
          const results = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
          await testInfo.attach(`axe-${state}.json`, {
            body: JSON.stringify(results, null, 2),
            contentType: "application/json",
          });
          expect(results.violations.filter(({ impact }) => impact === "serious" || impact === "critical")).toEqual([]);
        }

        // The readout scrolls in map mode and must remain reachable without a mouse.
        const readout = page.getByTestId("studio-canvas-readout");
        await readout.focus();
        await expect(readout).toBeFocused();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        await expect(readout).toBeFocused();
        await testInfo.attach("app.png", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      } finally {
        await preview.close();
        await mock.close();
      }
    });
  }
}
