import { composeStyle } from "@honua/sdk-js/runtime";
import { describe, expect, it } from "vitest";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import { compositionToMapPackage } from "../../src/map/map-package-projection.js";
import { isAnonymousMapAssetSource, resolveCompositionSource } from "../../src/map/source-resolution.js";
import type { CompositionSourceDescriptor } from "../../src/map/source-resolution.js";
import { applyStudioDraftBody, toStudioCompositionBody } from "../../src/mcp/tool-bridge.js";

const url = "https://archives.example/public.pmtiles";
const vector: CompositionSourceDescriptor = {
  id: "native",
  protocol: "pmtiles",
  geometryType: "Polygon",
  locator: { url, sourceType: "vector" },
};
const layer = {
  id: "land",
  sourceId: "native",
  type: "fill",
  visible: true,
  metadata: { honua: { sourceLayer: "land" } },
};

describe("PMTiles source projection", () => {
  it.each(["vector", "raster"])(
    "preserves %s locator and style through saved-body replay without an author catalog",
    async (sourceType) => {
      const state = {
        ...createEmptyCompositionState(),
        layers: [{ ...layer, type: sourceType === "raster" ? "raster" : "fill" }],
      };
      const catalog = [{ ...vector, locator: { url, sourceType } }];
      const projected = compositionToMapPackage(state, { catalog });
      expect(projected.unresolved).toEqual([]);
      expect(projected.mapPackage.sourceBindings).toEqual([
        { sourceId: "native", protocol: "pmtiles", locator: { url, sourceType } },
      ]);
      const body = toStudioCompositionBody({
        ...state,
        sourceBindings: projected.mapPackage.sourceBindings,
        mapSpec: { ...projected.mapPackage.mapSpec },
      });
      const reopened = applyStudioDraftBody(JSON.parse(JSON.stringify(body)));
      expect(reopened.sourceBindings).toEqual(projected.mapPackage.sourceBindings);
      const audience = compositionToMapPackage(reopened, { sourceAuthority: "current-reader" });
      expect(audience.unresolved).toEqual([]);
      const style = await composeStyle(audience.mapPackage, audience.mapPackage.mapSpec, {});
      expect(style.sources.native).toMatchObject({ type: sourceType, url: `pmtiles://${url}` });
      expect(style.layers.find((item) => item.id === "land")).toMatchObject({
        type: sourceType === "raster" ? "raster" : "fill",
        ...(sourceType === "vector" ? { "source-layer": "land" } : {}),
      });
    },
  );

  it("requires an explicit source type, vector source-layer and compatible presentation", () => {
    expect(resolveCompositionSource(layer, { catalog: [{ ...vector, locator: { url } }] })).toHaveProperty("reason");
    expect(resolveCompositionSource({ ...layer, metadata: {} }, { catalog: [vector] })).toHaveProperty("reason");
    expect(
      resolveCompositionSource(layer, { catalog: [{ ...vector, locator: { url, sourceType: "raster" } }] }),
    ).toHaveProperty("reason");
    expect(
      resolveCompositionSource(layer, {
        catalog: [{ ...vector, locator: { url: "https://user:secret@archives.example/a", sourceType: "vector" } }],
      }),
    ).toHaveProperty("reason");
  });

  it("recognizes only absolute HTTP(S) PMTiles source URLs for vector/raster assets", () => {
    expect(isAnonymousMapAssetSource({ type: "vector", url: `pmtiles://${url}` })).toBe(true);
    for (const source of [
      { type: "vector", url: "pmtiles://relative" },
      { type: "vector", url: "pmtiles://file:///a" },
      { type: "image", url: `pmtiles://${url}` },
      { type: "raster", tiles: [`pmtiles://${url}`] },
    ])
      expect(isAnonymousMapAssetSource(source)).toBe(false);
  });
});
