import { describe, expect, it, vi } from "vitest";

import { CompositionController } from "../../src/composition/controller.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import type { CompositionTarget } from "../../src/composition/model.js";
import {
  type CompositionMapFactory,
  type CompositionMapLike,
  CompositionMapView,
  type CompositionMapViewOptions,
  compositionTargetsFromFeatures,
  ownedVisualLayerIds,
} from "../../src/map/composition-map-view.js";
import type { CompositionSourceDescriptor } from "../../src/map/source-resolution.js";
import { styleRefColorFor } from "../../src/map/style-presets.js";

const CATALOG: readonly CompositionSourceDescriptor[] = [
  { id: "hi-parcels", title: "Parcels", protocol: "ogc-features", geometryType: "Polygon" },
  { id: "hi-roads", title: "Roads", protocol: "geoservices-feature-service", geometryType: "LineString" },
  { id: "hi-imagery", title: "Imagery", protocol: "stac", geometryType: "Raster" },
];

interface StyleLike {
  layers: { id: string; paint?: Record<string, unknown>; layout?: Record<string, unknown> }[];
  sources: Record<string, unknown>;
}

/**
 * A fake `maplibre-gl` map. The injection seam exists precisely so the update
 * pipeline is testable in `environment: "node"` — no WebGL, no browser, and a
 * recorded call log instead of a screenshot.
 */
