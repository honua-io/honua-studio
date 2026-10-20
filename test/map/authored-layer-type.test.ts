import { describe, expect, it } from "vitest";

import { CompositionHistory } from "../../src/composition/history.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import { compositionToMapPackage } from "../../src/map/map-package-projection.js";
import { resolveCompositionSource } from "../../src/map/source-resolution.js";
import {
  applyStudioDraftBody,
  buildServerToolInvocation,
  resolveToolCall,
  toStudioCompositionBody,
} from "../../src/mcp/tool-bridge.js";

const sourceId = "svc-publish-buffer/1";
const descriptor = {
  id: sourceId,
  protocol: "geoservices-feature-service",
  geometryType: "GeometryCollection",
  locator: { serviceId: "svc-publish-buffer", layerId: 1, url: "/rest/services/buffer/FeatureServer/1" },
};

function draft(type?: string) {
  return applyStudioDraftBody({
    view: {},
    widgets: [],
    layers: [{ id: "buffer", sourceId, ...(type !== undefined ? { type } : {}) }],
  });
}

describe("authored composition layer presentation", () => {
  it("renders an explicitly filled catalog layer whose geometry is generic, and retains it across save/read projection", () => {
    const state = draft("fill");
    const wire = toStudioCompositionBody(state);
    expect(wire.layers?.[0]?.type).toBe("fill");
    const projection = compositionToMapPackage(applyStudioDraftBody(wire), { catalog: [descriptor] });
    expect(projection.unresolved).toEqual([]);
    expect(projection.renderedLayerIds).toEqual(["buffer"]);
    expect(projection.mapPackage.mapSpec.layers.find((layer) => layer.id === "buffer")?.type).toBe("fill");
    expect(projection.mapPackage.sourceBindings?.[0]?.locator).toMatchObject({
      layerId: 1,
      url: descriptor.locator.url,
    });
  });

  it("keeps an explicitly requested polygon outline instead of replacing it with fill", () => {
    expect(
      resolveCompositionSource(draft("line").layers[0]!, { catalog: [{ ...descriptor, geometryType: "Polygon" }] }),
    ).toMatchObject({ layerType: "line" });
  });

  it("uses explicit presentation for inline sources before legacy metadata hints", () => {
    const state = applyStudioDraftBody({
      view: {},
      widgets: [],
      layers: [
        {
          id: "inline",
          sourceId: "inline",
          type: "line",
          metadata: {
            honua: {
              source: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
              layerType: "fill",
            },
          },
        },
      ],
    });
    expect(resolveCompositionSource(state.layers[0]!)).toMatchObject({ layerType: "line" });
  });

  it("preserves the type through agent command validation, reduction and server dispatch", () => {
    const resolved = resolveToolCall({
      toolName: "honua_studio_add_layer",
      arguments: { layer: { id: "buffer", sourceId, type: "line" } },
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(buildServerToolInvocation(resolved, { draftId: "draft", generation: 1 })?.arguments.layer).toMatchObject({
      type: "line",
    });
    const history = new CompositionHistory(createEmptyCompositionState());
    history.apply(resolved.command);
    expect(toStudioCompositionBody(history.current).layers?.[0]?.type).toBe("line");
  });

  it("keeps inferred rendering for old drafts without type and refuses generic geometry without an explicit choice", () => {
    expect(
      resolveCompositionSource(draft().layers[0]!, { catalog: [{ ...descriptor, geometryType: "Point" }] }),
    ).toMatchObject({ layerType: "circle" });
    expect(resolveCompositionSource(draft().layers[0]!, { catalog: [descriptor] })).toMatchObject({
      reason: expect.stringContaining("no supported geometry"),
    });
  });

  it.each(["raster", "symbol", "made-up"])("reports unsupported authored type %s visibly", (type) => {
    expect(
      resolveCompositionSource(draft(type).layers[0]!, { catalog: [{ ...descriptor, geometryType: "Polygon" }] }),
    ).toMatchObject({ reason: expect.stringContaining("layer type") });
  });

  it("does not allow explicit vector presentation to bypass raster or unsupported protocol refusal", () => {
    expect(
      resolveCompositionSource(draft("fill").layers[0]!, { catalog: [{ ...descriptor, geometryType: "Raster" }] }),
    ).toMatchObject({ reason: expect.stringContaining("vector sources only") });
    expect(
      resolveCompositionSource(draft("fill").layers[0]!, {
        catalog: [{ ...descriptor, geometryType: "Polygon", protocol: "wms" }],
      }),
    ).toMatchObject({ reason: expect.stringContaining('protocol "wms"') });
  });
});
