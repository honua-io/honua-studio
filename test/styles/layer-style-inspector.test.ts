// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompositionController } from "../../src/composition/controller.js";
import { canonicalCompositionJson, createEmptyCompositionState } from "../../src/composition/model.js";
import type { CompositionState } from "../../src/composition/model.js";
import { LayerStyleInspector } from "../../src/styles/layer-style-inspector.js";
import type { MapStyleDocument, MapStyleField } from "../../src/styles/map-style-edit.js";

const PALETTE = ["#eff3ff", "#c6dbef", "#9ecae1", "#6baed6", "#3182bd", "#08519c"];
const FIELDS: readonly MapStyleField[] = [
  { name: "zoning", type: "string" },
  { name: "year_built", type: "integer" },
];

afterEach(() => {
  document.body.innerHTML = "";
});

function mapStyle(
  id: string,
  geometry: "circle" | "line" | "fill",
  paint: Record<string, unknown>,
  extraLayers: readonly Record<string, unknown>[] = [],
): MapStyleDocument {
  return {
    version: 8,
    glyphs: "https://example.com/approved/{fontstack}/{range}.pbf",
    sources: {
      [id]: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      other: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    },
    layers: [
      { id, type: geometry, source: id, paint },
      ...extraLayers,
      {
        id: "other",
        type: "circle",
        source: "other",
        paint: { "circle-color": "#abcdef", "circle-radius": 4 },
      },
    ],
  };
}

function controllerFor(
  geometry: "circle" | "line" | "fill",
  options: { outline?: boolean; paint?: Record<string, unknown>; state?: Partial<CompositionState> } = {},
): { controller: CompositionController; layerId: string } {
  const layerId = geometry === "circle" ? "points" : geometry === "line" ? "roads" : "parcels";
  const colorKey = `${geometry}-color`;
  const opacityKey = `${geometry}-opacity`;
  const paint = {
    [colorKey]: "#112233",
    [opacityKey]: 1,
    ...(geometry === "line" ? { "line-width": 2 } : {}),
    ...(geometry === "circle" ? { "circle-radius": 5 } : {}),
    ...options.paint,
  };
  const extra =
    geometry === "fill" && options.outline !== false
      ? [
          {
            id: `${layerId}__outline`,
            type: "line",
            source: layerId,
            paint: { "line-color": "#112233", "line-width": 1 },
          },
        ]
      : [];
  const controller = new CompositionController({
    ...createEmptyCompositionState(),
    layers: [
      { id: layerId, sourceId: layerId, type: geometry, title: layerId, visible: true },
      { id: "other", sourceId: "other", type: "circle", title: "Other", visible: true },
    ],
    mapSpec: mapStyle(layerId, geometry, paint, extra),
    ...options.state,
  });
  return { controller, layerId };
}

function lineWithInline(
  body: Record<string, Record<string, unknown>>,
  paint?: Record<string, unknown>,
): { controller: CompositionController; layerId: string } {
  return controllerFor("line", {
    ...(paint ? { paint } : {}),
    state: {
      layers: [
        {
          id: "roads",
          sourceId: "roads",
          type: "line",
          title: "Roads",
          visible: true,
          styleRef: { kind: "style-ref", styleId: "honua-inline:roads" },
        },
        { id: "other", sourceId: "other", type: "circle", title: "Other", visible: true },
      ],
      styleRefs: [{ styleId: "honua-inline:roads", body }],
    },
  });
}

function paintOf(style: MapStyleDocument, layerId: string): Record<string, unknown> {
  const layer = (style.layers as Record<string, unknown>[]).find((entry) => entry.id === layerId);
  return (layer?.paint ?? {}) as Record<string, unknown>;
}

