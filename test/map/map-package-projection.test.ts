import { describe, expect, it } from "vitest";

import { CompositionHistory } from "../../src/composition/history.js";
import { canonicalCompositionJson, createEmptyCompositionState } from "../../src/composition/model.js";
import type { CompositionState } from "../../src/composition/model.js";
import { createOfflineBasemapStyle } from "../../src/map/basemap.js";
import { BASEMAP_ID_PREFIX, OUTLINE_LAYER_SUFFIX } from "../../src/map/constants.js";
import { compositionToMapPackage } from "../../src/map/map-package-projection.js";
import type { CompositionSourceDescriptor } from "../../src/map/source-resolution.js";
import { paletteColorFor, styleRefColorFor } from "../../src/map/style-presets.js";

const CATALOG: readonly CompositionSourceDescriptor[] = [
  { id: "hi-parcels", title: "Parcels", protocol: "ogc-features", geometryType: "Polygon" },
  { id: "hi-roads", title: "Roads", protocol: "geoservices-feature-service", geometryType: "LineString" },
  { id: "hi-imagery", title: "Imagery", protocol: "stac", geometryType: "Raster" },
];

function stateFrom(commands: readonly unknown[]): CompositionState {
  const history = new CompositionHistory(createEmptyCompositionState());
  for (const command of commands) history.apply(command);
  return history.current;
}

function layerIds(mapSpec: { layers: readonly { id: string }[] }): string[] {
  return mapSpec.layers.map((layer) => layer.id);
}

