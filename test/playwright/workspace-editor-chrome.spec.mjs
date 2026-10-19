import { expect, test } from "@playwright/test";
import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { startPreviewServer } from "./helpers.mjs";

test("Console host contract has one host navigation/composer and only embedded editing controls", async ({ page }) => {
  const mock = await startMockServer();
  const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
  try {
    await page.addInitScript((token) => {
      window.__honuaStudioFixtureToken = token;
    }, mintFixtureAccessToken());
    await page.goto(`${preview.url}/harness/bare/index.html`);
    // This is a rendered contract harness, not a claim about Console deployment.
    await expect(page.locator("honua-studio-app .app-nav")).toBeVisible();
    await expect(page.getByTestId("studio-chat-input")).toBeVisible();
    await page.evaluate(() => {
      const navigation = document.createElement("nav");
      navigation.setAttribute("aria-label", "Workspace navigation");
      navigation.textContent = "Map · Processes";
      const composer = document.createElement("textarea");
      composer.setAttribute("aria-label", "Workspace conversation");
      document.querySelector("#bare-host").prepend(navigation, composer);
      const app = window.__honuaStudioBareApp;
      app.agentSessionAdapter = {
        async submitTurn() {
          throw new Error("Not executed by this UI contract test.");
        },
      };
      app.composition.apply({ name: "addLayer", layer: { id: "history-fixture", sourceId: "fixture" } });
    });
    await expect(page.getByRole("navigation", { name: "Workspace navigation" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Workspace conversation" })).toBeVisible();
    await expect(page.locator("honua-studio-app .app-nav")).toBeHidden();
    await expect(page.locator("honua-studio-app .app-brand")).toBeHidden();
    await expect(page.getByTestId("app-view")).toBeHidden();
    await expect(page.getByTestId("live-composition-toggle")).toBeHidden();
    await expect(page.getByTestId("live-composition-status")).toBeHidden();
    await expect(page.getByTestId("studio-chat-input")).toBeHidden();
    await expect(page.getByTestId("studio-canvas")).toBeVisible();
    await expect(page.getByTestId("history-undo")).toBeVisible();
    await expect(page.getByTestId("history-undo")).toBeEnabled();
    await page.getByTestId("history-undo").click();
    await expect(page.getByTestId("history-status")).toHaveText("Undone");
    await expect(page.getByRole("navigation")).toHaveCount(1);
    await page.screenshot({ path: ".tmp/workspace-editor-host.png", fullPage: true });
  } finally {
    await preview.close();
    await mock.close();
  }
});