describe("compact layer style inspector", () => {
  it("previews point, line, and polygon color, opacity, and size or stroke without writing", () => {
    const cases = [
      { geometry: "circle" as const, sizeKey: "circle-radius", size: 8 },
      { geometry: "line" as const, sizeKey: "line-width", size: 4 },
      { geometry: "fill" as const, sizeKey: "line-width", size: 3 },
    ];
    for (const entry of cases) {
      const { controller, layerId } = controllerFor(entry.geometry);
      const before = canonicalCompositionJson(controller.state);
      const inspector = new LayerStyleInspector({ controller, layerId, onPreview: vi.fn() });
      const preview = inspector.preview({ color: "#445566", opacity: 0.4, strokeOrSize: entry.size });
      expect(preview.ok).toBe(true);
      if (!preview.ok) continue;
      expect(paintOf(preview.style, layerId)[`${entry.geometry}-color`]).toBe("#445566");
      expect(paintOf(preview.style, layerId)[`${entry.geometry}-opacity`]).toBe(0.4);
      const sized = entry.geometry === "fill" ? `${layerId}__outline` : layerId;
      expect(paintOf(preview.style, sized)[entry.sizeKey]).toBe(entry.size);
      expect(paintOf(preview.style, "other")["circle-color"]).toBe("#abcdef");
      expect(canonicalCompositionJson(controller.state)).toBe(before);
      expect(controller.canUndo()).toBe(false);
      inspector.dispose();
    }
  });

  it("apply and undo go through the composition draft, and cancel writes nothing", async () => {
    const { controller, layerId } = controllerFor("line");
    const seen: MapStyleDocument[] = [];
    const inspector = new LayerStyleInspector({
      controller,
      layerId,
      onPreview: (style) => {
        if (style) seen.push(style);
      },
    });
    inspector.preview({ color: "#00aa00" });
    // toMatchObject compares arrays by length. The fixture also carries the untouched sibling layer.
    expect(controller.state.mapSpec).toMatchObject({
      layers: [
        expect.objectContaining({ paint: expect.objectContaining({ "line-color": "#112233" }) }),
        expect.objectContaining({ id: "other", paint: expect.objectContaining({ "circle-color": "#abcdef" }) }),
      ],
    });
    inspector.cancel();
    expect(seen).toHaveLength(1);
    expect(controller.canUndo()).toBe(false);
    expect(paintOf(controller.state.mapSpec as MapStyleDocument, layerId)["line-color"]).toBe("#112233");

    const applied = await inspector.preview({ color: "#00aa00", opacity: 0.25 }).ok;
    expect(applied).toBe(true);
    const result = await inspector.apply();
    expect(result.ok).toBe(true);
    expect(paintOf(controller.state.mapSpec as MapStyleDocument, layerId)).toMatchObject({
      "line-color": "#00aa00",
      "line-opacity": 0.25,
      "line-width": 2,
    });
    expect(paintOf(controller.state.mapSpec as MapStyleDocument, "other")["circle-color"]).toBe("#abcdef");
    expect((controller.state.mapSpec as MapStyleDocument).glyphs).toBe(
      "https://example.com/approved/{fontstack}/{range}.pbf",
    );
    expect(await inspector.undo()).toBe(true);
    expect(paintOf(controller.state.mapSpec as MapStyleDocument, layerId)["line-color"]).toBe("#112233");
    inspector.dispose();
  });

  it("keeps an unrelated accepted edit when a preview is cancelled", async () => {
    const { controller, layerId } = controllerFor("circle");
    const inspector = new LayerStyleInspector({ controller, layerId });
    controller.apply({ name: "setVisibility", target: { kind: "layer", id: "other" }, visible: false });
    inspector.preview({ color: "#010101" });
    inspector.cancel();
    expect(controller.state.layers.find((layer) => layer.id === "other")?.visible).toBe(false);
    expect(paintOf(controller.state.mapSpec as MapStyleDocument, layerId)["circle-color"]).toBe("#112233");
    expect(controller.history.revisions().at(-1)?.command).toMatchObject({ name: "setVisibility" });
    inspector.dispose();
  });

  it("applies categorical and numeric breaks from described fields and refuses invalid values", async () => {
    const { controller, layerId } = controllerFor("fill");
    const inspector = new LayerStyleInspector({ controller, layerId, fields: FIELDS });
    const categories = inspector.preview({
      thematic: { mode: "categories", field: FIELDS[0]!, values: ["Residential", "Commercial"] },
    });
    expect(categories.ok).toBe(true);
    if (!categories.ok) return;
    expect(paintOf(categories.style, layerId)["fill-color"]).toEqual([
      "match",
      ["get", "zoning"],
      "Residential",
      PALETTE[0],
      "Commercial",
      PALETTE[1],
      PALETTE[2],
    ]);
    expect(categories.legend.map((entry) => entry.label)).toEqual(["Residential", "Commercial", "Other"]);
    expect(categories.legend.map((entry) => entry.color)).toEqual([PALETTE[0], PALETTE[1], PALETTE[2]]);

    const breaks = inspector.preview({
      thematic: { mode: "breaks", field: FIELDS[1]!, values: [1950, 2000] },
    });
    expect(breaks.ok).toBe(true);
    if (!breaks.ok) return;
    expect(paintOf(breaks.style, layerId)["fill-color"]).toEqual([
      "step",
      ["to-number", ["get", "year_built"]],
      PALETTE[0],
      1950,
      PALETTE[1],
      2000,
      PALETTE[2],
    ]);
    expect(breaks.legend.map((entry) => [entry.label, entry.color])).toEqual([
      ["< 1950", PALETTE[0]],
      ["1950–2000", PALETTE[1]],
      ["≥ 2000", PALETTE[2]],
    ]);
    expect((await inspector.apply()).ok).toBe(true);
    expect(paintOf(controller.state.mapSpec as MapStyleDocument, layerId)["fill-color"]).toEqual(
      paintOf(breaks.style, layerId)["fill-color"],
    );

    const fresh = new LayerStyleInspector({ controller, layerId, fields: FIELDS });
    expect(fresh.preview({ thematic: { mode: "breaks", field: FIELDS[0]!, values: [1, 2] } }).ok).toBe(false);
    expect(
      fresh.preview({ thematic: { mode: "breaks", field: { name: "invented", type: "integer" }, values: [1, 2] } }),
    ).toMatchObject({ ok: false });
    expect(
      fresh.preview({ thematic: { mode: "categories", field: FIELDS[0]!, values: ["Residential", "Residential"] } }),
    ).toMatchObject({ ok: false });
    expect(paintOf(controller.state.mapSpec as MapStyleDocument, layerId)["fill-color"]).toEqual(
      paintOf(breaks.style, layerId)["fill-color"],
    );
    fresh.dispose();
    inspector.dispose();
  });

  it("refuses a lossy replacement of an unsupported or classified expression", async () => {
    const { controller, layerId } = controllerFor("line", {
      paint: {
        "line-color": ["interpolate", ["linear"], ["zoom"], 0, "#111111", 12, "#eeeeee"],
        "line-opacity": 1,
        "line-width": 2,
      },
    });
    const before = canonicalCompositionJson(controller.state);
    const inspector = new LayerStyleInspector({ controller, layerId, fields: FIELDS });
    const refused = inspector.preview({ color: "#00ff00" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toMatch(/advanced/i);
    expect(canonicalCompositionJson(controller.state)).toBe(before);
    expect((await inspector.apply()).ok).toBe(false);
    expect(canonicalCompositionJson(controller.state)).toBe(before);

    const classified = controllerFor("line");
    const thematic = new LayerStyleInspector({
      controller: classified.controller,
      layerId: classified.layerId,
      fields: FIELDS,
    });
    expect(await thematic.preview({ thematic: { mode: "categories", field: FIELDS[0]!, values: ["A"] } }).ok).toBe(
      true,
    );
    expect((await thematic.apply()).ok).toBe(true);
    const flattened = thematic.preview({ color: "#00ff00" });
    expect(flattened.ok).toBe(false);
    if (!flattened.ok) expect(flattened.reason).toMatch(/categor/i);
    expect(paintOf(classified.controller.state.mapSpec as MapStyleDocument, classified.layerId)["line-color"]).toEqual([
      "match",
      ["get", "zoning"],
      "A",
      PALETTE[0],
      PALETTE[1],
    ]);
    thematic.dispose();
    inspector.dispose();
  });

  it("refuses a literal color when inline paint is categorical even if the base color is flat", async () => {
    const match = ["match", ["get", "zoning"], "Residential", PALETTE[0], PALETTE[1]];
    const { controller, layerId } = lineWithInline({ roads: { paint: { "line-color": match } } });
    const before = canonicalCompositionJson(controller.state);
    const inspector = new LayerStyleInspector({ controller, layerId });
    const refused = inspector.preview({ color: "#00ff00" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/categor/i);
    expect((await inspector.apply()).ok).toBe(false);
    expect(canonicalCompositionJson(controller.state)).toBe(before);
    inspector.dispose();
  });

  it("edits a literal inline color when only the base style has an expression", async () => {
    const expression = ["interpolate", ["linear"], ["zoom"], 0, "#111111", 12, "#eeeeee"];
    const { controller, layerId } = lineWithInline(
      { roads: { paint: { "line-color": "#445566" } } },
      { "line-color": expression, "line-opacity": 1, "line-width": 2 },
    );
    const inspector = new LayerStyleInspector({ controller, layerId });
    const preview = inspector.preview({ color: "#00aa00" });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(paintOf(preview.style, layerId)["line-color"]).toBe("#00aa00");
    expect((await inspector.apply()).ok).toBe(true);
    expect(paintOf(controller.state.mapSpec as MapStyleDocument, layerId)["line-color"]).toEqual(expression);
    expect(controller.state.styleRefs?.[0]?.body).toEqual({ roads: { paint: { "line-color": "#00aa00" } } });
    inspector.dispose();
  });

  it("preserves an unsupported expression on a property the edit does not change", async () => {
    const { controller, layerId } = controllerFor("circle", {
      paint: {
        "circle-color": "#112233",
        "circle-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0, 10, 1],
        "circle-radius": 5,
      },
    });
    const inspector = new LayerStyleInspector({ controller, layerId });
    const preview = inspector.preview({ color: "#abcdef" });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(paintOf(preview.style, layerId)["circle-opacity"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      0,
      0,
      10,
      1,
    ]);
    expect((await inspector.apply()).ok).toBe(true);
    expect(paintOf(controller.state.mapSpec as MapStyleDocument, layerId)["circle-opacity"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      0,
      0,
      10,
      1,
    ]);
    inspector.dispose();
  });

  it("does not apply a pending edit after the layer or draft target changes", async () => {
    const { controller, layerId } = controllerFor("line");
    const inspector = new LayerStyleInspector({ controller, layerId });
    inspector.preview({ color: "#00aa00" });
    inspector.retarget("other");
    expect((await inspector.apply()).ok).toBe(false);
    expect(paintOf(controller.state.mapSpec as MapStyleDocument, layerId)["line-color"]).toBe("#112233");
    expect(paintOf(controller.state.mapSpec as MapStyleDocument, "other")["circle-color"]).toBe("#abcdef");

    inspector.retarget(layerId);
    inspector.preview({ color: "#00aa00" });
    controller.apply({
      name: "setMapStyle",
      mapSpec: mapStyle(layerId, "line", { "line-color": "#999999", "line-opacity": 1, "line-width": 2 }),
    });
    const stale = await inspector.apply();
    expect(stale.ok).toBe(false);
    expect(paintOf(controller.state.mapSpec as MapStyleDocument, layerId)["line-color"]).toBe("#999999");
    inspector.dispose();
  });

  it("refuses to detach a live shared style and keeps another layer's inline style", async () => {
    const shared = controllerFor("line", {
      state: {
        layers: [
          {
            id: "roads",
            sourceId: "roads",
            type: "line",
            title: "Roads",
            visible: true,
            styleRef: { kind: "style-ref", styleId: "shared-roads" },
          },
          { id: "other", sourceId: "other", type: "circle", title: "Other", visible: true },
        ],
        styleRefs: [{ styleId: "shared-roads" }],
      },
    });
    const sharedInspector = new LayerStyleInspector({ controller: shared.controller, layerId: shared.layerId });
    const blocked = sharedInspector.preview({ color: "#00aa00" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/shared style/i);
    expect(shared.controller.state.layers[0]?.styleRef?.styleId).toBe("shared-roads");
    expect(shared.controller.state.styleRefs).toEqual([{ styleId: "shared-roads" }]);
    sharedInspector.dispose();

    const { controller, layerId } = controllerFor("line", {
      state: {
        layers: [
          { id: "roads", sourceId: "roads", type: "line", title: "Roads", visible: true },
          {
            id: "other",
            sourceId: "other",
            type: "circle",
            title: "Other",
            visible: true,
            styleRef: { kind: "style-ref", styleId: "honua-inline:other" },
          },
        ],
        styleRefs: [{ styleId: "honua-inline:other", body: { other: { paint: { "circle-radius": 9 } } } }],
      },
    });
    const inspector = new LayerStyleInspector({ controller, layerId });
    expect(inspector.preview({ color: "#00aa00" }).ok).toBe(true);
    expect((await inspector.apply()).ok).toBe(true);
    expect(paintOf(controller.state.mapSpec as MapStyleDocument, layerId)["line-color"]).toBe("#112233");
    expect(controller.state.styleRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          styleId: "honua-inline:roads",
          body: { roads: { paint: { "line-color": "#00aa00" } } },
        }),
        expect.objectContaining({ styleId: "honua-inline:other" }),
      ]),
    );
    expect(controller.state.layers.find((layer) => layer.id === "other")?.styleRef?.styleId).toBe("honua-inline:other");
    inspector.dispose();
  });

  it("keeps inline filter, layout, and minzoom when a color is applied", async () => {
    const filter = ["==", ["get", "class"], "primary"];
    const layout = { "line-cap": "round" };
    const { controller, layerId } = lineWithInline({
      roads: {
        paint: { "line-opacity": 0.8 },
        filter,
        layout,
        minzoom: 6,
        maxzoom: 14,
        metadata: { note: "keep" },
      },
      roads__outline: { filter: ["has", "name"], layout: { visibility: "visible" }, minzoom: 8 },
    });
    const inspector = new LayerStyleInspector({ controller, layerId });
    expect(inspector.preview({ color: "#00aa00" }).ok).toBe(true);
    expect((await inspector.apply()).ok).toBe(true);
    expect(controller.state.styleRefs).toEqual([
      {
        styleId: "honua-inline:roads",
        body: {
          roads: {
            paint: { "line-opacity": 0.8, "line-color": "#00aa00" },
            layout,
            filter,
            minzoom: 6,
            maxzoom: 14,
            metadata: { note: "keep" },
          },
          roads__outline: { layout: { visibility: "visible" }, filter: ["has", "name"], minzoom: 8 },
        },
      },
    ]);
    inspector.dispose();
  });

  it("offers only controls that match the geometry and described fields", () => {
    const point = controllerFor("circle");
    const pointInspector = new LayerStyleInspector({
      controller: point.controller,
      layerId: point.layerId,
      fields: FIELDS,
      container: document.body.appendChild(document.createElement("div")),
    });
    expect(pointInspector.controls()).toMatchObject({ color: true, opacity: true, strokeOrSize: "size", breaks: true });
    expect(pointInspector.container?.querySelector("[data-testid='layer-style-size']")).toBeTruthy();
    expect(pointInspector.container?.querySelector("[data-testid='layer-style-stroke']")).toBeNull();
    pointInspector.dispose();

    const polygon = controllerFor("fill", { outline: false });
    const polygonInspector = new LayerStyleInspector({
      controller: polygon.controller,
      layerId: polygon.layerId,
      container: document.body.appendChild(document.createElement("div")),
    });
    expect(polygonInspector.controls().strokeOrSize).toBe(false);
    expect(polygonInspector.controls().breaks).toBe(false);
    expect(polygonInspector.container?.querySelector("[data-testid='layer-style-stroke']")).toBeNull();
    expect(polygonInspector.container?.querySelector("[data-testid='layer-style-breaks']")).toBeNull();
    polygonInspector.dispose();
  });

  it("does not let a failed shared-draft apply persist a partial style", async () => {
    const { controller, layerId } = controllerFor("line");
    const applyCommand = vi.fn(async () => ({ ok: false as const, reason: "The draft revision is stale." }));
    const inspector = new LayerStyleInspector({ controller, layerId, applyCommand });
    inspector.preview({ color: "#00aa00" });
    const result = await inspector.apply();
    expect(result).toEqual({ ok: false, reason: "The draft revision is stale." });
    expect(applyCommand).toHaveBeenCalledOnce();
    expect(paintOf(controller.state.mapSpec as MapStyleDocument, layerId)["line-color"]).toBe("#112233");
    expect(controller.canUndo()).toBe(false);
    inspector.dispose();
  });

  it("clears the transient preview after a successful apply", async () => {
    const { controller, layerId } = controllerFor("line");
    const onPreview = vi.fn();
    const inspector = new LayerStyleInspector({ controller, layerId, onPreview });
    expect(inspector.preview({ color: "#00aa00" }).ok).toBe(true);
    expect((await inspector.apply()).ok).toBe(true);
    expect(onPreview).toHaveBeenCalledTimes(2);
    expect(onPreview.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ version: 8 }));
    expect(onPreview.mock.calls[1]).toEqual([undefined]);
    inspector.dispose();

    const custom = controllerFor("line");
    const customPreview = vi.fn();
    const applyCommand = vi.fn(async () => ({ ok: true as const }));
    const customInspector = new LayerStyleInspector({
      controller: custom.controller,
      layerId: custom.layerId,
      onPreview: customPreview,
      applyCommand,
    });
    expect(customInspector.preview({ opacity: 0.4 }).ok).toBe(true);
    expect((await customInspector.apply()).ok).toBe(true);
    expect(applyCommand).toHaveBeenCalledOnce();
    expect(customPreview).toHaveBeenCalledTimes(2);
    expect(customPreview.mock.calls[0]?.[0]).toBeTruthy();
    expect(customPreview.mock.calls[1]).toEqual([undefined]);
    customInspector.dispose();

    const quiet = controllerFor("circle");
    const quietInspector = new LayerStyleInspector({ controller: quiet.controller, layerId: quiet.layerId });
    expect(quietInspector.preview({ color: "#010101" }).ok).toBe(true);
    await expect(quietInspector.apply()).resolves.toEqual({ ok: true });
    quietInspector.dispose();
  });
});
