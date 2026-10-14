import { describe, expect, it } from "vitest";

import type { CompositionLayer } from "../../src/composition/model.js";
import {
  type CompositionSourceDescriptor,
  isCompositionSourceResolution,
  layerTypeForGeometry,
  resolveCompositionSource,
} from "../../src/map/source-resolution.js";

const CATALOG: readonly CompositionSourceDescriptor[] = [
  { id: "hi-parcels", title: "Parcels", protocol: "ogc-features", geometryType: "Polygon" },
  { id: "hi-roads", title: "Roads", protocol: "geoservices-feature-service", geometryType: "LineString" },
  { id: "hi-wells", title: "Wells", protocol: "ogc-features", geometryType: "Point" },
  { id: "hi-imagery", title: "Imagery", protocol: "stac", geometryType: "Raster" },
  { id: "hi-mystery", title: "Mystery", protocol: "smoke-signals", geometryType: "Polygon" },
];

function layer(overrides: Partial<CompositionLayer> & { id: string; sourceId: string }): CompositionLayer {
  return { visible: true, ...overrides };
}

describe("resolveCompositionSource (honua-studio#23)", () => {
  it("projects an ogc-features dataset onto the collection items route and a geojson source", () => {
    const resolution = resolveCompositionSource(layer({ id: "hi-parcels", sourceId: "hi-parcels" }), {
      catalog: CATALOG,
      featureLimit: 500,
    });
    expect(isCompositionSourceResolution(resolution)).toBe(true);
    if (!isCompositionSourceResolution(resolution)) return;
    expect(resolution.layerType).toBe("fill");
    expect(resolution.source).toEqual({
      type: "geojson",
      data: "/api/ogc/collections/hi-parcels/items?f=json&limit=500",
    });
    // The durable binding is emitted even though the offline render path
    // does not read it — it is what `loadMapPackage` (and an eject) consume.
    expect(resolution.binding).toEqual({
      sourceId: "hi-parcels",
      protocol: "ogc_features",
      locator: { url: "/api/ogc", collectionId: "hi-parcels" },
    });
  });

  it("honours a custom base URL without doubling the slash", () => {
    const resolution = resolveCompositionSource(layer({ id: "hi-wells", sourceId: "hi-wells" }), {
      catalog: CATALOG,
      baseUrl: "https://demo.honua.io/api/",
    });
    expect(isCompositionSourceResolution(resolution)).toBe(true);
    if (!isCompositionSourceResolution(resolution)) return;
    expect(resolution.source.data).toBe("https://demo.honua.io/api/ogc/collections/hi-wells/items?f=json&limit=2000");
    expect(resolution.layerType).toBe("circle");
  });

  it("projects a GeoServices feature service onto a f=geojson query", () => {
    const resolution = resolveCompositionSource(layer({ id: "hi-roads", sourceId: "hi-roads" }), { catalog: CATALOG });
    expect(isCompositionSourceResolution(resolution)).toBe(true);
    if (!isCompositionSourceResolution(resolution)) return;
    expect(resolution.layerType).toBe("line");
    expect(String(resolution.source.data)).toContain("/rest/services/hi-roads/FeatureServer/0/query");
    expect(String(resolution.source.data)).toContain("f=geojson");
    expect(resolution.binding?.protocol).toBe("geoservices_feature_service");
  });

  it("reports — rather than silently drops — a raster source, an unknown protocol, and an uncatalogued source", () => {
    for (const [sourceId, fragment] of [
      ["hi-imagery", "renders vector sources only"],
      ["hi-mystery", 'protocol "smoke-signals"'],
      ["hi-nothing", "not in the catalog"],
    ] as const) {
      const resolution = resolveCompositionSource(layer({ id: sourceId, sourceId }), { catalog: CATALOG });
      expect(isCompositionSourceResolution(resolution)).toBe(false);
      if (isCompositionSourceResolution(resolution)) return;
      expect(resolution.reason).toContain(fragment);
    }
  });

  it("lets a layer's own metadata.honua.source win outright — the GP/StudioAgentSession seam", () => {
    const resolution = resolveCompositionSource(
      layer({
        id: "gp-output",
        sourceId: "gp-output",
        metadata: {
          honua: {
            source: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
            layerType: "circle",
          },
        },
      }),
      // No catalog at all: the override must not need one.
      {},
    );
    expect(isCompositionSourceResolution(resolution)).toBe(true);
    if (!isCompositionSourceResolution(resolution)) return;
    expect(resolution.layerType).toBe("circle");
    expect(resolution.source.type).toBe("geojson");
  });

  it("maps geometry spellings — singular, Multi-prefixed, and Esri-ish — onto layer archetypes", () => {
    expect(layerTypeForGeometry("MultiPolygon")).toBe("fill");
    expect(layerTypeForGeometry("esriGeometryPolyline")).toBe("line");
    expect(layerTypeForGeometry("MultiPoint")).toBe("circle");
    expect(layerTypeForGeometry("Raster")).toBe("raster");
    expect(layerTypeForGeometry("TesseractMesh")).toBeUndefined();
    expect(layerTypeForGeometry(undefined)).toBeUndefined();
  });
});

