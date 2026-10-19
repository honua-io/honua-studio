import { expect, test } from "@playwright/test";
import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { startPreviewServer } from "./helpers.mjs";

test("host mode leaves one host composer and navigation with canvas and history controls", async ({ page }) => {
  const mock = await startMockServer();
  const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
  try {
    await page.addInitScript((token) => {
      window.__honuaStudioFixtureToken = token;
    }, mintFixtureAccessToken());
    await page.goto(`${preview.url}/harness/bare/index.html`);
    await expect(page.getByRole("navigation", { name: "Studio", exact: true })).toBeVisible();
    await expect(page.getByTestId("studio-chat")).toBeVisible();
    await page.evaluate(() => {
      const nav = document.createElement("nav");
      nav.setAttribute("aria-label", "Host workspace");
      nav.textContent = "Maps · Processes · Shared styles";
      const composer = document.createElement("textarea");
      composer.setAttribute("aria-label", "Shared workspace message");
      document.body.prepend(nav, composer);
      window.__honuaStudioBareApp.agentSessionAdapter = { submitTurn: async () => {} };
    });
    await expect(page.getByRole("navigation", { name: "Host workspace", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Studio", exact: true })).toBeHidden();
    await expect(page.getByText("Natural language to map app.", { exact: true })).toBeHidden();
    await expect(page.getByTestId("studio-chat")).toBeHidden();
    await expect(page.getByTestId("catalog-section")).toBeHidden();
    await expect(page.getByTestId("live-composition-toggle")).toBeHidden();
    await expect(page.getByTestId("studio-canvas")).toBeVisible();
    await expect(page.getByTestId("history-undo")).toBeVisible();
    await expect(page.getByTestId("history-redo")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Shared workspace message" })).toBeVisible();
    await expect(page.locator("textarea:visible")).toHaveCount(1);
    await page.screenshot({ path: ".tmp/workspace-host-chrome.png", fullPage: true });
    await page.evaluate(() => {
      window.__honuaStudioBareApp.agentSessionAdapter = undefined;
    });
    await expect(page.getByRole("navigation", { name: "Studio", exact: true })).toBeVisible();
    await expect(page.getByTestId("studio-chat")).toBeVisible();
  } finally {
    await preview.close();
    await mock.close();
  }
});
