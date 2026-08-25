import { describe, expect, it } from "vitest";

import { createEmptyCompositionState } from "../../src/composition/model.js";
import {
  applyStudioDraftBody,
  bridgedToolNames,
  buildServerToolInvocation,
  resolveToolCall,
  toStudioCompositionBody,
} from "../../src/mcp/tool-bridge.js";

describe("mcp/tool-bridge resolveToolCall", () => {
  describe("this engine's own vocabulary (composition)", () => {
    it("addLayer passes through and validates via commands.ts", () => {
      const resolution = resolveToolCall({
        toolName: "addLayer",
        arguments: { layer: { id: "roads", sourceId: "src-roads" } },
      });
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) return;
      expect(resolution.vocabulary).toBe("composition");
      expect(resolution.command).toEqual({ name: "addLayer", layer: { id: "roads", sourceId: "src-roads" } });
      expect(resolution.serverToolName).toBe("honua_studio_add_layer");
    });

    it("setVisibility delegates to honua_studio_set_layer_visibility (honua-studio#31)", () => {
      const resolution = resolveToolCall({
        toolName: "setVisibility",
        arguments: { target: { kind: "layer", id: "parcels" }, visible: false },
      });
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) return;
      expect(resolution.serverToolName).toBe("honua_studio_set_layer_visibility");
    });

    it("pin/unpin have no server tool counterpart", () => {
      const resolution = resolveToolCall({ toolName: "pin", arguments: { target: { kind: "layer", id: "roads" } } });
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) return;
      expect(resolution.serverToolName).toBeUndefined();
    });

    it("invalid composition arguments fail with invalid-arguments", () => {
      const resolution = resolveToolCall({ toolName: "addLayer", arguments: { layer: { id: "" } } });
      expect(resolution.ok).toBe(false);
      if (resolution.ok) return;
      expect(resolution.code).toBe("invalid-arguments");
    });
  });

  describe("honua-studio#6's chat-fixture vocabulary (snake_case)", () => {
    it("add_layer -> addLayer, styleBy -> a style-ref binding", () => {
      const resolution = resolveToolCall({
        toolName: "add_layer",
        arguments: { datasetId: "hi-parcels", styleBy: "district" },
      });
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) return;
      expect(resolution.command).toEqual({
        name: "addLayer",
        layer: {
          id: "hi-parcels",
          sourceId: "hi-parcels",
          styleRef: { kind: "style-ref", styleId: "district" },
        },
      });
      expect(resolution.serverToolName).toBe("honua_studio_add_layer");
    });

    it("add_layer without styleBy omits styleRef", () => {
      const resolution = resolveToolCall({ toolName: "add_layer", arguments: { datasetId: "hi-roads" } });
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) return;
      expect(resolution.command).toEqual({
        name: "addLayer",
        layer: { id: "hi-roads", sourceId: "hi-roads" },
      });
    });

    it("add_layer without datasetId fails with invalid-arguments", () => {
      const resolution = resolveToolCall({ toolName: "add_layer", arguments: {} });
      expect(resolution.ok).toBe(false);
      if (resolution.ok) return;
      expect(resolution.code).toBe("invalid-arguments");
    });

    it("add_chart -> a chart widget bound to the dataset", () => {
      const resolution = resolveToolCall({
        toolName: "add_chart",
        arguments: { datasetId: "hi-parcels", groupBy: "zoning_code", chartType: "bar" },
      });
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) return;
      expect(resolution.command).toEqual({
        name: "addWidget",
        widget: {
          id: "chart-hi-parcels-zoning_code",
          kind: "chart",
          sourceId: "hi-parcels",
          config: { groupBy: "zoning_code", chartType: "bar" },
        },
      });
      expect(resolution.serverToolName).toBe("honua_studio_add_widget");
    });

    it("filter_layer and get_feature_attributes are recognized but unsupported, with a stated reason", () => {
      const filter = resolveToolCall({
        toolName: "filter_layer",
        arguments: { layerId: "hi-parcels", filter: { zoning: "AG" } },
      });
      expect(filter.ok).toBe(false);
      if (filter.ok) return;
      expect(filter.code).toBe("unsupported");
      expect(filter.reason).toContain("filter");

      const attrs = resolveToolCall({
        toolName: "get_feature_attributes",
        arguments: { layerId: "hi-parcels", featureId: "TMK-1-2-3-004" },
      });
      expect(attrs.ok).toBe(false);
      if (attrs.ok) return;
      expect(attrs.code).toBe("unsupported");
      expect(attrs.reason).toContain("read-only");
    });
  });

  describe("honua-server#3002's honua_studio_* vocabulary", () => {
    it("honua_studio_add_layer maps to addLayer, defaulting sourceId to the layer id when omitted", () => {
      const resolution = resolveToolCall({
        toolName: "honua_studio_add_layer",
        arguments: { draftId: "d1", generation: 1, layer: { id: "roads" }, beforeId: "parks" },
      });
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) return;
      expect(resolution.vocabulary).toBe("server-mcp");
      expect(resolution.command).toEqual({
        name: "addLayer",
        layer: { id: "roads", sourceId: "roads" },
        beforeId: "parks",
      });
    });

    it("honua_studio_set_layer_style maps to setLayerStyleRef", () => {
      const resolution = resolveToolCall({
        toolName: "honua_studio_set_layer_style",
        arguments: { draftId: "d1", generation: 2, layerId: "roads", styleRef: "roads-style-v2" },
      });
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) return;
      expect(resolution.command).toEqual({
        name: "setLayerStyleRef",
        target: { kind: "layer", id: "roads" },
        styleRef: { kind: "style-ref", styleId: "roads-style-v2" },
      });
    });

    it("honua_studio_set_view drops crs (no CompositionView counterpart) without failing", () => {
      const resolution = resolveToolCall({
        toolName: "honua_studio_set_view",
        arguments: { draftId: "d1", generation: 1, view: { zoom: 8, center: [1, 2], crs: "EPSG:4326" } },
      });
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) return;
      expect(resolution.command).toEqual({ name: "setView", view: { zoom: 8, center: [1, 2] } });
    });

    it("honua_studio_remove_widget maps to removeWidget with a component target", () => {
      const resolution = resolveToolCall({
        toolName: "honua_studio_remove_widget",
        arguments: { draftId: "d1", generation: 1, widgetId: "chart-1" },
      });
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) return;
      expect(resolution.command).toEqual({ name: "removeWidget", target: { kind: "component", id: "chart-1" } });
    });

    it("missing required fields fail with invalid-arguments", () => {
      const resolution = resolveToolCall({ toolName: "honua_studio_remove_layer", arguments: {} });
      expect(resolution.ok).toBe(false);
      if (resolution.ok) return;
      expect(resolution.code).toBe("invalid-arguments");
    });
  });

  it("a wholly unknown tool name fails with unknown-tool and names the tool", () => {
    const resolution = resolveToolCall({ toolName: "reticulate_splines", arguments: {} });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.code).toBe("unknown-tool");
    expect(resolution.reason).toContain("reticulate_splines");
  });

  it("bridgedToolNames() lists every vocabulary this bridge resolves", () => {
    const names = bridgedToolNames();
    expect(names).toContain("addLayer");
    expect(names).toContain("add_layer");
    expect(names).toContain("honua_studio_add_layer");
  });
});