describe("explicit discovered locators", () => {
  it("uses actual GeoServices service URL and layer 7 instead of guessing layer zero", () => {
    const result = resolveCompositionSource(layer({ id: "roads", sourceId: "service/7" }), {
      catalog: [
        {
          id: "service/7",
          protocol: "geoservices-feature-service",
          geometryType: "LineString",
          locator: { url: "https://host/rest/services/ActualName/FeatureServer", layerId: 7, serviceId: "service" },
        },
      ],
    });
    expect(result).toMatchObject({
      layerType: "line",
      binding: { locator: { layerId: 7 } },
      source: {
        data: "https://host/rest/services/ActualName/FeatureServer/7/query?where=1%3D1&outFields=*&f=geojson&resultRecordCount=2000",
      },
    });
  });

  it("uses an explicit OGC collection identity at the actual /ogc/features route", () => {
    const result = resolveCompositionSource(layer({ id: "points", sourceId: "catalog-key" }), {
      catalog: [
        {
          id: "catalog-key",
          protocol: "ogc-features",
          geometryType: "Point",
          locator: { url: "/ogc/features/", collectionId: "real collection" },
        },
      ],
    });
    expect(result).toMatchObject({
      layerType: "circle",
      source: { data: "/ogc/features/collections/real%20collection/items?f=json&limit=2000" },
    });
  });

  it.each([undefined, "Geometry", "Unknown"])("does not invent polygon geometry for %s", (geometryType) => {
    expect(
      resolveCompositionSource(layer({ id: "x", sourceId: "x" }), {
        catalog: [{ id: "x", protocol: "ogc-features", geometryType }],
      }),
    ).toMatchObject({ reason: expect.stringContaining("no supported geometry") });
  });

  it("resolves older bare service references only when exactly one real layer matches", () => {
    const entry = {
      id: "service/7",
      protocol: "geoservices-feature-service",
      geometryType: "Point",
      locator: { url: "/rest/services/Actual/FeatureServer", layerId: 7, serviceId: "service" },
    };
    expect(
      isCompositionSourceResolution(
        resolveCompositionSource(layer({ id: "old", sourceId: "service" }), { catalog: [entry] }),
      ),
    ).toBe(true);
    expect(
      isCompositionSourceResolution(
        resolveCompositionSource(layer({ id: "old", sourceId: "service" }), {
          catalog: [entry, { ...entry, id: "service/8", locator: { ...entry.locator, layerId: 8 } }],
        }),
      ),
    ).toBe(false);
  });

  it("refuses an explicit locator missing its layer identity instead of guessing", () => {
    expect(
      resolveCompositionSource(layer({ id: "x", sourceId: "x" }), {
        catalog: [
          {
            id: "x",
            protocol: "geoservices-feature-service",
            geometryType: "Point",
            locator: { url: "/rest/services/x/FeatureServer" },
          },
        ],
      }),
    ).toMatchObject({ reason: expect.stringContaining("no valid layer id") });
  });
});

describe("layer URL identity", () => {
  it("accepts a layer URL without appending the layer id twice and rejects a contradiction", () => {
    const catalog = [
      {
        id: "layer",
        protocol: "geoservices-feature-service",
        geometryType: "Point",
        locator: { url: "/rest/services/Actual/FeatureServer/7", layerId: 7 },
      },
    ];
    expect(resolveCompositionSource(layer({ id: "layer", sourceId: "layer" }), { catalog })).toMatchObject({
      source: { data: expect.stringContaining("/FeatureServer/7/query?") },
    });
    expect(
      resolveCompositionSource(layer({ id: "layer", sourceId: "layer" }), {
        catalog: [{ ...catalog[0], locator: { ...catalog[0]?.locator, layerId: 8 } }],
      }),
    ).toMatchObject({ reason: expect.stringContaining("conflicting layer identities") });
  });
});