function createFakeMap() {
  const styles: StyleLike[] = [];
  const cameras: { method: string; options: unknown }[] = [];
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  let renderedFeatures: readonly unknown[] = [];
  let removed = false;

  const map: CompositionMapLike & {
    styles: StyleLike[];
    cameras: typeof cameras;
    emit(type: string, event: unknown): void;
    setRenderedFeatures(features: readonly unknown[]): void;
    readonly removed: boolean;
    readonly latestStyle: StyleLike | undefined;
  } = {
    styles,
    cameras,
    get removed() {
      return removed;
    },
    get latestStyle() {
      return styles[styles.length - 1];
    },
    setStyle(style) {
      styles.push(style as StyleLike);
      return undefined;
    },
    jumpTo(options) {
      cameras.push({ method: "jumpTo", options });
      return undefined;
    },
    easeTo(options) {
      cameras.push({ method: "easeTo", options });
      return undefined;
    },
    fitBounds(bounds, options) {
      cameras.push({ method: "fitBounds", options: { bounds, ...(options ?? {}) } });
      return undefined;
    },
    on(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      return undefined;
    },
    queryRenderedFeatures() {
      return renderedFeatures;
    },
    resize() {
      return undefined;
    },
    remove() {
      removed = true;
    },
    emit(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    setRenderedFeatures(features) {
      renderedFeatures = features;
    },
  };
  return map;
}

async function startView(overrides: Partial<CompositionMapViewOptions> = {}) {
  const controller = new CompositionController(createEmptyCompositionState());
  const map = createFakeMap();
  const factory: CompositionMapFactory = async (options) => {
    map.setStyle(options.style);
    return map;
  };
  const selections: CompositionTarget[][] = [];
  const view = new CompositionMapView({
    container: {} as HTMLElement,
    controller,
    mapFactory: factory,
    viewTransitionMs: 0,
    projection: { catalog: CATALOG },
    onSelection: (targets) => selections.push([...targets]),
    ...overrides,
  });
  await view.start();
  return { controller, map, view, selections };
}

describe("CompositionMapView (honua-studio#23)", () => {
  it("keeps canonical primary and outline ownership despite conflicting metadata", () => {
    expect([
      ...ownedVisualLayerIds(
        [
          { id: "hi-parcels__outline", metadata: { "honua:compositionLayerId": "hi-roads" } },
          { id: "hi-parcels", metadata: { "honua:compositionLayerId": "hi-roads" } },
          { id: "styled-road", metadata: { "honua:compositionLayerId": "hi-roads" } },
        ],
        ["hi-parcels", "hi-roads"],
      ),
    ]).toEqual([
      ["hi-parcels__outline", "hi-parcels"],
      ["hi-parcels", "hi-parcels"],
      ["styled-road", "hi-roads"],
    ]);
  });

  it("renders the vendored basemap before any composition command lands", async () => {
    const { view, map } = await startView();
    expect(view.status).toBe("ready");
    expect(map.latestStyle?.layers.some((layer) => layer.id === "honua-basemap-land")).toBe(true);
  });

  it("adds a real MapLibre layer and source when a tool call adds a composition layer", async () => {
    const { controller, map, view } = await startView();
    const stylesBefore = map.styles.length;

    controller.apply({ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels", title: "Parcels" } });
    await view.settled();

    expect(map.styles.length).toBeGreaterThan(stylesBefore);
    expect(map.latestStyle?.layers.map((layer) => layer.id)).toContain("hi-parcels");
    expect(map.latestStyle?.sources["hi-parcels"]).toBeDefined();
  });

  it("hands MapLibre a style with no present-but-undefined properties", async () => {
    // `{ layout: undefined }` and "no `layout` key" are the same to
    // `JSON.stringify` but not to MapLibre's validator, which rejects the
    // former and leaves the previous style in place — the map silently stops
    // updating while composition state stays correct. `composeStyle` prunes
    // them (sdk-js#1270); this is the assertion that catches it if it stops.
    const { controller, map, view } = await startView();
    controller.apply({ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } });
    controller.apply({ name: "addLayer", layer: { id: "hi-roads", sourceId: "hi-roads" } });
    await view.settled();

    const style = map.latestStyle as unknown as Record<string, unknown> | undefined;
    expect(style).toBeDefined();
    const undefinedKeys: string[] = [];
    for (const [key, value] of Object.entries(style ?? {})) if (value === undefined) undefinedKeys.push(key);
    for (const layer of map.latestStyle?.layers ?? []) {
      for (const [key, value] of Object.entries(layer as unknown as Record<string, unknown>)) {
        if (value === undefined) undefinedKeys.push(`${layer.id}.${key}`);
      }
    }
    expect(undefinedKeys).toEqual([]);
  });

  it("restyles the layer in place when setLayerStyleRef lands — the style ref is not a no-op", async () => {
    const { controller, map, view } = await startView();
    controller.apply({ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } });
    await view.settled();
    const before = map.latestStyle?.layers.find((layer) => layer.id === "hi-parcels")?.paint?.["fill-color"];

    controller.apply({
      name: "setLayerStyleRef",
      target: { kind: "layer", id: "hi-parcels" },
      styleRef: { kind: "style-ref", styleId: "cool" },
    });
    await view.settled();

    const after = map.latestStyle?.layers.find((layer) => layer.id === "hi-parcels")?.paint?.["fill-color"];
    expect(after).toBe(styleRefColorFor("cool"));
    expect(after).not.toBe(before);
  });

  it("removes the layer from the style when removeLayer lands", async () => {
    const { controller, map, view } = await startView();
    controller.apply({ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } });
    await view.settled();
    controller.apply({ name: "removeLayer", target: { kind: "layer", id: "hi-parcels" } });
    await view.settled();
    expect(map.latestStyle?.layers.map((layer) => layer.id)).not.toContain("hi-parcels");
  });

  it("moves the camera on setView, and prefers a bbox over centre/zoom", async () => {
    const { controller, map, view } = await startView();
    controller.apply({ name: "setView", view: { center: [-157.9, 21.4], zoom: 10 } });
    await view.settled();
    expect(map.cameras.at(-1)).toMatchObject({ method: "jumpTo", options: { center: [-157.9, 21.4], zoom: 10 } });

    controller.apply({ name: "setView", view: { bbox: [-158.3, 21.2, -157.6, 21.8] } });
    await view.settled();
    expect(map.cameras.at(-1)?.method).toBe("fitBounds");
  });

  it("eases (rather than jumps) when a transition duration is configured", async () => {
    const { controller, map, view } = await startView({ viewTransitionMs: 500 });
    controller.apply({ name: "setView", view: { zoom: 7 } });
    await view.settled();
    expect(map.cameras.at(-1)).toMatchObject({ method: "easeTo", options: { zoom: 7, duration: 500 } });
  });

  it("does not re-issue a camera move when the view did not change", async () => {
    const { controller, map, view } = await startView();
    controller.apply({ name: "setView", view: { zoom: 8 } });
    await view.settled();
    const cameraCount = map.cameras.length;
    controller.apply({ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } });
    await view.settled();
    expect(map.cameras).toHaveLength(cameraCount);
  });

  it("applies streamed commands in order and settles on the latest state", async () => {
    const { controller, map, view } = await startView();
    // Three commands in one tick — the failure mode this guards against is
    // the async style composition resolving out of order.
    controller.apply({ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } });
    controller.apply({ name: "addLayer", layer: { id: "hi-roads", sourceId: "hi-roads" } });
    controller.apply({ name: "setView", view: { zoom: 11 } });
    await view.settled();

    const ids = map.latestStyle?.layers.map((layer) => layer.id) ?? [];
    expect(ids).toContain("hi-parcels");
    expect(ids).toContain("hi-roads");
    expect(ids.indexOf("hi-parcels")).toBeLessThan(ids.indexOf("hi-roads"));
    expect(view.projection?.renderedLayerIds).toEqual(["hi-parcels", "hi-roads"]);
  });

  it("reports an unrenderable layer without dropping the rest of the map", async () => {
    const { controller, map, view } = await startView();
    controller.apply({ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } });
    controller.apply({ name: "addLayer", layer: { id: "hi-imagery", sourceId: "hi-imagery" } });
    await view.settled();
    expect(view.projection?.unresolved.map((entry) => entry.layerId)).toEqual(["hi-imagery"]);
    expect(map.latestStyle?.layers.map((layer) => layer.id)).toContain("hi-parcels");
  });

  it("turns a map click into a feature-first deictic selection", async () => {
    const { controller, map, view, selections } = await startView();
    controller.apply({ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } });
    await view.settled();

    map.setRenderedFeatures([{ id: 42, source: "hi-parcels", layer: { id: "hi-parcels" } }]);
    map.emit("click", { point: { x: 10, y: 10 } });

    expect(selections).toEqual([
      [
        { kind: "feature", sourceId: "hi-parcels", featureId: 42 },
        { kind: "layer", id: "hi-parcels" },
      ],
    ]);
    expect(controller.selection).toHaveLength(0); // the view reports; the element decides.
  });

  it("maps a hit on an owned visual style layer back to its composition layer and source", async () => {
    const { controller, map, view, selections } = await startView();
    controller.apply({ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels", title: "Parcels" } });
    await view.settled();
    map.getStyle = () => ({
      layers: [
        { id: "honua-basemap-land", metadata: { "honua:compositionLayerId": "hi-parcels" } },
        { id: "parcels-themed", metadata: { "honua:compositionLayerId": "hi-parcels" } },
      ],
    });
    const query = vi.spyOn(map, "queryRenderedFeatures");
    map.setRenderedFeatures([{ id: 42, source: "visual-source", layer: { id: "parcels-themed" } }]);
    map.emit("click", { point: { x: 10, y: 10 } });
    expect(query).toHaveBeenCalledWith({ x: 10, y: 10 }, { layers: ["parcels-themed"] });
    expect(selections).toEqual([
      [
        { kind: "feature", sourceId: "hi-parcels", featureId: 42 },
        { kind: "layer", id: "hi-parcels" },
      ],
    ]);
  });

  it("ignores a click that hits nothing", async () => {
    const { controller, map, view, selections } = await startView();
    controller.apply({ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } });
    await view.settled();
    map.setRenderedFeatures([]);
    map.emit("click", { point: { x: 1, y: 1 } });
    expect(selections).toEqual([]);
  });

  it("degrades to an unavailable status — never a throw — when the map cannot be constructed", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const view = new CompositionMapView({
      container: {} as HTMLElement,
      controller,
      mapFactory: async () => {
        throw new Error("WebGL context creation failed");
      },
    });
    await expect(view.start()).resolves.toBeUndefined();
    expect(view.status).toBe("unavailable");
    expect(view.statusDetail).toContain("WebGL");
  });

  it("stops applying updates once disposed", async () => {
    const { controller, map, view } = await startView();
    view.dispose();
    expect(map.removed).toBe(true);
    const styles = map.styles.length;
    controller.apply({ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } });
    await view.settled();
    expect(map.styles).toHaveLength(styles);
  });

  it("survives a map that throws on setStyle, recording the failure instead of propagating it", async () => {
    const { controller, map, view } = await startView();
    const failing = vi.spyOn(map, "setStyle").mockImplementation(() => {
      throw new Error("style diff exploded");
    });
    controller.apply({ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } });
    await expect(view.settled()).resolves.toBeUndefined();
    expect(view.statusDetail).toContain("style diff exploded");
    failing.mockRestore();
  });
});

