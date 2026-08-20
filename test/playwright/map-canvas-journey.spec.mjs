/**
 * honua-studio#23's acceptance criteria, in a real browser with a real
 * MapLibre GL renderer:
 *
 *  - streaming tool calls visibly mutate a real map (REQ-001),
 *  - fixture mode remains deterministic and the default (REQ-005),
 *  - live composition is reachable from the UI (REQ-004),
 *  - no runtime CDN fetches (REQ-003).
 *
 * The last one is asserted the only way it can be asserted honestly: by
 * recording **every** request the page makes and failing on any that leaves
 * the preview origin. A test that merely checked for a hard-coded CDN
 * hostname would pass the day someone added a different one.
 *
 * The chat side stays on `FixtureChatTransport` (AD-4's no-model
 * fixture-conversation mode, same as `chat-fixture-journey.spec.mjs`) — the
 * subject here is the map surface the tool calls land on.
 */
import { expect, test } from "@playwright/test";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { startPreviewServer } from "./helpers.mjs";

/** Reads live MapLibre state out of the page through the canvas element's public `.mapView`. */
const readMapState = () => {
  const canvas = document.querySelector("honua-studio-canvas");
  const view = canvas?.mapView;
  const map = view?.map;
  return {
    status: view?.status,
    renderedLayerIds: [...(view?.projection?.renderedLayerIds ?? [])],
    unresolved: (view?.projection?.unresolved ?? []).map((entry) => entry.layerId),
    styleLayerIds: (map?.getStyle?.()?.layers ?? []).map((layer) => layer.id),
    styleSourceIds: Object.keys(map?.getStyle?.()?.sources ?? {}),
    center: map?.getCenter?.() ? [map.getCenter().lng, map.getCenter().lat] : undefined,
    zoom: map?.getZoom?.(),
  };
};

/**
 * Studio is a signed-in application (#1 REQ-009) and the catalog the map
 * resolves sources against is bearer-gated, so every journey here starts by
 * assigning a session — the same `SessionAdapter` shape
 * `mcp-compose-journey.spec.mjs` uses. Without it the composition would still
 * be correct and the readout would still list the layer, but the map would
 * (correctly) report the source as unresolvable.
 */
async function signIn(page) {
  const token = mintFixtureAccessToken();
  await expect.poll(() => page.evaluate(() => Boolean(window.__honuaStudioApp))).toBe(true);
  await page.evaluate((accessToken) => {
    window.__honuaStudioApp.session = { getToken: async () => accessToken, onExpired: () => () => {} };
  }, token);
}

