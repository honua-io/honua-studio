/**
 * The feature-loader seam (honua-studio#24 REQ-001).
 *
 * The load-bearing assertion is the first one: the URL a widget fetches is
 * the URL the *map* resolves for the same source. If these two ever diverge,
 * a grid and the map beneath it would be showing different data with no
 * visible sign of it.
 */
import { describe, expect, it, vi } from "vitest";

import { resolveCompositionSource } from "../../src/map/source-resolution.js";
import {
  createCatalogWidgetDataLoader,
  formatCellValue,
  inferColumns,
  rowsFromFeatureCollection,
} from "../../src/widgets/widget-data.js";

const CATALOG = [
  { id: "hi-parcels", title: "Parcels", protocol: "ogc-features", geometryType: "Polygon" },
  { id: "hi-roads", title: "Roads", protocol: "geoservices-feature-service", geometryType: "LineString" },
  { id: "hi-imagery", title: "Imagery", protocol: "stac", geometryType: "Raster" },
];

function featureCollection(count: number, numberMatched?: number) {
  return {
    type: "FeatureCollection",
    features: Array.from({ length: count }, (_, index) => ({
      type: "Feature",
      id: index + 1,
      properties: { parcel_id: `TMK-${index}`, district: index % 2 === 0 ? "Honolulu" : "ʻEwa" },
      geometry: { type: "Point", coordinates: [0, 0] },
    })),
    ...(numberMatched !== undefined ? { numberMatched } : {}),
  };
}

function fakeFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("widgets/widget-data", () => {
  it("fetches the same URL the map resolves for that source", async () => {
    const fetchImpl = fakeFetch(featureCollection(2));
    const loader = createCatalogWidgetDataLoader({ catalog: CATALOG, baseUrl: "/api", featureLimit: 500, fetchImpl });
    await loader("hi-parcels");

    const mapResolution = resolveCompositionSource(
      { id: "hi-parcels", sourceId: "hi-parcels", visible: true },
      { catalog: CATALOG, baseUrl: "/api", featureLimit: 500 },
    );
    expect("source" in mapResolution).toBe(true);
    if (!("source" in mapResolution)) return;
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe(mapResolution.source.data);
  });

  it("flattens features to rows carrying their id and properties, dropping geometry", async () => {
    const loader = createCatalogWidgetDataLoader({ catalog: CATALOG, fetchImpl: fakeFetch(featureCollection(2)) });
    const result = await loader("hi-parcels");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([
      { featureId: 1, properties: { parcel_id: "TMK-0", district: "Honolulu" } },
      { featureId: 2, properties: { parcel_id: "TMK-1", district: "ʻEwa" } },
    ]);
    expect(result.truncated).toBe(false);
  });

  it("reports truncation when the server matched more than it returned", async () => {
    const loader = createCatalogWidgetDataLoader({ catalog: CATALOG, fetchImpl: fakeFetch(featureCollection(2, 900)) });
    const result = await loader("hi-parcels");
    expect(result.ok && result).toMatchObject({ truncated: true, total: 900 });
  });

  it("memoizes per source so a grid and a chart on the same dataset cost one fetch", async () => {
    const fetchImpl = fakeFetch(featureCollection(1));
    const loader = createCatalogWidgetDataLoader({ catalog: CATALOG, fetchImpl });
    await Promise.all([loader("hi-parcels"), loader("hi-parcels")]);
    await loader("hi-parcels");
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
  });

  it("reports an unresolvable source instead of throwing", async () => {
    const loader = createCatalogWidgetDataLoader({ catalog: CATALOG, fetchImpl: fakeFetch({}) });
    const missing = await loader("nope");
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reason).toContain("not in the catalog");

    const raster = await loader("hi-imagery");
    expect(raster.ok).toBe(false);
    if (raster.ok) return;
    expect(raster.reason).toContain("raster");
  });

  it("reports an HTTP failure and a non-FeatureCollection body", async () => {
    const failing = createCatalogWidgetDataLoader({
      catalog: CATALOG,
      fetchImpl: fakeFetch({}, { ok: false, status: 503 }),
    });
    const http = await failing("hi-parcels");
    expect(http.ok === false && http.reason).toContain("HTTP 503");

    const garbage = createCatalogWidgetDataLoader({ catalog: CATALOG, fetchImpl: fakeFetch({ hello: "world" }) });
    const parsed = await garbage("hi-parcels");
    expect(parsed.ok === false && parsed.reason).toContain("FeatureCollection");
  });

  it("caches a failure so a broken source cannot become a request storm", async () => {
    const fetchImpl = fakeFetch({}, { ok: false, status: 500 });
    const loader = createCatalogWidgetDataLoader({ catalog: CATALOG, fetchImpl });
    await loader("hi-parcels");
    await loader("hi-parcels");
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
  });

  it("infers columns in first-seen order across rows, bounded", () => {
    const parsed = rowsFromFeatureCollection({
      type: "FeatureCollection",
      features: [{ properties: { a: 1 } }, { properties: { a: 2, b: 3 } }],
    });
    expect(inferColumns(parsed?.rows ?? [])).toEqual(["a", "b"]);
    const wide = [{ properties: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`c${i}`, i])) }];
    expect(inferColumns(wide)).toHaveLength(8);
  });

  it("formats cell values without leaking [object Object]", () => {
    expect(formatCellValue(null)).toBe("");
    expect(formatCellValue(3)).toBe("3");
    expect(formatCellValue({ a: 1 })).toBe('{"a":1}');
  });
});