describe("compositionToMapPackage (honua-studio#23)", () => {
  it("preserves raster override rendering, visibility and opacity", () => {
    const source = { type: "raster", tiles: ["https://tiles.example/{z}/{x}/{y}.png"], tileSize: 256 };
    const state = stateFrom([
      {
        name: "addLayer",
        layer: { id: "imagery", sourceId: "imagery", type: "raster", visible: false, metadata: { honua: { source } } },
      },
    ]);
    const projection = compositionToMapPackage(state, { appearance: { opacity: { imagery: 0.42 } } });
    expect(projection.unresolved).toEqual([]);
    expect(projection.mapPackage.mapSpec.sources.imagery).toEqual(source);
    expect(projection.mapPackage.mapSpec.layers.find((layer) => layer.id === "imagery")).toMatchObject({
      type: "raster",
      paint: { "raster-opacity": 0.42 },
      layout: { visibility: "none" },
    });
  });

  it("projects an empty composition to the vendored basemap alone", () => {
    const { mapPackage, renderedLayerIds, unresolved } = compositionToMapPackage(createEmptyCompositionState(), {
      catalog: CATALOG,
    });
    expect(mapPackage.format).toBe("honua_map_package.v1");
    expect(renderedLayerIds).toEqual([]);
    expect(unresolved).toEqual([]);
    expect(layerIds(mapPackage.mapSpec).every((id) => id.startsWith(BASEMAP_ID_PREFIX))).toBe(true);
    // No initialView key at all rather than an empty object — the package is
    // an artifact, and an empty view is a different statement from no view.
    expect(mapPackage.initialView).toBeUndefined();
  });

  it("adds a source, a layer, and a companion outline for a polygon layer", () => {
    const state = stateFrom([
      { name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels", title: "Parcels" } },
    ]);
    const { mapPackage, renderedLayerIds } = compositionToMapPackage(state, { catalog: CATALOG });
    expect(renderedLayerIds).toEqual(["hi-parcels"]);
    expect(layerIds(mapPackage.mapSpec)).toContain("hi-parcels");
    expect(layerIds(mapPackage.mapSpec)).toContain(`hi-parcels${OUTLINE_LAYER_SUFFIX}`);
    expect(mapPackage.mapSpec.sources["hi-parcels"]).toBeDefined();
    expect(mapPackage.sourceBindings.map((binding) => binding.sourceId)).toEqual(["hi-parcels"]);
    expect(mapPackage.legend).toEqual([{ label: "Parcels", color: paletteColorFor("hi-parcels") }]);
  });

  it("keeps the composition layer's own id as the MapLibre layer id, so a map click resolves to a deictic target", () => {
    const state = stateFrom([{ name: "addLayer", layer: { id: "roads-primary", sourceId: "hi-roads" } }]);
    const { mapPackage } = compositionToMapPackage(state, { catalog: CATALOG });
    const composed = mapPackage.mapSpec.layers.find((layer) => layer.id === "roads-primary");
    expect(composed?.type).toBe("line");
    expect(composed?.source).toBe("hi-roads");
    expect(composed?.metadata?.["honua:compositionLayerId"]).toBe("roads-primary");
  });

  it("materializes a shared source once when two layers reference the same dataset", () => {
    const state = stateFrom([
      { name: "addLayer", layer: { id: "parcels-a", sourceId: "hi-parcels" } },
      { name: "addLayer", layer: { id: "parcels-b", sourceId: "hi-parcels" } },
    ]);
    const { mapPackage } = compositionToMapPackage(state, { catalog: CATALOG });
    expect(Object.keys(mapPackage.mapSpec.sources).filter((id) => id === "hi-parcels")).toHaveLength(1);
    expect(mapPackage.sourceBindings).toHaveLength(1);
    expect(layerIds(mapPackage.mapSpec)).toContain("parcels-a");
    expect(layerIds(mapPackage.mapSpec)).toContain("parcels-b");
  });

  it("hides an invisible layer via layout visibility rather than dropping it", () => {
    const state = stateFrom([
      { name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels", visible: false } },
    ]);
    const { mapPackage, renderedLayerIds } = compositionToMapPackage(state, { catalog: CATALOG });
    expect(renderedLayerIds).toEqual(["hi-parcels"]);
    const composed = mapPackage.mapSpec.layers.find((layer) => layer.id === "hi-parcels");
    expect(composed?.layout).toEqual({ visibility: "none" });
    const outline = mapPackage.mapSpec.layers.find((layer) => layer.id === `hi-parcels${OUTLINE_LAYER_SUFFIX}`);
    expect(outline?.layout).toEqual({ visibility: "none" });
  });

  it("reports an unrenderable layer instead of dropping it silently", () => {
    const state = stateFrom([
      { name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } },
      { name: "addLayer", layer: { id: "hi-imagery", sourceId: "hi-imagery" } },
    ]);
    const { renderedLayerIds, unresolved } = compositionToMapPackage(state, { catalog: CATALOG });
    expect(renderedLayerIds).toEqual(["hi-parcels"]);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.layerId).toBe("hi-imagery");
    expect(unresolved[0]?.reason).toContain("raster");
  });

  it("substitutes a deterministic preset for a style ref it cannot fetch, and marks the substitution", () => {
    const state = stateFrom([
      {
        name: "addLayer",
        layer: { id: "hi-parcels", sourceId: "hi-parcels", styleRef: { kind: "style-ref", styleId: "district" } },
      },
    ]);
    const { mapPackage } = compositionToMapPackage(state, { catalog: CATALOG });
    expect(mapPackage.styleRefs).toHaveLength(1);
    const override = mapPackage.styleRefs?.[0]?.body?.["hi-parcels"];
    expect(override?.paint?.["fill-color"]).toBe(styleRefColorFor("district"));
    expect(override?.metadata?.["honua:styleRefFallback"]).toBe("district");
  });

  it("prefers a real style-ref body when the caller could resolve one", () => {
    const state = stateFrom([
      {
        name: "addLayer",
        layer: { id: "hi-parcels", sourceId: "hi-parcels", styleRef: { kind: "style-ref", styleId: "district" } },
      },
    ]);
    const { mapPackage } = compositionToMapPackage(state, {
      catalog: CATALOG,
      styleRefBodies: { district: { "hi-parcels": { paint: { "fill-color": "#123456" } } } },
    });
    expect(mapPackage.styleRefs?.[0]?.body?.["hi-parcels"]?.paint?.["fill-color"]).toBe("#123456");
    expect(mapPackage.styleRefs?.[0]?.body?.["hi-parcels"]?.metadata).toBeUndefined();
  });

  it("projects the composed view onto initialView, bbox included", () => {
    const state = stateFrom([{ name: "setView", view: { center: [-157.9, 21.4], zoom: 10, pitch: 30 } }]);
    expect(compositionToMapPackage(state, { catalog: CATALOG }).mapPackage.initialView).toEqual({
      center: [-157.9, 21.4],
      zoom: 10,
      pitch: 30,
    });
    const bboxState = stateFrom([{ name: "setView", view: { bbox: [-158.3, 21.2, -157.6, 21.8] } }]);
    expect(compositionToMapPackage(bboxState, { catalog: CATALOG }).mapPackage.initialView).toEqual({
      bbox: [-158.3, 21.2, -157.6, 21.8],
    });
  });

  it("accepts a deployment's own basemap in place of the vendored one", () => {
    const custom = { version: 8 as const, sources: {}, layers: [{ id: "custom-bg", type: "background" }] };
    const { mapPackage } = compositionToMapPackage(createEmptyCompositionState(), { basemap: custom });
    expect(layerIds(mapPackage.mapSpec)).toEqual(["custom-bg"]);
  });

  it("never mutates the basemap it was handed — two projections must not accumulate layers", () => {
    const basemap = createOfflineBasemapStyle();
    const before = basemap.layers.length;
    const state = stateFrom([{ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } }]);
    compositionToMapPackage(state, { catalog: CATALOG, basemap });
    compositionToMapPackage(state, { catalog: CATALOG, basemap });
    expect(basemap.layers).toHaveLength(before);
    expect(Object.keys(basemap.sources)).not.toContain("hi-parcels");
  });

  it("is byte-stable: the same composition projects to identical canonical JSON every time (REQ-005)", () => {
    const commands = [
      { name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels", title: "Parcels" } },
      {
        name: "setLayerStyleRef",
        target: { kind: "layer", id: "hi-parcels" },
        styleRef: { kind: "style-ref", styleId: "district" },
      },
      { name: "addLayer", layer: { id: "hi-roads", sourceId: "hi-roads" } },
      { name: "setView", view: { center: [-157.9, 21.4], zoom: 9 } },
    ];
    const first = compositionToMapPackage(stateFrom(commands), { catalog: CATALOG });
    const second = compositionToMapPackage(stateFrom(commands), { catalog: CATALOG });
    expect(canonicalCompositionJson(second.mapPackage)).toBe(canonicalCompositionJson(first.mapPackage));
  });

  it("colours a layer from its own id, so adding one layer never recolours another", () => {
    const one = compositionToMapPackage(
      stateFrom([{ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } }]),
      {
        catalog: CATALOG,
      },
    );
    const two = compositionToMapPackage(
      stateFrom([
        { name: "addLayer", layer: { id: "hi-roads", sourceId: "hi-roads" } },
        { name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } },
      ]),
      { catalog: CATALOG },
    );
    const paintOf = (projection: typeof one) =>
      projection.mapPackage.mapSpec.layers.find((layer) => layer.id === "hi-parcels")?.paint;
    expect(paintOf(two)).toEqual(paintOf(one));
  });
});

