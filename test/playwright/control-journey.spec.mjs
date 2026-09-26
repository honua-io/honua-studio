/**
 * honua-studio#25's acceptance criteria in a real browser, against the real
 * MapLibre renderer honua-studio#23 put on the canvas:
 *
 *  - every upstream control kind renders or reports explicit unsupported
 *    (REQ-001),
 *  - a `control:{id}` + `change` binding dispatches through the compiler and
 *    **moves the map**, with no cascade (REQ-002),
 *  - standard chrome behaves without any authored binding (REQ-003).
 *
 * REQ-002 is the one that genuinely needs a browser. A node test can prove a
 * `<select>` publishes a `FilterClause` and that the runtime computes a
 * MapLibre expression from it; only this can prove the composed style the
 * renderer is actually holding carries that `filter` — the difference between
 * a working filter control and a decorative one.
 *
 * honua-studio#23's no-off-origin-requests rule is re-asserted here, because
 * a filter control derives its option domain by fetching features.
 */
import { expect, test } from "@playwright/test";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { startPreviewServer } from "./helpers.mjs";

/**
 * A fixed, non-default preview port. Several agents run Playwright against
 * this repo concurrently and vite's default 4173 collides; this spec claims
 * one of its own.
 */
const PREVIEW_PORT = "4287";

/** The live MapLibre filter on a composed layer — the ground truth a control has to move. */
const readLayerFilter = (layerId) => {
  const map = document.querySelector("honua-studio-canvas")?.mapView?.map;
  const layer = (map?.getStyle?.()?.layers ?? []).find((entry) => entry.id === layerId);
  return layer?.filter ?? null;
};

const readLayerPaint = ({ layerId, property }) => {
  const map = document.querySelector("honua-studio-canvas")?.mapView?.map;
  const layer = (map?.getStyle?.()?.layers ?? []).find((entry) => entry.id === layerId);
  return layer?.paint?.[property] ?? null;
};

const mapStatus = () => document.querySelector("honua-studio-canvas")?.mapView?.status;

const applyCommand = (command) => window.__honuaStudioApp.composition.apply(command);

const controlBar = () =>
  document.querySelector("honua-studio-canvas")?.shadowRoot?.querySelector("honua-studio-control-bar");

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