describe("compositionTargetsFromFeatures", () => {
  it("falls back to the layer target when the hit feature has no id", () => {
    expect(compositionTargetsFromFeatures([{ source: "hi-parcels", layer: { id: "hi-parcels" } }])).toEqual([
      { kind: "layer", id: "hi-parcels" },
    ]);
  });

  it("ignores basemap furniture", () => {
    expect(
      compositionTargetsFromFeatures([{ id: 1, source: "honua-basemap-land", layer: { id: "honua-basemap-land" } }]),
    ).toEqual([]);
  });

  it("ignores an empty hit list", () => {
    expect(compositionTargetsFromFeatures([])).toEqual([]);
  });
});

describe("authoritative style interaction bindings", () => {
  async function styledView() {
    const descriptor = {
      id: "hi-parcels",
      title: "Parcels",
      protocol: "geoservices-feature-service",
      geometryType: "Polygon",
      locator: { serviceId: "service", layerId: 1, url: "https://honua.test/rest/services/Parcels/FeatureServer" },
    };
    let session = { getAccessToken: async () => "token" };
    let revision = 1;
    const bind = vi.fn(async (styleId: string, source: CompositionSourceDescriptor) => ({
      sourceId: source.id,
      fields: [],
      descriptorSha256: "hash",
      descriptorBody: "{}",
      stylesheetLayerId: "canonical",
      definition: {
        styleId,
        title: "Style",
        description: "Navy polygons",
        styleVersion: revision,
        sha256: "hash",
        inlineBody: "{}",
        serverRoot: "https://honua.test",
        observedAt: "2026-10-14T00:00:00Z",
        layers: [],
      },
      override: { paint: { "fill-color": revision === 1 ? "#003366" : "#ddaa22" } },
    }));
    const result = await startView({
      projection: { catalog: [descriptor] },
      styleProvider: {
        bind,
        get sessionIdentity() {
          return session;
        },
      },
    });
    result.controller.apply({
      name: "addLayer",
      layer: { id: "parcels", sourceId: "hi-parcels", styleRef: { kind: "style-ref", styleId: "district" } },
    });
    await result.view.settled();
    return {
      ...result,
      bind,
      changeRevision: () => {
        revision++;
      },
      descriptor,
      replaceSession: () => {
        session = { getAccessToken: async () => "replacement" };
      },
    };
  }
  it("keeps unrelated OGC and GeoServices presets without authoritative provenance", async () => {
    const ogc = {
      id: "external",
      protocol: "ogc-features",
      geometryType: "Polygon",
      locator: { url: "https://external.test/ogc", collectionId: "parcels" },
    };
    const honua = {
      id: "honua",
      protocol: "geoservices-feature-service",
      geometryType: "Polygon",
      locator: { serviceId: "service", layerId: 0, url: "https://honua.test/rest/services/Parcels/FeatureServer" },
    };
    const arcgis = {
      id: "arcgis",
      protocol: "geoservices-feature-service",
      geometryType: "Polygon",
      locator: { url: "https://external.test/rest/services/Parcels/FeatureServer", layerId: 0 },
    };
    const legacy = { id: "legacy", protocol: "geoservices-feature-service", geometryType: "Polygon" };
    const bind = vi.fn(async () => {
      throw new Error("Unknown authoritative style.");
    });
    const { controller, view, map } = await startView({
      projection: { catalog: [ogc, honua, arcgis, legacy] },
      styleProvider: { bind, sessionIdentity: undefined },
    });
    for (const sourceId of [ogc.id, honua.id, arcgis.id, legacy.id])
      controller.apply({
        name: "addLayer",
        layer: { id: sourceId, sourceId, styleRef: { kind: "style-ref", styleId: "unknown" } },
      });
    await view.settled();
    expect(bind).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledWith("unknown", honua);
    expect(view.projection?.renderedLayerIds).toEqual(["external", "arcgis", "legacy"]);
    expect(view.projection?.unresolved).toMatchObject([{ layerId: "honua", reason: "Unknown authoritative style." }]);
    expect(map.latestStyle?.layers.find((layer) => layer.id === "external")?.paint).toBeDefined();
    for (const id of ["external", "arcgis", "legacy"]) {
      const rendered = map.latestStyle?.layers.find((layer) => layer.id === id);
      expect(rendered?.paint).toBeDefined();
      expect(rendered).not.toHaveProperty("metadata.honua:styleSha256");
    }
    map.getStyle = () => ({ layers: map.latestStyle?.layers ?? [] });
    map.setRenderedFeatures([{ layer: { id: "external" }, properties: { district: "East" } }]);
    expect(view.observeAuthoritativeStyles()).toEqual([]);
    view.dispose();
  });

  it("binds a unique legacy service alias to its rendered id and actual discovered locator", async () => {
    const { controller, view, map, bind, descriptor } = await styledView();
    controller.apply({
      name: "addLayer",
      layer: { id: "legacy", sourceId: "service", styleRef: { kind: "style-ref", styleId: "district" } },
    });
    await view.settled();
    expect(bind).toHaveBeenLastCalledWith("district", { ...descriptor, id: "service" });
    expect(view.projection?.unresolved).toEqual([]);
    expect(view.projection?.renderedLayerIds).toEqual(["parcels", "legacy"]);
    expect(map.latestStyle?.layers.find((layer) => layer.id === "legacy")?.paint?.["fill-color"]).toBe("#003366");
    view.dispose();
  });

  it("refuses a renderer source override before fetching catalog-bound definitions", async () => {
    const { controller, view, bind } = await styledView();
    const previous = bind.mock.calls.length;
    controller.apply({
      name: "addLayer",
      layer: {
        id: "override",
        sourceId: "hi-parcels",
        styleRef: { kind: "style-ref", styleId: "district" },
        metadata: {
          honua: {
            source: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
            geometryType: "Polygon",
          },
        },
      },
    });
    await view.settled();
    expect(bind).toHaveBeenCalledTimes(previous);
    expect(view.projection?.unresolved.find((layer) => layer.layerId === "override")?.reason).toMatch(
      /source override/,
    );
    view.dispose();
  });
  it("reuses live bindings for selection and control repaint without extra MCP requests", async () => {
    const { controller, view, bind } = await styledView();
    expect(bind).toHaveBeenCalledTimes(1);
    controller.select([{ kind: "layer", id: "parcels" }]);
    await view.settled();
    view.setAppearance({ opacity: { parcels: 0.5 } });
    await view.settled();
    expect(bind).toHaveBeenCalledTimes(1);
    view.dispose();
  });
  it("explicit refresh reads a changed revision under the same style and source identity", async () => {
    const { view, map, bind, changeRevision } = await styledView();
    expect(map.latestStyle?.layers.find((layer) => layer.id === "parcels")?.paint?.["fill-color"]).toBe("#003366");
    changeRevision();
    await view.refreshAuthoritativeStyles();
    expect(bind).toHaveBeenCalledTimes(2);
    expect(map.latestStyle?.layers.find((layer) => layer.id === "parcels")?.paint?.["fill-color"]).toBe("#ddaa22");
    view.dispose();
  });
  it("does not repopulate bindings across a refresh requested while a read is pending", async () => {
    const { view, map, bind, changeRevision } = await styledView();
    const oldBinding = await bind.mock.results[0].value;
    let complete!: () => void;
    bind.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = () => resolve(oldBinding);
        }),
    );
    const firstRefresh = view.refreshAuthoritativeStyles();
    await vi.waitFor(() => expect(bind).toHaveBeenCalledTimes(2));
    changeRevision();
    const secondRefresh = view.refreshAuthoritativeStyles();
    complete();
    await Promise.all([firstRefresh, secondRefresh]);
    expect(bind).toHaveBeenCalledTimes(3);
    expect(map.latestStyle?.layers.find((layer) => layer.id === "parcels")?.paint?.["fill-color"]).toBe("#ddaa22");
    view.dispose();
  });
  it("rebinds when style, actual descriptor, session or bounded freshness changes", async () => {
    const { controller, view, bind, descriptor, replaceSession } = await styledView();
    controller.apply({
      name: "setLayerStyleRef",
      target: { kind: "layer", id: "parcels" },
      styleRef: { kind: "style-ref", styleId: "council" },
    });
    await view.settled();
    expect(bind).toHaveBeenCalledTimes(2);
    descriptor.locator.layerId = 2;
    view.setAppearance(undefined);
    await view.settled();
    expect(bind).toHaveBeenCalledTimes(3);
    replaceSession();
    view.setAppearance(undefined);
    await view.settled();
    expect(bind).toHaveBeenCalledTimes(4);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 30001);
    try {
      view.setAppearance(undefined);
      await view.settled();
      expect(bind).toHaveBeenCalledTimes(5);
    } finally {
      clock.mockRestore();
      view.dispose();
    }
  });
});

