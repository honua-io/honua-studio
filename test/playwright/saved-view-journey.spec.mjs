import { expect, test } from "@playwright/test";
import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { startPreviewServer, waitForSignedInMap, waitForStudioApp } from "./helpers.mjs";

async function camera(page) {
  return page.evaluate(() => {
    const map = document.querySelector("honua-studio-canvas").mapView.map;
    return { center: map.getCenter().toArray(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
  });
}

async function boot(page, preview, transitionMs = 0) {
  await page.goto(preview.url);
  await waitForStudioApp(page);
  await page.evaluate(
    ({ token, transitionMs }) => {
      window.__honuaStudioApp.session = { getToken: async () => token, onExpired: () => () => {} };
      document.querySelector("honua-studio-canvas").viewTransitionMs = transitionMs;
    },
    { token: mintFixtureAccessToken(), transitionMs },
  );
  await waitForSignedInMap(page);
}

async function panCamera(page) {
  const mapCanvas = page.getByTestId("studio-canvas-map");
  await mapCanvas.scrollIntoViewIfNeeded();
  const bounds = await mapCanvas.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 70, bounds.y + bounds.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => document.querySelector("honua-studio-canvas").mapView.map.isMoving()))
    .toBe(false);
  const expected = await camera(page);
  expect(expected.center[0]).not.toBe(-157.85);
  return expected;
}

function expectCamera(actual, expected) {
  expect(actual.center[0]).toBeCloseTo(expected.center[0], 5);
  expect(actual.center[1]).toBeCloseTo(expected.center[1], 5);
  expect(actual.zoom).toBeCloseTo(expected.zoom, 5);
  expect(actual.pitch).toBeCloseTo(expected.pitch, 5);
  expect((actual.bearing + 360) % 360).toBeCloseTo((expected.bearing + 360) % 360, 5);
}

for (const initialView of [{}, { bbox: [-158.3, 21.2, -157.6, 21.8] }]) {
  test(`save and reopen the navigated camera from ${initialView.bbox ? "bbox" : "world"} view`, async ({ page }) => {
    const mock = await startMockServer();
    const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url }, ["--port", "4295"]);
    try {
      await boot(page, preview);
      await page.evaluate(async (view) => {
        await window.__honuaStudioApp.createWorkspaceDraft("saved-camera");
        await document.querySelector("honua-studio-canvas").commandDispatch([{ name: "setView", view }]);
      }, initialView);
      await page.evaluate(() => {
        document.querySelector("honua-studio-canvas").mapView.map.jumpTo({
          center: [-157.85, 21.31],
          zoom: 11,
          bearing: -35,
          pitch: 45,
        });
      });
      const expected = await panCamera(page);
      const savedView = await page.evaluate(async () => {
        const version = await window.__honuaStudioApp.saveWorkspaceVersion();
        window.__savedCameraVersion = version.versionId;
        return version.envelope.body.view;
      });
      expect(savedView.bbox).toBeUndefined();
      expectCamera(savedView, expected);
      await page.evaluate(async () => {
        document
          .querySelector("honua-studio-canvas")
          .mapView.map.jumpTo({ center: [0, 0], zoom: 1, bearing: 0, pitch: 0 });
        await window.__honuaStudioApp.reopenWorkspaceVersion(window.__savedCameraVersion);
      });
      await expect.poll(async () => (await camera(page)).center[0]).toBeCloseTo(expected.center[0], 5);
      expectCamera(await camera(page), expected);
    } finally {
      await preview.close();
      await mock.close();
    }
  });
}

test("saving immediately after an authored view retains its target", async ({ page }) => {
  const mock = await startMockServer();
  const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url }, ["--port", "4295"]);
  try {
    await boot(page, preview, 10000);
    const target = { center: [-122.4, 37.8], zoom: 12, bearing: 80, pitch: 40 };
    const savedView = await page.evaluate(async (view) => {
      const app = window.__honuaStudioApp;
      const canvas = document.querySelector("honua-studio-canvas");
      await app.createWorkspaceDraft("authored-camera");
      await canvas.commandDispatch([{ name: "setView", view }]);
      const version = await app.saveWorkspaceVersion();
      return version.envelope.body.view;
    }, target);
    expectCamera(savedView, target);
  } finally {
    await preview.close();
    await mock.close();
  }
});