describe("authoritative map-local style precedence", () => {
  it("does not resurrect a render layer intentionally removed in the visual editor", () => {
    const state = stateFrom([{ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } }]);
    const initial = compositionToMapPackage(state, { catalog: CATALOG }).mapPackage.mapSpec;
    const mapSpec = {
      ...initial,
      layers: initial.layers.filter((layer) => layer.id !== "hi-parcels" && layer.id !== "hi-parcels__outline"),
    };
    const observed = compositionToMapPackage(
      { ...state, mapSpec: mapSpec as unknown as Record<string, unknown> },
      { catalog: CATALOG },
    ).mapPackage.mapSpec;
    expect(layerIds(observed)).not.toContain("hi-parcels");
    expect(layerIds(observed)).not.toContain("hi-parcels__outline");
  });
  it("uses inline paint without requiring a remote style-catalog binding", () => {
    const state = stateFrom([
      { name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } },
      {
        name: "setLayerStyleRef",
        target: { kind: "layer", id: "hi-parcels" },
        styleBody: { "hi-parcels": { paint: { "fill-color": "#112233" } } },
      },
    ]);
    const result = compositionToMapPackage(state, { catalog: CATALOG, authoritativeStyles: {} });
    expect(result.unresolved).toEqual([]);
    expect(result.mapPackage.styleRefs?.[0].body).toEqual({ "hi-parcels": { paint: { "fill-color": "#112233" } } });
  });
});

it("preserves inline snapshot bodies when explicit binding metadata is also present", () => {
  const body = { owner: { paint: { "fill-color": "#884422" } } };
  const bindings = [{ styleLayerId: "catalog", targetLayerId: "owner", layerType: "fill" }];
  const state = {
    ...stateFrom([{ name: "addLayer", layer: { id: "owner", sourceId: "hi-parcels" } }]),
    layers: [
      {
        id: "owner",
        sourceId: "hi-parcels",
        visible: true,
        styleRef: { kind: "style-ref" as const, styleId: "snapshot" },
      },
    ],
    styleRefs: [{ styleId: "snapshot", body, layerBindings: bindings }],
  };
  const exported = compositionToMapPackage(state, { catalog: CATALOG }).mapPackage;
  expect(exported.styleRefs).toEqual([{ styleId: "snapshot", body }]);
  expect(JSON.parse(JSON.stringify(exported)).styleRefs[0].body).toEqual(body);
  expect(state.styleRefs[0].body).toEqual(body);
});
