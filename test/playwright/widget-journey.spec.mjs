/**
 * honua-studio#24's acceptance criteria in a real browser, against the real
 * MapLibre renderer honua-studio#23 put on the canvas:
 *
 *  - each bounded widget kind renders and updates from composition state
 *    (REQ-001),
 *  - a TOC reflects layers added before *and after* it, with no authored
 *    bindings (REQ-002),
 *  - a TOC toggle moves the actual map — the intrinsic control is wired to
 *    the renderer, not just to a checkbox (REQ-003),
 *  - a chart renders from an agent-authored widget with no hand-written
 *    Vega-Lite spec (REQ-004),
 *  - a grid row selection travels the normal interaction path (REQ-005).
 *
 * REQ-003 is the one that genuinely needs a browser. A node test can prove a
 * checkbox writes a `setVisibility` command; only this can prove the composed
 * MapLibre style actually flipped to `visibility: none` as a result — which is
 * the difference between a working layer list and a decorative one.
 *
 * The chat side stays on `FixtureChatTransport` (AD-4's no-model fixture
 * mode), same as `map-canvas-journey.spec.mjs`, and honua-studio#23's
 * no-off-origin-requests rule is re-asserted here because the widget deck
 * fetches feature rows of its own.
 */
import { expect, test } from "@playwright/test";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { startPreviewServer } from "./helpers.mjs";

/** Live MapLibre layout state for one composed layer — the ground truth a TOC toggle has to move. */
const readLayerVisibility = (layerId) => {
  const map = document.querySelector("honua-studio-canvas")?.mapView?.map;
  const layer = (map?.getStyle?.()?.layers ?? []).find((entry) => entry.id === layerId);
  return { present: Boolean(layer), visibility: layer?.layout?.visibility ?? "visible" };
};

const mapStatus = () => document.querySelector("honua-studio-canvas")?.mapView?.status;

/** Applies a composition command through the same reducer every tool call uses. */
const applyCommand = (command) => window.__honuaStudioApp.composition.apply(command);

async function signIn(page) {
  const token = mintFixtureAccessToken();
  await page.evaluate((accessToken) => {
    window.__honuaStudioApp.session = { getToken: async () => accessToken, onExpired: () => () => {} };
  }, token);
}

async function bootComposedStudio(page, preview) {
  await page.addInitScript((conversationId) => {
    window.__honuaStudioChatFixtureConversationId = conversationId;
  }, "compose-districts-map");
  await page.goto(preview.url);
  await signIn(page);
  await expect.poll(() => page.evaluate(mapStatus), { timeout: 20_000 }).toBe("ready");
}

