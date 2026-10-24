import { expect, test } from "@playwright/test";
import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { startPreviewServer } from "./helpers.mjs";

async function boot(page, preview) {
  await page.goto(preview.url);
  await page.evaluate((token) => {
    window.__honuaStudioApp.session = { getToken: async () => token, onExpired: () => () => {} };
  }, mintFixtureAccessToken());
  await expect
    .poll(() => page.evaluate(() => document.querySelector("honua-studio-canvas")?.mapView?.status), {
      timeout: 20_000,
    })
    .toBe("ready");
  await page.getByTestId("recipe-toggle").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("recipe-panel")).toBeVisible();
  await expect(page.getByLabel("Illustrative recipe preview")).toContainText("no user data");
  await expect(page.getByTestId("recipe-source").locator("option")).toHaveCount(5);
}

async function chooseParcels(page) {
  await page.getByTestId("recipe-package-key").fill("recipe-browser-exploration");
  await page.getByTestId("recipe-source").selectOption("hi-parcels/0");
  await expect(page.getByTestId("recipe-status")).toContainText("Verified");
  await page.getByTestId("recipe-category").selectOption("zoning_code");
  await page.getByTestId("recipe-columns").getByLabel("zoning_code", { exact: true }).check();
  await page.getByTestId("recipe-columns").getByLabel("district", { exact: true }).check();
}

test("Explore binds actual data, filters map/table, accepts ordinary visual/chat edits and saves/reopens", async ({
  page,
}) => {
  const mock = await startMockServer();
  const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url }, ["--port", "4291"]);
  const creates = [];
  const publications = [];
  const sourceWrites = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/v1\/studio\/package-drafts$/.test(request.url())) creates.push(request);
    if (/publish-requests|propose_publication/.test(request.url())) publications.push(request);
    if (/FeatureServer.*(?:applyEdits|addFeatures|updateFeatures|deleteFeatures)/.test(request.url()))
      sourceWrites.push(request);
  });
  try {
    await boot(page, preview);
    expect(creates).toHaveLength(0);
    await chooseParcels(page);
    await page.getByTestId("recipe-create").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("recipe-status")).toContainText("Created draft");
    expect(creates).toHaveLength(1);
    await page.getByTestId("recipe-close").click();
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelector("honua-studio-canvas")?.mapView?.projection?.renderedLayerIds),
      )
      .toEqual(["explore-layer"]);
    const rows = page.getByTestId("studio-widget-grid-row");
    await expect(rows).toHaveCount(25);
    const filter = page.getByTestId("studio-control-filter-select");
    await filter.selectOption("R-5");
    await expect(rows).toHaveCount(12);
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelector("honua-studio-canvas")?.mapView?.map?.getFilter("explore-layer")),
      )
      .toEqual(["==", ["get", "zoning_code"], "R-5"]);
    await filter.selectOption("");
    await expect(rows).toHaveCount(25);

    // Deterministic no-model chat transport; the normal chat event writes the SAME REST draft.
    await page.evaluate(() => {
      window.__honuaStudioChat.transport = {
        async *streamChat() {
          yield { type: "messageStart", model: "fixture-recipe-refinement" };
          yield { type: "toolCallStart", toolCallId: "add-toc", toolName: "addWidget" };
          yield {
            type: "toolCallStop",
            toolCallId: "add-toc",
            toolArguments: { widget: { id: "author-toc", kind: "toc", title: "Author layer list" } },
          };
          yield { type: "messageStop", stopReason: "endTurn", promptTokens: 0, completionTokens: 0, latencyMs: 0 };
        },
      };
    });
    await page.getByTestId("studio-chat-input").fill("Add a layer list while retaining my table and category filter.");
    await page.getByTestId("studio-chat-send").click();
    await expect(page.getByTestId("studio-widget-toc-toggle")).toBeVisible();
    await page.getByTestId("studio-widget-toc-toggle").uncheck();
    await expect
      .poll(() => page.evaluate(() => window.__honuaStudioApp.composition.state.layers[0]?.visible))
      .toBe(false);
    await page.getByTestId("studio-widget-toc-toggle").check();
    await expect
      .poll(() => page.evaluate(() => window.__honuaStudioApp.composition.state.layers[0]?.visible))
      .toBe(true);
    await filter.selectOption("R-5");
    await expect(rows).toHaveCount(12);
    const before = await page.evaluate(() => structuredClone(window.__honuaStudioApp.composition.state));
    const restored = await page.evaluate(async () => {
      const app = window.__honuaStudioApp;
      const version = await app.saveWorkspaceVersion();
      window.__recipeVersion = version;
      await app.reopenWorkspaceVersion(version.versionId);
      return structuredClone(app.composition.state);
    });
    expect(restored.layers).toEqual(before.layers);
    expect(restored.widgets).toEqual(before.widgets);
    expect(restored.controls).toEqual(before.controls);
    expect(restored.interactions).toEqual(before.interactions);
    await expect(rows).toHaveCount(25);
    await page.getByTestId("studio-control-filter-select").selectOption("R-5");
    await expect(rows).toHaveCount(12);
    expect(publications).toHaveLength(0);
    expect(sourceWrites).toHaveLength(0);
    await page.screenshot({ path: ".tmp/explore-recipe-rendered.png", fullPage: true });
  } finally {
    await preview.close();
    await mock.close();
  }
});