test.describe("the agent composes controls around the map (honua-studio#25)", () => {
  test("controls render, chrome works intrinsically, and a change binding filters the map", async ({ page }) => {
    const mock = await startMockServer();
    const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url }, ["--port", PREVIEW_PORT]);
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

      // Nothing composed yet: the bar takes no space rather than leaving an
      // empty strip above the map.
      await expect(page.getByTestId("studio-canvas-control-bar")).toBeHidden();

      // One streamed turn from the fixture puts a real layer on the map.
      await page.evaluate(() =>
        window.__honuaStudioChat.sendMessage("Add the Hawai'i statewide parcels layer and style it by district."),
      );
      await expect
        .poll(
          () =>
            page.evaluate(
              () => document.querySelector("honua-studio-canvas")?.mapView?.projection?.renderedLayerIds ?? [],
            ),
          { timeout: 20_000 },
        )
        .toEqual(["hi-parcels"]);

      // ---- REQ-001: every kind renders or reports ---------------------------
      await page.evaluate(
        (kinds) => {
          for (const kind of kinds) {
            window.__honuaStudioApp.composition.apply({ name: "addControl", control: { id: kind, kind } });
          }
        },
        [
          "navigation",
          "scale",
          "fullscreen",
          "geolocate",
          "search",
          "measure",
          "bookmarks",
          "attribution",
          "basemapSwitcher",
        ],
      );

      await expect(page.getByTestId("studio-control")).toHaveCount(9);
      // Each card either drew a body or stated a reason — never neither.
      const accounted = await page.evaluate(() => {
        const cards = [...(controlBarCards() ?? [])];
        return cards.every(
          (card) =>
            card.querySelector(".control-body") !== null ||
            card.textContent.includes("cannot be rendered") ||
            card.querySelector("[data-testid='studio-control-unsupported']") !== null,
        );
        function controlBarCards() {
          return document
            .querySelector("honua-studio-canvas")
            ?.shadowRoot?.querySelector("honua-studio-control-bar")
            ?.shadowRoot?.querySelectorAll("[data-testid='studio-control']");
        }
      });
      expect(accounted).toBe(true);
      // `search` is the one kind with no provider vocabulary upstream.
      await expect(page.getByTestId("studio-control-unsupported").first()).toContainText("no search provider");

      // ---- REQ-003: intrinsic chrome, with nothing authored -----------------
      const zoomBefore = await page.evaluate(() =>
        document.querySelector("honua-studio-canvas")?.mapView?.map?.getZoom(),
      );
      await page.getByTestId("studio-control-zoom-in").click();
      await expect
        .poll(() => page.evaluate(() => document.querySelector("honua-studio-canvas")?.mapView?.map?.getZoom()))
        .toBeGreaterThan(zoomBefore);

      // A scale bar reads the live camera and labels a round distance.
      await expect(page.getByTestId("studio-control-scale-label")).toContainText(/\d/);

      // The basemap switcher swaps the vendored offline palette — no CDN.
      await page.getByTestId("studio-control-basemap-option").nth(1).click();
      await expect
        .poll(() =>
          page.evaluate(() => {
            const layers = document.querySelector("honua-studio-canvas")?.mapView?.map?.getStyle?.()?.layers ?? [];
            return layers.find((layer) => layer.id === "honua-basemap-water")?.paint?.["background-color"] ?? null;
          }),
        )
        .toBe("#0b161d");

      // ---- REQ-002: a change binding moves the map --------------------------
      await page.evaluate(applyCommand, {
        name: "addControl",
        control: {
          id: "zoning",
          kind: "filterSelect",
          title: "Zoning",
          sourceId: "hi-parcels",
          config: { field: "zoning_code", options: ["R-5", "B-2"] },
        },
      });
      await page.evaluate(applyCommand, {
        name: "bindInteraction",
        interaction: {
          id: "zoning-filters-parcels",
          on: { ref: "control:zoning", event: "change" },
          do: { ref: "layer:hi-parcels", verb: "setFilter", args: { field: "zoning_code", value: "$event.value" } },
        },
      });

      await expect(page.getByTestId("studio-control-filter-select")).toBeVisible();
      await page.getByTestId("studio-control-filter-select").selectOption("R-5");

      // The MAP's own style now carries the filter — not just the runtime.
      await expect
        .poll(() => page.evaluate(readLayerFilter, "hi-parcels"), { timeout: 10_000 })
        .toEqual(["==", ["get", "zoning_code"], "R-5"]);

      // No cascade: the one binding compiled, and nothing else did. A verb's
      // own write is invisible to the compiler that made it, so a cascade
      // would have shown up above as a filter the control never asked for.
      const compiled = await page.evaluate(() => {
        const result = document.querySelector("honua-studio-canvas")?.interactions?.compiled;
        return { ok: result?.ok ?? null, pairs: (result?.bindings ?? []).map((entry) => entry.pair) };
      });
      expect(compiled).toEqual({ ok: true, pairs: ["change -> setFilter"] });

      // Clearing the control clears the map filter.
      await page.getByTestId("studio-control-filter-select").selectOption("");
      await expect.poll(() => page.evaluate(readLayerFilter, "hi-parcels")).toBeNull();

      // ---- opacity: same transport, paint rather than filter ----------------
      await page.evaluate(applyCommand, {
        name: "addControl",
        control: { id: "fade", kind: "opacity", title: "Fade", sourceId: "hi-parcels" },
      });
      // `fill()` does not drive a range input; set the value and raise the
      // same `input` event a drag would.
      await page.getByTestId("studio-control-opacity").evaluate((slider) => {
        slider.value = "0.4";
        slider.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      });
      await expect
        .poll(() => page.evaluate(readLayerPaint, { layerId: "hi-parcels", property: "fill-opacity" }), {
          timeout: 10_000,
        })
        .toBeCloseTo(0.18, 2);

      // ---- the readout lists controls too -----------------------------------
      await expect(page.getByTestId("studio-canvas-controls")).toContainText("Zoning");
      await expect(page.getByTestId("studio-canvas-controls")).toContainText("filterSelect");

      expect(offOriginRequests, "the composed controls must not reach off-origin").toEqual([]);
    } finally {
      await preview.close();
      await mock.close();
    }
  });

  test("removing a bound control is refused until the binding goes with it", async ({ page }) => {
    const mock = await startMockServer();
    const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url }, ["--port", PREVIEW_PORT]);
    try {
      await bootComposedStudio(page, preview);
      await page.evaluate(applyCommand, {
        name: "addControl",
        control: { id: "zoning", kind: "filterSelect", config: { field: "zoning_code", options: ["R-5"] } },
      });
      await page.evaluate(applyCommand, {
        name: "bindInteraction",
        interaction: {
          id: "b",
          on: { ref: "control:zoning", event: "change" },
          do: { ref: "map", verb: "setViewport", args: { view: { zoom: 8 } } },
        },
      });

      const refusal = await page.evaluate(() => {
        try {
          window.__honuaStudioApp.composition.apply({
            name: "removeControl",
            target: { kind: "control", id: "zoning" },
          });
          return null;
        } catch (error) {
          return { code: error.code, message: error.message };
        }
      });
      expect(refusal?.code).toBe("interaction-conflict");
      expect(refusal?.message).toContain("cascadeInteractions");

      const cascaded = await page.evaluate(() => {
        window.__honuaStudioApp.composition.apply({
          name: "removeControl",
          target: { kind: "control", id: "zoning" },
          cascadeInteractions: true,
        });
        const state = window.__honuaStudioApp.composition.state;
        return { controls: state.controls.length, interactions: state.interactions.length };
      });
      expect(cascaded).toEqual({ controls: 0, interactions: 0 });
      await expect(page.getByTestId("studio-canvas-control-bar")).toBeHidden();
    } finally {
      await preview.close();
      await mock.close();
    }
  });
});