test.describe("the composition map mutates as tool calls stream (standalone shell)", () => {
  test("a fixture conversation adds a real MapLibre layer, renders its features, and never leaves the origin", async ({
    page,
  }) => {
    const mock = await startMockServer();
    const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
    const previewOrigin = new URL(preview.url).origin;
    /** @type {string[]} */
    const offOriginRequests = [];
    try {
      page.on("request", (request) => {
        const url = request.url();
        if (url.startsWith("data:") || url.startsWith("blob:")) return;
        if (new URL(url).origin !== previewOrigin) offOriginRequests.push(url);
      });

      await page.addInitScript((conversationId) => {
        window.__honuaStudioChatFixtureConversationId = conversationId;
      }, "compose-districts-map");
      await page.goto(preview.url);
      await signIn(page);

      // The canvas boots straight into the map surface — the readout is no
      // longer the primary view (REQ-001).
      await expect(page.getByTestId("studio-canvas-map")).toBeVisible();
      await expect(page.getByTestId("studio-canvas-mode-map")).toHaveAttribute("aria-pressed", "true");
      await expect
        .poll(() => page.evaluate(readMapState).then((state) => state.status), { timeout: 20_000 })
        .toBe("ready");

      // The vendored basemap is what is on screen before any tool call, and
      // it is genuinely rendering (a real WebGL canvas, not a placeholder).
      const initial = await page.evaluate(readMapState);
      expect(initial.styleLayerIds).toContain("honua-basemap-land");
      expect(initial.renderedLayerIds).toEqual([]);
      await expect(page.locator("honua-studio-canvas")).toBeVisible();
      expect(
        await page.evaluate(
          () => !!document.querySelector("honua-studio-canvas")?.shadowRoot?.querySelector("canvas.maplibregl-canvas"),
        ),
      ).toBe(true);

      // One streamed tool call. The map — not just the readout — changes.
      await page.evaluate(() =>
        window.__honuaStudioChat.sendMessage("Add the Hawai'i statewide parcels layer and style it by district."),
      );
      await expect(page.getByTestId("studio-chat-tool-call")).toContainText("add_layer");
      await expect
        .poll(() => page.evaluate(readMapState).then((state) => state.renderedLayerIds), { timeout: 20_000 })
        .toEqual(["hi-parcels"]);

      // `renderedLayerIds` is what Studio *asked* for; the live style is what
      // MapLibre actually holds. Polled separately because applying a style
      // diff is asynchronous inside the renderer — asserting it in the same
      // tick as the projection would be testing our own bookkeeping twice.
      await expect
        .poll(() => page.evaluate(readMapState).then((state) => state.styleLayerIds), { timeout: 20_000 })
        .toContain("hi-parcels");
      const afterAdd = await page.evaluate(readMapState);
      expect(afterAdd.styleSourceIds).toContain("hi-parcels");
      expect(afterAdd.unresolved).toEqual([]);

      // Features actually painted — the source resolved to the fixture's OGC
      // Features route and MapLibre drew what came back. The camera starts at
      // the whole world, where 300 m parcels are sub-pixel, so frame Oʻahu
      // first: a `setView` through the same composition reducer any "zoom to
      // the parcels" utterance would use.
      await page.evaluate(() => {
        document.querySelector("honua-studio-canvas").viewTransitionMs = 0;
        window.__honuaStudioApp.composition.apply({
          name: "setView",
          view: { bbox: [-158.3, 21.2, -157.6, 21.8] },
        });
      });
      await expect
        .poll(
          () =>
            page.evaluate(async () => {
              const map = document.querySelector("honua-studio-canvas")?.mapView?.map;
              if (!map) return 0;
              if (!map.isStyleLoaded() || !map.areTilesLoaded()) {
                await new Promise((resolve) => map.once("idle", resolve));
              }
              return map.queryRenderedFeatures({ layers: ["hi-parcels"] }).length;
            }),
          { timeout: 20_000 },
        )
        .toBeGreaterThan(0);

      // REQ-001 keeps the readout: it is still the accessible description of
      // the map, and it still lists what the composition holds.
      await expect(page.getByTestId("studio-canvas-readout")).toBeVisible();
      await expect(page.getByTestId("studio-canvas-layers")).toContainText("hi-parcels");

      // Second turn: a widget the map cannot show still lands in the readout.
      await page.evaluate(() =>
        window.__honuaStudioChat.sendMessage("Now add a chart showing the count of parcels by zoning code."),
      );
      await expect(page.getByTestId("studio-canvas-widgets")).toContainText("chart-hi-parcels-zoning_code");

      // REQ-003: nothing left the preview origin — no tiles, no sprites, no
      // glyphs, no CDN script.
      expect(offOriginRequests).toEqual([]);
    } finally {
      await preview.close();
      await mock.close();
    }
  });

  test("the view command flies the real camera", async ({ page }) => {
    const mock = await startMockServer();
    const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
    try {
      await page.goto(preview.url);
      await signIn(page);
      await expect
        .poll(() => page.evaluate(readMapState).then((state) => state.status), { timeout: 20_000 })
        .toBe("ready");

      await page.evaluate(() => {
        document.querySelector("honua-studio-canvas").viewTransitionMs = 0;
        window.__honuaStudioApp.composition.apply({
          name: "setView",
          view: { center: [-157.85, 21.31], zoom: 11 },
        });
      });

      await expect
        .poll(() => page.evaluate(readMapState).then((state) => Math.round(state.zoom ?? 0)), { timeout: 20_000 })
        .toBe(11);
      const state = await page.evaluate(readMapState);
      expect(state.center?.[0]).toBeCloseTo(-157.85, 1);
      expect(state.center?.[1]).toBeCloseTo(21.31, 1);
    } finally {
      await preview.close();
      await mock.close();
    }
  });

  test("switching to Details keeps the map alive and shows the readout full-panel", async ({ page }) => {
    const mock = await startMockServer();
    const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
    try {
      await page.goto(preview.url);
      await signIn(page);
      await expect
        .poll(() => page.evaluate(readMapState).then((state) => state.status), { timeout: 20_000 })
        .toBe("ready");

      await page.getByTestId("studio-canvas-mode-details").click();
      await expect(page.getByTestId("studio-canvas-map")).toBeHidden();
      await expect(page.getByTestId("studio-canvas-readout")).toBeVisible();
      expect(await page.evaluate(readMapState).then((state) => state.status)).toBe("ready");

      await page.getByTestId("studio-canvas-mode-map").click();
      await expect(page.getByTestId("studio-canvas-map")).toBeVisible();
    } finally {
      await preview.close();
      await mock.close();
    }
  });

  test("live composition is reachable from the UI, and fixture mode is what the app boots in", async ({ page }) => {
    const mock = await startMockServer();
    const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
    try {
      await page.goto(preview.url);

      // REQ-005: fixture/offline is the default, and it says so.
      await expect(page.getByTestId("live-composition-status")).toHaveText("Fixture mode");
      await expect(page.getByTestId("live-composition-form")).toBeHidden();

      // REQ-004: no window.__honuaStudioApp anywhere in this flow.
      await page.getByTestId("live-composition-toggle").click();
      await expect(page.getByTestId("live-composition-form")).toBeVisible();
      await page.getByTestId("live-composition-package-key").fill("pkg-ui-live");
      await page.getByTestId("live-composition-family").selectOption("map");
      await page.getByTestId("live-composition-submit").click();

      await expect(page.getByTestId("live-composition-status")).toContainText("pkg-ui-live");
      await expect(page.getByTestId("live-composition-toggle")).toHaveText("Return to fixture");
      expect(await page.evaluate(() => window.__honuaStudioApp.toolCallOrchestrator.isLive)).toBe(true);

      await page.getByTestId("live-composition-toggle").click();
      await expect(page.getByTestId("live-composition-status")).toHaveText("Fixture mode");
      expect(await page.evaluate(() => window.__honuaStudioApp.toolCallOrchestrator.isLive)).toBe(false);
    } finally {
      await preview.close();
      await mock.close();
    }
  });
});
