import { describe, expect, it, vi } from "vitest";

import { readCompositionBody } from "../../src/lifecycle/composition-draft-store.js";
import { fetchAuthenticatedFeatureCollection } from "../../src/map/authenticated-source-protocol.js";
import type {
  CompositionMapFactory,
  CompositionMapFactoryOptions,
  CompositionMapLike,
} from "../../src/map/composition-map-view.js";
import { compositionToMapPackage } from "../../src/map/map-package-projection.js";
import { createReadOnlyMapCanvas } from "../../src/map/read-only-map-canvas.js";

const catalog = [
  {
    id: "service/1",
    title: "Parcels",
    protocol: "geoservices-feature-service",
    geometryType: "GeometryCollection",
    locator: { serviceId: "service", layerId: 1, url: "/rest/services/parcels/FeatureServer" },
  },
];

function body() {
  return {
    layers: [{ id: "parcels", sourceId: "service/1", type: "fill", visible: true }],
    view: { center: [-157.85, 21.3], zoom: 10 },
  };
}

function mapHarness() {
  const captured: CompositionMapFactoryOptions[] = [];
  const remove = vi.fn();
  const listeners = new Map<string, (event: unknown) => void>();
  let features: readonly unknown[] = [{ id: 1 }];
  const map: CompositionMapLike = {
    setStyle: vi.fn(),
    jumpTo: vi.fn(),
    easeTo: vi.fn(),
    fitBounds: vi.fn(),
    on: vi.fn((type, listener) => listeners.set(type, listener)),
    off: vi.fn((type) => listeners.delete(type)),
    resize: vi.fn(),
    remove,
    queryRenderedFeatures: (_point, options) => (options?.layers?.includes("parcels") ? features : []),
  };
  const factory: CompositionMapFactory = async (options) => {
    captured.push(options);
    return map;
  };
  return {
    captured,
    factory,
    map,
    remove,
    setFeatures: (next: readonly unknown[]) => {
      features = next;
    },
    emit: (type: string) => listeners.get(type)?.({}),
  };
}

const container = {} as HTMLElement;