describe("mcp/tool-bridge buildServerToolInvocation", () => {
  it("builds honua_studio_add_layer arguments from an addLayer command", () => {
    const resolution = resolveToolCall({
      toolName: "addLayer",
      arguments: { layer: { id: "roads", sourceId: "s", styleRef: { kind: "style-ref", styleId: "sty-1" } } },
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    const invocation = buildServerToolInvocation(resolution, { draftId: "d1", generation: 3 });
    expect(invocation).toEqual({
      name: "honua_studio_add_layer",
      arguments: { draftId: "d1", generation: 3, layer: { id: "roads", sourceId: "s", styleRef: "sty-1" } },
    });
  });

  it("builds honua_studio_set_layer_visibility arguments — all four fields, nothing else", () => {
    const resolution = resolveToolCall({
      toolName: "setVisibility",
      arguments: { target: { kind: "layer", id: "parcels" }, visible: false },
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    const invocation = buildServerToolInvocation(resolution, { draftId: "d1", generation: 7 });
    // The tool's schema is `additionalProperties: false` with all four
    // required, so this has to be exact rather than a superset.
    expect(invocation).toEqual({
      name: "honua_studio_set_layer_visibility",
      arguments: { draftId: "d1", generation: 7, layerId: "parcels", visible: false },
    });
  });

  it("threads the caller's current generation, not a remembered one", () => {
    const resolution = resolveToolCall({
      toolName: "setVisibility",
      arguments: { target: { kind: "layer", id: "parcels" }, visible: true },
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(buildServerToolInvocation(resolution, { draftId: "d1", generation: 1 })?.arguments.generation).toBe(1);
    expect(buildServerToolInvocation(resolution, { draftId: "d1", generation: 9 })?.arguments.generation).toBe(9);
  });

  it("returns undefined for a non-layer setVisibility target rather than inventing a layerId", () => {
    const resolution = resolveToolCall({
      toolName: "setVisibility",
      arguments: { target: { kind: "component", id: "toc-1" }, visible: false },
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(buildServerToolInvocation(resolution, { draftId: "d1", generation: 1 })).toBeUndefined();
  });

  it("returns undefined for commands with no server tool (pin)", () => {
    const resolution = resolveToolCall({ toolName: "pin", arguments: { target: { kind: "layer", id: "roads" } } });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(buildServerToolInvocation(resolution, { draftId: "d1", generation: 1 })).toBeUndefined();
  });
});

describe("mcp/tool-bridge draft body <-> composition state round trip", () => {
  it("toStudioCompositionBody / applyStudioDraftBody round-trips layers/view/widgets and preserves local pins/annotations", () => {
    const local = {
      ...createEmptyCompositionState(),
      layers: [
        { id: "roads", sourceId: "s", visible: true, styleRef: { kind: "style-ref" as const, styleId: "sty-1" } },
      ],
      view: { zoom: 8, center: [1, 2] as const },
      widgets: [{ id: "chart-1", kind: "chart" as const }],
      pins: [{ kind: "layer" as const, id: "roads" }],
    };

    const wire = toStudioCompositionBody(local);
    expect(wire.layers).toEqual([{ id: "roads", sourceId: "s", visible: true, styleRef: "sty-1" }]);

    const restored = applyStudioDraftBody(wire, local);
    expect(restored.layers).toEqual(local.layers);
    expect(restored.view).toEqual(local.view);
    expect(restored.widgets).toEqual(local.widgets);
    // Not part of the server wire schema — carried over from `previous` unchanged.
    expect(restored.pins).toEqual(local.pins);
  });
});
