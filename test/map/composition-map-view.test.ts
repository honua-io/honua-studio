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
