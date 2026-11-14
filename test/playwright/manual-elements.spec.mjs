import { expect, test } from "@playwright/test";
import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { startPreviewServer, waitForSignedInMap, waitForStudioApp } from "./helpers.mjs";

test("manual chart and control persist, undo and reopen without a model", async ({ page }) => {
  const mock = await startMockServer();
  const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
  try {
    await page.goto(preview.url);
    await waitForStudioApp(page);
    await page.evaluate((token) => {
      window.__honuaStudioApp.session = { getToken: async () => token, onExpired: () => () => {} };
    }, mintFixtureAccessToken());
    await waitForSignedInMap(page);
    await createMap(page);
    await addChart(page);
    await undoControlRemoval(page);
    await reopenMap(page);
  } finally {
    await preview.close();
    await mock.close();
  }
});

async function createMap(page) {
  await page.getByTestId("recipe-toggle").click();
  await page.getByTestId("recipe-package-key").fill("manual-elements");
  await page.getByTestId("recipe-source").selectOption("hi-parcels/0");
  await expect(page.getByTestId("recipe-status")).toContainText("Verified");
  await page.getByTestId("recipe-category").selectOption("zoning_code");
  await page.getByTestId("recipe-columns").getByLabel("zoning_code", { exact: true }).check();
  await page.getByTestId("recipe-create").click();
  await expect(page.getByTestId("recipe-status")).toContainText("Created draft");
  await page.getByTestId("recipe-close").click();
}

async function addChart(page) {
  await page.getByTestId("manual-elements-toggle").focus();
  await page.keyboard.press("Enter");
  const panel = page.locator("#manual-elements-panel");
  await expect(panel).toBeVisible();
  await panel.getByLabel("Element", { exact: true }).selectOption("chart");
  await panel.getByLabel("Title (optional)").fill("Parcels by zoning");
  await panel.getByLabel("Data layer").selectOption("explore-layer");
  await panel.getByLabel("Category field").fill("zoning_code");
  await panel.getByRole("button", { name: "Add element", exact: true }).click();
  await expect(panel.getByRole("status")).toContainText("Saved");
  await expect(page.getByTestId("studio-widget-chart")).toBeVisible();
  await expect(page.locator(".widget-chart-bar").first()).toBeVisible();
}

async function undoControlRemoval(page) {
  const panel = page.locator("#manual-elements-panel");
  await panel.getByLabel("Element", { exact: true }).selectOption("scale");
  await panel.getByLabel("Title (optional)").fill("Distance scale");
  await panel.getByRole("button", { name: "Add element", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Remove Distance scale" })).toBeVisible();
  await panel.getByRole("button", { name: "Remove Distance scale" }).click();
  await expect(panel.getByRole("button", { name: "Remove Distance scale" })).toHaveCount(0);
  await page.getByTestId("history-undo").click();
  await expect(page.getByTestId("history-status")).toHaveText("Undone");
  await expect(panel.getByRole("button", { name: "Remove Distance scale" })).toBeVisible();
}

async function reopenMap(page) {
  const before = await page.evaluate(() => structuredClone(window.__honuaStudioApp.composition.state));
  const after = await page.evaluate(async () => {
    const app = window.__honuaStudioApp;
    const version = await app.saveEditorVersion();
    await app.reopenEditorVersion(version.versionId);
    return structuredClone(app.composition.state);
  });
  expect(after.widgets).toEqual(before.widgets);
  expect(after.controls).toEqual(before.controls);
  await expect(page.getByTestId("studio-widget-chart")).toBeVisible();
}