test("lost create response retries the same accepted draft; denied metadata cannot create", async ({ page }) => {
  const mock = await startMockServer();
  const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url }, ["--port", "4292"]);
  let releaseLostResponse;
  const lostResponseGate = new Promise((resolve) => {
    releaseLostResponse = resolve;
  });
  try {
    await boot(page, preview);
    await page.route("**/mcp", async (route) => {
      const body = route.request().postDataJSON();
      if (body.method === "tools/call" && body.params?.name === "honua_describe_layer") {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ error: "Read access denied" }),
        });
      } else await route.continue();
    });
    await page.getByTestId("recipe-source").selectOption("hi-parcels/0");
    await expect(page.getByTestId("recipe-status")).toContainText("Cannot use this dataset");
    await expect(page.getByTestId("recipe-create")).toBeDisabled();
    await page.unroute("**/mcp");
    await page.getByTestId("recipe-source").selectOption("");
    await chooseParcels(page);
    let lost = false;
    const commands = [];
    await page.route("**/v1/studio/package-drafts", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      commands.push({ key: route.request().headers()["idempotency-key"], body: route.request().postDataJSON() });
      const response = await route.fetch();
      if (!lost) {
        lost = true;
        await lostResponseGate;
        await route.abort("connectionreset");
      } else await route.fulfill({ response });
    });
    await page.getByTestId("recipe-create").click();
    await expect.poll(() => lost).toBe(true);
    await expect(page.getByTestId("recipe-close")).toBeEnabled();
    await page.getByTestId("recipe-close").click();
    await expect(page.getByTestId("recipe-panel")).toBeHidden();
    releaseLostResponse();
    await expect(page.getByTestId("recipe-create")).toHaveText("Retry original submission");
    await page.getByTestId("recipe-toggle").click();
    await page.getByTestId("recipe-create").click();
    await expect(page.getByTestId("recipe-status")).toContainText("Created draft");
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(commands[1]);
    const count = await page.evaluate(async (token) => {
      const response = await fetch("/api/v1/studio/package-drafts?q=recipe-browser-exploration", {
        headers: { Authorization: `Bearer ${token}` },
      });
      return (await response.json()).data.items.length;
    }, mintFixtureAccessToken());
    expect(count).toBe(1);
    await page.screenshot({ path: ".tmp/explore-recipe-recovered.png", fullPage: true });
  } finally {
    releaseLostResponse();
    await preview.close();
    await mock.close();
  }
});