it("returns actual canonical style readback while an unsaved preview remains displayed", async () => {
  const { controller, map, view } = await startView();
  const style = (color: string) => ({
    version: 8,
    sources: {},
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": color },
      },
    ],
  });
  controller.resetBaseline({ ...createEmptyCompositionState(), mapSpec: style("#000000") });
  view.setStylePreview(style("#0000ff"));
  await view.settled();
  // An accepted server write may normalize the submitted style.
  controller.resetBaseline({ ...createEmptyCompositionState(), mapSpec: style("#00ff00") });
  await view.settled();
  const readback = (await view.editableMapStyle()) as unknown as StyleLike;
  expect(readback.layers.find((layer) => layer.id === "background")?.paint?.["background-color"]).toBe("#00ff00");
  expect(map.latestStyle?.layers.find((layer) => layer.id === "background")?.paint?.["background-color"]).toBe(
    "#0000ff",
  );
  view.dispose();
});

it("does not persist runtime exploration filters in the canonical editor baseline", async () => {
  const { controller, map, view } = await startView();
  controller.apply({ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } });
  view.setAppearance({
    filters: { "hi-parcels": ["==", ["get", "district"], "North"] },
    opacity: { "hi-parcels": 0.2 },
  });
  await view.settled();
  const readback = (await view.editableMapStyle()) as unknown as {
    layers: { id: string; filter?: unknown; paint?: Record<string, unknown> }[];
  };
  expect(readback.layers.find((layer) => layer.id === "hi-parcels")?.filter).toBeUndefined();
  expect((map.latestStyle?.layers.find((layer) => layer.id === "hi-parcels") as { filter?: unknown })?.filter).toEqual([
    "==",
    ["get", "district"],
    "North",
  ]);
  expect(readback.layers.find((layer) => layer.id === "hi-parcels")?.paint?.["fill-opacity"]).not.toBe(
    map.latestStyle?.layers.find((layer) => layer.id === "hi-parcels")?.paint?.["fill-opacity"],
  );
  view.dispose();
});
