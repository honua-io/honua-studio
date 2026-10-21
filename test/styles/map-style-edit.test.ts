import { describe, expect, it } from "vitest";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import { applyCompositionCommands } from "../../src/composition/reducer.js";
import { applyStudioDraftBody, toStudioCompositionBody } from "../../src/mcp/tool-bridge.js";
import {
  bindNewRenderLayerOwners,
  thematicMapStyle,
  validateInlineStyleBody,
  validateMapStyleEdit,
} from "../../src/styles/map-style-edit.js";

const style = {
  version: 8,
  glyphs: "https://example.com/approved/{fontstack}/{range}.pbf",
  sources: { roads: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
  layers: [{ id: "roads", type: "line", source: "roads", paint: { "line-color": "#ff0000" } }],
};
describe("map-local authorized style editing", () => {
  it("assigns new label ownership only from the actual selected composed source", () => {
    const candidate = { ...style, layers: [...style.layers, { id: "labels", type: "symbol", source: "roads" }] };
    const actual = bindNewRenderLayerOwners(
      style,
      candidate,
      [{ id: "composition", sourceId: "roads" }],
      "composition",
    );
    expect((actual.layers as Record<string, unknown>[])[1].metadata).toEqual({
      "honua:compositionLayerId": "composition",
    });
    expect(() =>
      bindNewRenderLayerOwners(style, candidate, [{ id: "foreign", sourceId: "private" }], "foreign"),
    ).toThrow("composed owner");
  });
  it("builds manual thematic expressions only over the actual selected field", () => {
    const next = thematicMapStyle(
      style,
      { id: "roads", sourceId: "roads" },
      { name: "class", type: "String" },
      "categories",
      ["primary"],
      ["#ff0000", "#000000"],
    );
    expect((next.layers as any[])[0].paint["line-color"]).toEqual([
      "match",
      ["get", "class"],
      "primary",
      "#ff0000",
      "#000000",
    ]);
    expect(() =>
      thematicMapStyle(
        style,
        { id: "roads", sourceId: "roads" },
        { name: "class", type: "String" },
        "breaks",
        [10],
        ["#ff0000", "#000000"],
      ),
    ).toThrow("numeric field");
    const oid = thematicMapStyle(
      style,
      { id: "roads", sourceId: "roads" },
      { name: "OBJECTID", type: "esriFieldTypeOID" },
      "categories",
      [1],
      ["#ff0000", "#000000"],
    );
    expect((oid.layers as any[])[0].paint["line-color"]).toEqual([
      "match",
      ["get", "OBJECTID"],
      1,
      "#ff0000",
      "#000000",
    ]);
  });

  it("accepts thematic paint and labels on an existing source", () => {
    const next = structuredClone(style) as Record<string, any>;
    next.layers[0].paint["line-color"] = ["match", ["get", "class"], "primary", "#ff0000", "#000000"];
    next.layers.push({ id: "labels", type: "symbol", source: "roads", layout: { "text-field": ["get", "name"] } });
    expect(validateMapStyleEdit(style, next)).toEqual([]);
  });
  it.each([
    (next: any) => {
      next.sources.roads.data = "https://example.com/leak";
    },
    (next: any) => {
      next.glyphs = "https://example.com/{fontstack}/{range}.pbf";
    },
    (next: any) => {
      next.layers[0].source = "another";
    },
    (next: any) => {
      next.layers[0]["source-layer"] = "another";
    },
    (next: any) => {
      next.imports = [{ id: "remote", url: "https://example.com/style" }];
    },
  ])("rejects source/resource retargeting", (mutate) => {
    const next = structuredClone(style);
    mutate(next);
    expect(validateMapStyleEdit(style, next).length).toBeGreaterThan(0);
  });
  it("allows only selected render-layer overrides", () => {
    expect(validateInlineStyleBody("roads", { roads: { paint: { "line-width": 3 } } })).toEqual([]);
    expect(validateInlineStyleBody("roads", { other: { paint: { "line-width": 3 } } })).not.toEqual([]);
    expect(validateInlineStyleBody("roads", { roads: { source: "secret" } })).not.toEqual([]);
  });
  it("roundtrips authoritative full and inline styles without losing metadata", () => {
    const state = applyStudioDraftBody({
      layers: [{ id: "roads", sourceId: "roads", styleRef: "inline" }],
      view: {},
      widgets: [],
      mapSpec: style,
      styleRefs: [
        {
          styleId: "inline",
          label: "Local",
          custom: { retained: true },
          body: { roads: { paint: { "line-width": 3 } } },
        },
      ],
    });
    expect(toStudioCompositionBody(state).mapSpec).toEqual(style);
    expect(toStudioCompositionBody(state).styleRefs?.[0]).toMatchObject({ custom: { retained: true }, label: "Local" });
  });
  it("snapshots local full appearance and clears shared links in one history change", () => {
    const state = {
      ...createEmptyCompositionState(),
      mapSpec: style,
      styleRefs: [{ styleId: "shared", body: { roads: { paint: { "line-width": 3 } } } }],
      layers: [
        { id: "roads", sourceId: "roads", visible: true, styleRef: { kind: "style-ref" as const, styleId: "shared" } },
      ],
    };
    const next = structuredClone(style);
    next.layers[0].paint["line-color"] = "#000000";
    const result = applyCompositionCommands(state, [{ name: "setMapStyle", mapSpec: next }]);
    expect(result.state.layers[0].styleRef).toBeUndefined();
    expect(result.state.styleRefs).toEqual([]);
    expect(result.state.mapSpec).toEqual(next);
    expect(state.layers[0].styleRef.styleId).toBe("shared");
  });
  it("does not permit full style edits through pinned layers", () => {
    const state = {
      ...createEmptyCompositionState(),
      mapSpec: style,
      layers: [{ id: "roads", sourceId: "roads", visible: true }],
      pins: [{ kind: "layer" as const, id: "roads" }],
    };
    expect(() => applyCompositionCommands(state, [{ name: "setMapStyle", mapSpec: style }])).toThrow(/pinned/);
  });
});