test.describe("the agent composes chrome around the map (honua-studio#24)", () => {
  test("a streamed conversation renders a chart, and a layer list tracks layers added after it", async ({ page }) => {
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

      await bootComposedStudio(page, preview);

      // Nothing composed yet: the deck takes no space at all rather than
      // leaving an empty box under the map.
      await expect(page.getByTestId("studio-canvas-widget-deck")).toBeHidden();

      // Two streamed turns from the fixture: a layer, then a chart of it.
      await page.evaluate(() =>
        window.__honuaStudioChat.sendMessage("Add the Hawai'i statewide parcels layer and style it by district."),
      );
      await expect
        .poll(
          () =>
            page.evaluate(
              () => document.querySelector("honua-studio-canvas")?.mapView?.projection?.renderedLayerIds ?? [],
            ),
          {
            timeout: 20_000,
          },
        )
        .toEqual(["hi-parcels"]);

      await page.evaluate(() =>
        window.__honuaStudioChat.sendMessage("Now add a chart showing the count of parcels by zoning code."),
      );

      // REQ-004: the agent authored `{ datasetId, groupBy, chartType }`; a
      // real chart came out, with no Vega-Lite spec anywhere in the fixture.
      const chart = page.getByTestId("studio-widget-chart");
      await expect(chart).toBeVisible({ timeout: 20_000 });
      await expect(chart).toHaveAttribute("data-mark", "bar");
      // Four zoning codes in the fixture parcels, so four bars.
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document
                .querySelector("honua-studio-canvas")
                ?.shadowRoot?.querySelector("honua-studio-widget-deck")
                ?.shadowRoot?.querySelectorAll("rect.widget-chart-bar").length ?? 0,
            { timeout: 20_000 },
          ),
        )
        .toBe(4);
      await expect(page.getByTestId("studio-widget-chart-summary")).toContainText("4 categories");

      // REQ-002: a TOC added NOW must still pick up the layer added earlier…
      await page.evaluate(applyCommand, { name: "addWidget", widget: { id: "layers", kind: "toc", title: "Layers" } });
      await expect(page.getByTestId("studio-widget-toc-row")).toHaveCount(1);
      await expect(page.getByTestId("studio-widget-toc")).toContainText("hi-parcels");

      // …and any layer added LATER, with nothing re-authored in between.
      await page.evaluate(applyCommand, {
        name: "addLayer",
        layer: { id: "hi-wells", sourceId: "hi-wells", title: "Monitoring wells" },
      });
      await expect(page.getByTestId("studio-widget-toc-row")).toHaveCount(2);
      await expect(page.getByTestId("studio-widget-toc")).toContainText("Monitoring wells");

      // REQ-003: the intrinsic toggle moves the REAL map, not just the model.
      expect(await page.evaluate(readLayerVisibility, "hi-parcels")).toEqual({ present: true, visibility: "visible" });
      await page.getByTestId("studio-widget-toc-toggle").first().uncheck();
      await expect
        .poll(() => page.evaluate(readLayerVisibility, "hi-parcels"), { timeout: 20_000 })
        .toEqual({ present: true, visibility: "none" });
      // Hidden, not removed — the layer is still composed, still listed, and
      // re-showing it is a layout flip rather than a source reload.
      await expect(page.getByTestId("studio-canvas-layers")).toContainText("hi-parcels");

      await page.getByTestId("studio-widget-toc-toggle").first().check();
      await expect
        .poll(() => page.evaluate(readLayerVisibility, "hi-parcels"), { timeout: 20_000 })
        .toEqual({ present: true, visibility: "visible" });

      // REQ-003's other half: a legend added with no config keys the layers
      // the map is drawing, in the colours it draws them.
      await page.evaluate(applyCommand, { name: "addWidget", widget: { id: "key", kind: "legend", title: "Legend" } });
      await expect(page.getByTestId("studio-widget-legend-item")).toHaveCount(2);

      // REQ-003 again: a pinned layer's toggle is disabled rather than allowed
      // to fail against the reducer's pin enforcement.
      await page.evaluate(applyCommand, { name: "pin", target: { kind: "layer", id: "hi-wells" } });
      await expect(page.getByTestId("studio-widget-toc-toggle").nth(1)).toBeDisabled();

      // REQ-003: nothing left the preview origin — the deck's own feature
      // requests included.
      expect(offOriginRequests).toEqual([]);
    } finally {
      await preview.close();
      await mock.close();
    }
  });

  test("a data grid lists real features, and a row select drives the interaction vocabulary", async ({ page }) => {
    const mock = await startMockServer();
    const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
    try {
      await bootComposedStudio(page, preview);
      await page.evaluate(applyCommand, {
        name: "addWidget",
        widget: {
          id: "grid",
          kind: "table",
          sourceId: "hi-parcels",
          title: "Parcels",
          config: { fields: ["parcel_id", "district", "zoning_code"], pageSize: 10 },
        },
      });

      // Rows come from the same bounded OGC Features route the map draws from.
      await expect(page.getByTestId("studio-widget-grid-row")).toHaveCount(10, { timeout: 20_000 });
      await expect(page.getByTestId("studio-widget-grid")).toContainText("TMK-0001");
      await expect(page.getByTestId("studio-widget-grid-range")).toHaveText("1–10 of 48");

      await page.getByTestId("studio-widget-grid-next").click();
      await expect(page.getByTestId("studio-widget-grid-range")).toHaveText("11–20 of 48");

      // REQ-005: a row select is a `selectFeature` through the normal path —
      // the same `honua-studio-selection-change` event a map click emits, from
      // the same dispatcher (the canvas), landing in the same
      // `controller.selection`.
      await page.evaluate(() => {
        window.__honuaWidgetSelections = [];
        document.addEventListener("honua-studio-selection-change", (event) => {
          window.__honuaWidgetSelections.push(event.detail.targets);
        });
      });
      await page.getByTestId("studio-widget-grid-row").first().click();

      expect(await page.evaluate(() => window.__honuaWidgetSelections)).toEqual([
        [{ kind: "feature", sourceId: "hi-parcels", featureId: 11 }],
      ]);
      expect(await page.evaluate(() => window.__honuaStudioApp.composition.selection)).toEqual([
        { kind: "feature", sourceId: "hi-parcels", featureId: 11 },
      ]);
      await expect(page.getByTestId("studio-widget-grid-row").first()).toHaveAttribute("aria-selected", "true");
    } finally {
      await preview.close();
      await mock.close();
    }
  });

  test("compare and time widgets step layer visibility on the real map", async ({ page }) => {
    const mock = await startMockServer();
    const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
    try {
      await bootComposedStudio(page, preview);
      for (const layer of [
        { id: "hi-parcels", sourceId: "hi-parcels", title: "Parcels" },
        { id: "hi-wells", sourceId: "hi-wells", title: "Wells" },
      ]) {
        await page.evaluate(applyCommand, { name: "addLayer", layer });
      }
      await page.evaluate(applyCommand, {
        name: "addWidget",
        widget: { id: "cmp", kind: "compare", title: "Compare", config: { left: "hi-parcels", right: "hi-wells" } },
      });

      await expect(page.getByTestId("studio-widget-compare")).toHaveAttribute("data-mode", "both");
      await page.getByTestId("studio-widget-compare-option").first().click();
      await expect
        .poll(() => page.evaluate(readLayerVisibility, "hi-wells"), { timeout: 20_000 })
        .toEqual({ present: true, visibility: "none" });
      await expect
        .poll(() => page.evaluate(readLayerVisibility, "hi-parcels"), { timeout: 20_000 })
        .toEqual({ present: true, visibility: "visible" });

      // A time stepper over the same two layers: one step visible at a time.
      await page.evaluate(applyCommand, {
        name: "addWidget",
        widget: {
          id: "time",
          kind: "time",
          title: "Time",
          config: {
            steps: [
              { label: "2019", layerId: "hi-parcels" },
              { label: "2020", layerId: "hi-wells" },
            ],
          },
        },
      });
      await expect(page.getByTestId("studio-widget-time-label")).toHaveText("2019");
      await page.getByTestId("studio-widget-time-slider").fill("1");
      await expect(page.getByTestId("studio-widget-time-label")).toHaveText("2020");
      await expect
        .poll(() => page.evaluate(readLayerVisibility, "hi-wells"), { timeout: 20_000 })
        .toEqual({ present: true, visibility: "visible" });
      await expect
        .poll(() => page.evaluate(readLayerVisibility, "hi-parcels"), { timeout: 20_000 })
        .toEqual({ present: true, visibility: "none" });
    } finally {
      await preview.close();
      await mock.close();
    }
  });
});