describe("read-only map canvas", () => {
  it.each([false, true])(
    "rejects ambiguous exact catalog sources regardless of order or saved source (reverse=%s)",
    (reverse) => {
      const duplicate = {
        ...catalog[0],
        locator: { ...catalog[0].locator, url: "/rest/services/different/FeatureServer" },
      };
      const currentCatalog = reverse ? [duplicate, ...catalog] : [...catalog, duplicate];
      for (const source of [
        { type: "geojson", data: "/rest/services/operator/FeatureServer/1/query?f=geojson" },
        { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      ]) {
        const state = readCompositionBody({
          ...body(),
          mapSpec: {
            version: 8,
            sources: { "service/1": source },
            layers: [{ id: "parcels", type: "fill", source: "service/1" }],
          },
        });
        const result = compositionToMapPackage(state, { catalog: currentCatalog, sourceAuthority: "current-reader" });
        expect(result.renderedLayerIds).toEqual([]);
        expect(result.mapPackage.mapSpec?.sources["service/1"]).toBeUndefined();
        expect(result.unresolved).toEqual([expect.objectContaining({ reason: expect.stringContaining("ambiguous") })]);
      }
    },
  );

  it("counts actual owned visual-editor render layers when the original primary layer was removed", async () => {
    const harness = mapHarness();
    const renderLayers = [
      { id: "basemap-land", type: "fill" },
      { id: "parcels-themed", type: "fill", source: "service/1", metadata: { "honua:compositionLayerId": "parcels" } },
    ];
    harness.map.getStyle = () => ({ layers: renderLayers });
    const query = vi.fn((_point, options) => (options?.layers?.includes("parcels-themed") ? [{ id: 1 }] : []));
    harness.map.queryRenderedFeatures = query;
    const canvas = await createReadOnlyMapCanvas({
      container,
      body: {
        ...body(),
        mapSpec: {
          version: 8,
          sources: { "service/1": { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
          layers: renderLayers.slice(1),
        },
      },
      projection: { catalog },
      mapFactory: harness.factory,
    });
    expect(canvas.renderedFeatureCount).toBe(1);
    expect(canvas.statusDetail).toBeUndefined();
    expect(harness.captured[0].style).toMatchObject({
      layers: expect.arrayContaining([expect.objectContaining({ id: "parcels-themed" })]),
    });
    expect(query).toHaveBeenLastCalledWith(undefined, { layers: ["parcels-themed"] });
    harness.map.getStyle = () => ({ layers: [] });
    expect(canvas.renderedFeatureCount).toBe(0);
    canvas.dispose();
  });

  it("counts a primary and its automatic outline once, but retains an outline-only visual", async () => {
    const harness = mapHarness();
    const primary = { id: "parcels", type: "fill", source: "service/1" };
    const outline = { id: "parcels__outline", type: "line", source: "service/1" };
    let visualLayers = [primary, outline];
    harness.map.getStyle = () => ({ layers: visualLayers });
    const query = vi.fn(
      (_point, options) => options?.layers?.map((id: string) => ({ id: 1, source: "service/1", layer: { id } })) ?? [],
    );
    harness.map.queryRenderedFeatures = query;
    const canvas = await createReadOnlyMapCanvas({
      container,
      body: {
        ...body(),
        mapSpec: {
          version: 8,
          sources: { "service/1": { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
          layers: [primary, outline],
        },
      },
      projection: { catalog },
      mapFactory: harness.factory,
    });
    expect(canvas.renderedFeatureCount).toBe(1);
    expect(query).toHaveBeenLastCalledWith(undefined, { layers: ["parcels", "parcels__outline"] });
    visualLayers = [outline];
    expect(canvas.renderedFeatureCount).toBe(1);
    expect(query).toHaveBeenLastCalledWith(undefined, { layers: ["parcels__outline"] });
    canvas.dispose();
  });

  it("deduplicates a feature across thematic and label visuals while retaining disjoint hits", async () => {
    const harness = mapHarness();
    const primary = { id: "parcels", type: "fill", source: "service/1" };
    const label = {
      id: "parcels-labels",
      type: "symbol",
      source: "service/1",
      metadata: { "honua:compositionLayerId": "parcels" },
    };
    harness.map.getStyle = () => ({ layers: [primary, label] });
    const query = vi.fn(() => [
      { id: 1, source: "service/1", layer: { id: "parcels" } },
      { id: 1, source: "service/1", layer: { id: "parcels-labels" } },
      { id: 2, source: "service/1", layer: { id: "parcels-labels" } },
      {
        source: "service/1",
        layer: { id: "parcels" },
        geometry: { type: "Point", coordinates: [1, 2] },
        properties: { name: "idless" },
      },
      {
        source: "service/1",
        layer: { id: "parcels-labels" },
        geometry: { type: "Point", coordinates: [1, 2] },
        properties: { name: "idless" },
      },
    ]);
    harness.map.queryRenderedFeatures = query;
    const canvas = await createReadOnlyMapCanvas({
      container,
      body: {
        ...body(),
        mapSpec: {
          version: 8,
          sources: { "service/1": { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
          layers: [primary, label],
        },
      },
      projection: { catalog },
      mapFactory: harness.factory,
    });
    expect(canvas.renderedFeatureCount).toBe(3);
    expect(query).toHaveBeenCalledWith(undefined, { layers: ["parcels", "parcels-labels"] });
    canvas.dispose();
  });

  it("rebinds a full authored Maputnik style while retaining layers, inline style and durable bindings", async () => {
    const harness = mapHarness();
    const oldUrl = "/api/operator/rest/services/old/FeatureServer/1/query?f=geojson";
    const published = {
      layers: [{ id: "parcels", sourceId: "service/1", type: "fill", visible: true, styleRef: "inline" }],
      view: { center: [-157.85, 21.3], zoom: 10 },
      sourceBindings: [
        { sourceId: "service/1", protocol: "geoservices_feature_service", locator: { url: oldUrl, layerId: 1 } },
      ],
      styleRefs: [{ styleId: "inline", body: { thematic: { paint: { "fill-color": "#224466" } } } }],
      mapSpec: {
        version: 8,
        sources: {
          "service/1": { type: "geojson", data: oldUrl },
          inset: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
        },
        layers: [
          { id: "background", type: "background", paint: { "background-color": "#fafafa" } },
          { id: "inset", type: "circle", source: "inset", paint: { "circle-radius": 3 } },
          {
            id: "thematic",
            type: "fill",
            source: "service/1",
            filter: ["==", ["get", "kind"], "park"],
            paint: { "fill-color": "#112233", "fill-opacity": 0.65 },
            layout: { visibility: "visible" },
            metadata: { "honua:compositionLayerId": "parcels", authored: true },
          },
          {
            id: "labels",
            type: "symbol",
            source: "service/1",
            layout: { "text-field": ["get", "name"] },
            paint: { "text-color": "#334455" },
            metadata: { "honua:compositionLayerId": "parcels" },
          },
        ],
      },
    };
    const original = structuredClone(published);
    const canvas = await createReadOnlyMapCanvas({
      container,
      body: published,
      projection: { catalog, sourceAuthority: "authored" },
      mapFactory: harness.factory,
    });
    const style = harness.captured[0].style;
    expect(style.sources["service/1"]).toEqual({
      type: "geojson",
      data: "/rest/services/parcels/FeatureServer/1/query?where=1%3D1&outFields=*&f=geojson&resultRecordCount=2000",
    });
    expect(harness.captured[0].anonymousStyleResources).toBe(true);
    expect(harness.captured[0].authorizedFeatureUrls).toEqual([
      "/rest/services/parcels/FeatureServer/1/query?where=1%3D1&outFields=*&f=geojson&resultRecordCount=2000",
    ]);
    expect(style.sources.inset).toEqual(original.mapSpec.sources.inset);
    expect(style.layers.map((layer) => layer.id)).toEqual(["background", "inset", "thematic", "labels"]);
    expect(style.layers[2]).toMatchObject({
      filter: ["==", ["get", "kind"], "park"],
      paint: { "fill-color": "#224466", "fill-opacity": 0.65 },
      layout: { visibility: "visible" },
      metadata: { "honua:compositionLayerId": "parcels", authored: true },
    });
    expect(style.layers[3]).toMatchObject({
      layout: { "text-field": ["get", "name"] },
      paint: { "text-color": "#334455" },
    });
    expect(harness.captured[0].center).toEqual([-157.85, 21.3]);
    expect(canvas.projection?.mapPackage.sourceBindings?.[0]?.locator.url).toBe(
      "/rest/services/parcels/FeatureServer/1",
    );
    expect(published).toEqual(original);
    expect(JSON.stringify(style)).not.toContain("/api/operator/");
    canvas.dispose();
  });

  it("omits denied catalog-owned layers and URL overrides while reporting the gap", async () => {
    const harness = mapHarness();
    const deniedUrl = "https://operator.example/private/query";
    const published = {
      layers: [
        {
          id: "parcels",
          sourceId: "service/1",
          type: "fill",
          visible: true,
          metadata: { honua: { source: { type: "geojson", data: deniedUrl } } },
        },
        {
          id: "secret",
          sourceId: "missing",
          type: "fill",
          visible: true,
          metadata: { honua: { source: { type: "geojson", data: deniedUrl } } },
        },
        { id: "static", sourceId: "static", type: "circle", visible: true },
      ],
      view: {},
      mapSpec: {
        version: 8,
        sources: {
          "service/1": { type: "geojson", data: deniedUrl },
          missing: { type: "geojson", data: deniedUrl },
          static: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
          orphan: { type: "geojson", data: deniedUrl },
          publicBasemap: { type: "raster", tiles: ["https://tiles.example/{z}/{x}/{y}.png"], tileSize: 256 },
        },
        layers: [
          { id: "parcels", type: "fill", source: "service/1" },
          {
            id: "secret-fill",
            type: "fill",
            source: "missing",
            metadata: { "honua:compositionLayerId": "secret" },
          },
          { id: "static", type: "circle", source: "static" },
          { id: "orphan-render", type: "circle", source: "orphan" },
          { id: "public-basemap", type: "raster", source: "publicBasemap" },
        ],
      },
    };
    const canvas = await createReadOnlyMapCanvas({
      container,
      body: published,
      projection: { catalog },
      mapFactory: harness.factory,
    });
    const style = harness.captured[0].style;
    expect(style.layers.map((layer) => layer.id)).toEqual(["parcels", "static", "public-basemap"]);
    expect(Object.keys(style.sources).sort()).toEqual(["publicBasemap", "service/1", "static"]);
    expect(JSON.stringify(style)).not.toContain(deniedUrl);
    expect(canvas.projection?.renderedLayerIds).toEqual(["parcels", "static"]);
    expect(canvas.projection?.unresolved.map(({ layerId }) => layerId)).toContain("secret");
    expect(canvas.statusDetail).toContain("secret");
    expect(canvas.statusDetail).toContain("unavailable");
    canvas.dispose();
  });

  it.each([true, false])(
    "preserves an authorized sibling after a presentation-only failure, invalid first=%s",
    (invalidFirst) => {
      const valid = { id: "valid", sourceId: "service/1", type: "fill", visible: true };
      const invalid = { id: "unsupported", sourceId: "service/1", type: "symbol", visible: true };
      const saved = {
        layers: invalidFirst ? [invalid, valid] : [valid, invalid],
        view: {},
        mapSpec: {
          version: 8,
          sources: { "service/1": { type: "geojson", data: "/operator/private/query" } },
          layers: [
            { id: "valid", type: "fill", source: "service/1" },
            { id: "unsupported", type: "symbol", source: "service/1" },
          ],
        },
      };
      const original = structuredClone(saved);
      const projected = compositionToMapPackage(readCompositionBody(saved), {
        catalog,
        sourceAuthority: "current-reader",
      });
      expect(projected.renderedLayerIds).toEqual(["valid"]);
      expect(projected.unresolved).toMatchObject([
        { layerId: "unsupported", reason: expect.stringContaining("layer type") },
      ]);
      expect(projected.mapPackage.mapSpec.layers.map(({ id }) => id)).toEqual(["valid"]);
      expect(projected.mapPackage.mapSpec.sources["service/1"]).toMatchObject({
        type: "geojson",
        data: expect.stringContaining("/parcels/FeatureServer/1/query?"),
      });
      expect(projected.mapPackage.sourceBindings).toHaveLength(1);
      expect(JSON.stringify(projected.mapPackage)).not.toContain("/operator/private/");
      expect(saved).toEqual(original);
    },
  );

  it("still denies every sibling when their source definitions conflict", () => {
    const saved = {
      layers: [
        { id: "catalog", sourceId: "service/1", type: "fill", visible: true },
        {
          id: "inline",
          sourceId: "service/1",
          type: "fill",
          visible: true,
          metadata: { honua: { source: { type: "geojson", data: { type: "FeatureCollection", features: [] } } } },
        },
      ],
      view: {},
    };
    const projected = compositionToMapPackage(readCompositionBody(saved), {
      catalog,
      sourceAuthority: "current-reader",
    });
    expect(projected.renderedLayerIds).toEqual([]);
    expect(projected.mapPackage.mapSpec.sources["service/1"]).toBeUndefined();
    expect(projected.unresolved.map(({ layerId }) => layerId).sort()).toEqual(["catalog", "inline"]);
    expect(projected.mapPackage.sourceBindings).toEqual([]);
  });

  it("rebinds only GeoJSON authority while preserving safe source options for shared authored layers", () => {
    const options = {
      cluster: true,
      clusterRadius: 45,
      clusterMaxZoom: 12,
      clusterMinPoints: 3,
      clusterProperties: { total: ["+", ["get", "population"]] },
      generateId: false,
      promoteId: "parcel_id",
      attribution: "Parcel data provider",
      lineMetrics: true,
      filter: ["!=", ["get", "retired"], true],
    };
    const saved = {
      layers: [
        { id: "points", sourceId: "service/1", type: "circle", visible: true },
        { id: "outlines", sourceId: "service/1", type: "line", visible: true },
      ],
      view: {},
      mapSpec: {
        version: 8,
        sources: {
          "service/1": {
            type: "geojson",
            data: "/operator/private/query",
            ...options,
            url: "https://operator.invalid/private",
            tiles: ["https://operator.invalid/{z}"],
            credentials: "include",
          },
        },
        layers: [
          { id: "points", type: "circle", source: "service/1" },
          { id: "outlines", type: "line", source: "service/1" },
        ],
      },
    };
    const original = structuredClone(saved);
    const projected = compositionToMapPackage(readCompositionBody(saved), {
      catalog,
      sourceAuthority: "current-reader",
    });
    const source = projected.mapPackage.mapSpec.sources["service/1"];
    expect(projected.unresolved).toEqual([]);
    expect(projected.renderedLayerIds).toEqual(["points", "outlines"]);
    expect(source).toEqual({
      ...options,
      type: "geojson",
      data: expect.stringContaining("/parcels/FeatureServer/1/query?"),
    });
    expect(projected.mapPackage.sourceBindings).toHaveLength(1);
    expect(JSON.stringify(projected.mapPackage)).not.toContain("operator");
    expect(saved).toEqual(original);
    if (source.type !== "geojson") throw new Error("Expected a GeoJSON source");
    expect(source.clusterProperties).not.toBe(saved.mapSpec.sources["service/1"].clusterProperties);
  });

  it("keeps the editor's authored projection unchanged unless audience mode is selected", () => {
    const saved = {
      ...body(),
      mapSpec: {
        version: 8,
        sources: { "service/1": { type: "geojson", data: "/saved/query" } },
        layers: [{ id: "parcels", type: "fill", source: "service/1" }],
      },
    };
    const projection = compositionToMapPackage(readCompositionBody(saved), { catalog });
    expect(projection.mapPackage.mapSpec.sources["service/1"]).toEqual(saved.mapSpec.sources["service/1"]);
  });

  it("retains explicit raster overrides for the audience on a separate anonymous asset transport", async () => {
    const raster = { type: "raster", tiles: ["https://tiles.example/{z}/{x}/{y}.png"], tileSize: 256 };
    const published = {
      layers: [
        { id: "imagery", sourceId: "imagery", type: "raster", visible: true, metadata: { honua: { source: raster } } },
      ],
      view: {},
      mapSpec: {
        version: 8,
        sources: { imagery: raster },
        layers: [{ id: "imagery", type: "raster", source: "imagery" }],
      },
    };
    expect(compositionToMapPackage(readCompositionBody(published)).mapPackage.mapSpec.sources.imagery).toEqual(raster);
    const harness = mapHarness();
    const canvas = await createReadOnlyMapCanvas({ container, body: published, mapFactory: harness.factory });
    expect(harness.captured[0].style.sources.imagery).toEqual(raster);
    expect(harness.captured[0].style.layers.map((layer) => layer.id)).toContain("imagery");
    expect(harness.captured[0].anonymousStyleResources).toBe(true);
    expect(harness.captured[0].authorizedFeatureUrls).toEqual([]);
    expect(canvas.projection?.unresolved).toEqual([]);
    canvas.dispose();
  });

  it("omits invalid vector source-layer renders while keeping approved GeoJSON siblings", async () => {
    const harness = mapHarness();
    const canvas = await createReadOnlyMapCanvas({
      container,
      projection: { catalog },
      mapFactory: harness.factory,
      body: {
        layers: [{ id: "parcels", sourceId: "service/1", type: "fill", visible: true }],
        view: {},
        mapSpec: {
          version: 8,
          sources: {
            "service/1": { type: "vector", tiles: ["https://old.example/parcels/{z}/{x}/{y}.pbf"] },
            basemap: { type: "raster", tiles: ["https://tiles.example/{z}/{x}/{y}.png"], tileSize: 256 },
          },
          layers: [
            { id: "base", type: "raster", source: "basemap" },
            {
              id: "thematic",
              type: "fill",
              source: "service/1",
              "source-layer": "parcel-tiles",
              paint: { "fill-color": "#224466" },
              metadata: { "honua:compositionLayerId": "parcels" },
            },
            {
              id: "labels",
              type: "symbol",
              source: "service/1",
              metadata: { "honua:compositionLayerId": "parcels" },
            },
          ],
        },
      },
    });
    expect(harness.captured[0].style.layers.map((layer) => layer.id)).toEqual(["base", "labels"]);
    expect(canvas.projection?.mapPackage.mapSpec.sources["service/1"]).toEqual({
      type: "geojson",
      data: "/rest/services/parcels/FeatureServer/1/query?where=1%3D1&outFields=*&f=geojson&resultRecordCount=2000",
    });
    expect(harness.captured[0].style.sources).toHaveProperty("basemap");
    expect(canvas.projection?.renderedLayerIds).toEqual(["parcels"]);
    expect(canvas.projection?.unresolved).toMatchObject([{ layerId: "thematic", sourceId: "service/1" }]);
    expect(canvas.statusDetail).toContain("thematic");
    canvas.dispose();
  });

  it("notifies hosts after asynchronous features paint and camera changes, then detaches on disposal", async () => {
    const harness = mapHarness();
    harness.setFeatures([]);
    const counts: number[] = [];
    const canvas = await createReadOnlyMapCanvas({
      container,
      body: body(),
      projection: { catalog },
      mapFactory: harness.factory,
      onChange: (current) => counts.push(current.renderedFeatureCount),
    });
    expect(counts).toEqual([0]);
    harness.setFeatures([{ id: 1 }]);
    harness.emit("idle");
    expect(counts).toEqual([0, 1]);
    harness.setFeatures([]);
    harness.emit("idle");
    expect(counts).toEqual([0, 1, 0]);
    canvas.dispose();
    harness.emit("idle");
    expect(counts).toEqual([0, 1, 0]);
  });

  it("keeps editor state private and refuses feature reads without a current reader", async () => {
    const harness = mapHarness();
    const canvas = await createReadOnlyMapCanvas({
      container,
      body: body(),
      projection: { catalog, baseUrl: "/api" },
      mapFactory: harness.factory,
    });
    expect(canvas.status).toBe("ready");
    expect(canvas.projection?.unresolved).toEqual([]);
    expect(canvas.projection?.renderedLayerIds).toContain("parcels");
    expect(canvas.renderedFeatureCount).toBe(1);
    expect(harness.captured[0].getAuth).toBeTypeOf("function");
    const reader = harness.captured[0].getAuth?.();
    expect(reader).toBe(harness.captured[0].getAuth?.());
    expect(await reader?.getAccessToken()).toBeUndefined();
    await expect(reader?.fetchRequest?.("/rest/services/parcels/FeatureServer/1/query?f=geojson")).rejects.toThrow(
      "Current-reader map transport is unavailable",
    );
    expect(canvas).not.toHaveProperty("controller");
    canvas.dispose();
  });

  it("uses a stable tokenless adapter for a map-only host's current-reader fetchRequest", async () => {
    const harness = mapHarness();
    const fetchRequest = vi.fn(async () => Response.json({ type: "FeatureCollection", features: [] }));
    const hostReader = { fetchRequest };
    const canvas = await createReadOnlyMapCanvas({
      container,
      body: body(),
      projection: { catalog, baseUrl: "/api" },
      getAuth: () => hostReader,
      mapFactory: harness.factory,
    });
    const getAuth = harness.captured[0].getAuth;
    expect(getAuth?.()).toBe(getAuth?.());
    const result = await fetchAuthenticatedFeatureCollection(
      "https://viewer.test/rest/services/parcels/FeatureServer/1/query?f=geojson",
      { sourceBaseUrl: "https://viewer.test/api", documentUrl: "https://viewer.test/", getAuth: getAuth! },
      new AbortController().signal,
    );
    expect(result).toEqual({ type: "FeatureCollection", features: [] });
    expect(fetchRequest).toHaveBeenCalledOnce();
    expect(fetchRequest).toHaveBeenCalledWith(
      "https://viewer.test/rest/services/parcels/FeatureServer/1/query?f=geojson",
      expect.objectContaining({ credentials: "omit", headers: {} }),
    );
    canvas.dispose();
  });

  it("keeps the requested immutable snapshot when the caller edits its object during startup", async () => {
    const original = body();
    const harness = mapHarness();
    const pending = createReadOnlyMapCanvas({
      container,
      body: original,
      projection: { catalog },
      mapFactory: harness.factory,
    });
    original.layers[0].sourceId = "different/2";
    const canvas = await pending;
    expect(canvas.projection?.unresolved).toEqual([]);
    expect(canvas.projection?.renderedLayerIds).toContain("parcels");
    canvas.dispose();
  });

  it("does not retarget a pending render when another view changes its source locator", async () => {
    const descriptors = structuredClone(catalog);
    const harness = mapHarness();
    const pending = createReadOnlyMapCanvas({
      container,
      body: body(),
      projection: { catalog: descriptors },
      mapFactory: harness.factory,
    });
    descriptors[0].locator.url = "/rest/services/different/FeatureServer";
    const canvas = await pending;
    expect(canvas.projection?.mapPackage.sourceBindings?.[0]?.locator.url).toBe(
      "/rest/services/parcels/FeatureServer/1",
    );
    const style = JSON.stringify(harness.captured[0].style);
    expect(style).toContain("parcels");
    expect(style).not.toContain("different");
    canvas.dispose();
  });

  it.each([null, { mapSpec: { layers: [] } }, { layers: "not-an-array" }])(
    "refuses an incompatible body before rendering instead of displaying an empty replacement",
    async (invalid) => {
      const harness = mapHarness();
      await expect(
        createReadOnlyMapCanvas({ container, body: invalid, mapFactory: harness.factory }),
      ).rejects.toThrow();
      expect(harness.captured).toEqual([]);
    },
  );

  it("refuses a missing canonical style reader rather than silently substituting a preset", async () => {
    const harness = mapHarness();
    const original = { ...body(), layers: [{ ...body().layers[0], styleRef: "parcels-style" }] };
    await expect(
      createReadOnlyMapCanvas({
        container,
        body: original,
        projection: { catalog },
        mapFactory: harness.factory,
      }),
    ).rejects.toThrow("authoritative style reader");
    expect(harness.captured).toEqual([]);
  });

  it("keeps a styled current-reader layer while omitting a denied styled layer without reading its style", async () => {
    const harness = mapHarness();
    const bind = vi.fn(async () => ({
      definition: {
        styleId: "allowed-style",
        title: "Allowed",
        description: "Reader style",
        styleVersion: 1,
        sha256: "hash",
        inlineBody: "{}",
        serverRoot: "https://viewer.test",
        observedAt: "2026-10-20T00:00:00Z",
        layers: [],
      },
      sourceId: "service/1",
      descriptorSha256: "descriptor-hash",
      descriptorBody: "{}",
      stylesheetLayerId: "allowed",
      fields: [],
      override: { paint: { "fill-color": "#123456" } },
    }));
    const getAuth = vi.fn(() => undefined);
    const canvas = await createReadOnlyMapCanvas({
      container,
      body: {
        layers: [
          { id: "parcels", sourceId: "service/1", type: "fill", visible: true, styleRef: "allowed-style" },
          { id: "secret", sourceId: "denied", type: "fill", visible: true, styleRef: "denied-style" },
        ],
        view: {},
      },
      projection: { catalog },
      mapFactory: harness.factory,
      styleProvider: { bind, sessionIdentity: undefined },
      getAuth,
    });
    expect(bind).toHaveBeenCalledExactlyOnceWith("allowed-style", catalog[0]);
    expect(getAuth).not.toHaveBeenCalled();
    expect(canvas.projection?.renderedLayerIds).toEqual(["parcels"]);
    expect(canvas.projection?.unresolved).toMatchObject([{ layerId: "secret", sourceId: "denied" }]);
    expect(canvas.statusDetail).toContain("secret");
    expect(harness.captured[0].authorizedFeatureUrls).toEqual([
      "/rest/services/parcels/FeatureServer/1/query?where=1%3D1&outFields=*&f=geojson&resultRecordCount=2000",
    ]);
    expect(JSON.stringify(harness.captured[0].style)).not.toContain("denied-style");
    canvas.dispose();
  });

  it("renders an embedded canonical style without requiring a catalog reader", async () => {
    const harness = mapHarness();
    const canvas = await createReadOnlyMapCanvas({
      container,
      body: {
        ...body(),
        layers: [{ ...body().layers[0], styleRef: "parcels-style" }],
        styleRefs: [{ styleId: "parcels-style", body: { parcels: { paint: { "fill-color": "#123456" } } } }],
      },
      projection: { catalog },
      mapFactory: harness.factory,
    });
    expect(canvas.projection?.unresolved).toEqual([]);
    expect(canvas.projection?.mapPackage.styleRefs?.[0]?.body?.parcels.paint?.["fill-color"]).toBe("#123456");
    expect(JSON.stringify(harness.captured[0].style)).toContain("#123456");
    expect(JSON.stringify(harness.captured[0].style)).not.toContain("honua:styleRefFallback");
    canvas.dispose();
  });

  it("refuses unresolved external style references even when a provider is present", async () => {
    const harness = mapHarness();
    const bind = vi.fn(async () => {
      throw new Error("No authoritative catalog for this source");
    });
    await expect(
      createReadOnlyMapCanvas({
        container,
        body: { ...body(), layers: [{ ...body().layers[0], styleRef: "external-style" }] },
        projection: {
          catalog: catalog.map((source) => ({ ...source, locator: { url: source.locator.url, layerId: 1 } })),
        },
        mapFactory: harness.factory,
        styleProvider: { bind, sessionIdentity: undefined },
      }),
    ).rejects.toThrow("an authoritative style reader for their source");
    expect(bind).not.toHaveBeenCalled();
    expect(harness.captured).toEqual([]);
  });

  it("refuses a live catalog style on an overridden source even when its id matches the catalog", async () => {
    const harness = mapHarness();
    const bind = vi.fn(async () => {
      throw new Error("Overridden sources cannot inherit catalog authority");
    });
    await expect(
      createReadOnlyMapCanvas({
        container,
        body: {
          ...body(),
          layers: [
            {
              ...body().layers[0],
              styleRef: "shared-style",
              metadata: { honua: { source: { type: "geojson", data: { type: "FeatureCollection", features: [] } } } },
            },
          ],
        },
        projection: { catalog },
        mapFactory: harness.factory,
        styleProvider: { bind, sessionIdentity: undefined },
      }),
    ).rejects.toThrow("an authoritative style reader for their source");
    expect(bind).not.toHaveBeenCalled();
    expect(harness.captured).toEqual([]);
  });

  it("reports renderer failure without claiming a ready map or rendered features", async () => {
    const canvas = await createReadOnlyMapCanvas({
      container,
      body: body(),
      projection: { catalog },
      mapFactory: async () => {
        throw new Error("WebGL unavailable");
      },
    });
    expect(canvas.status).toBe("unavailable");
    expect(canvas.statusDetail).toBe("WebGL unavailable");
    expect(canvas.renderedFeatureCount).toBe(0);
    canvas.dispose();
  });

  it("releases the audience canvas on disposal and stops reporting features from its old map", async () => {
    const harness = mapHarness();
    const canvas = await createReadOnlyMapCanvas({
      container,
      body: body(),
      projection: { catalog },
      mapFactory: harness.factory,
    });
    expect(canvas.renderedFeatureCount).toBe(1);
    canvas.dispose();
    expect(harness.remove).toHaveBeenCalledOnce();
    expect(canvas.renderedFeatureCount).toBe(0);
    expect(canvas.status).toBe("idle");
  });
});
