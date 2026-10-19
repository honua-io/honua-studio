import { afterEach, expect, it } from "vitest";
import { startMockServer } from "../../mock-server.mjs";
import { loadPagedFeatureSource } from "../../src/map/paged-feature-source.js";

let server: Awaited<ReturnType<typeof startMockServer>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

it.each([
  ["hi-parcels", 48, "Polygon"],
  ["hi-roads", 6, "LineString"],
  ["hi-wells", 20, "Point"],
])("renders %s through the published SDK and real fixture HTTP routes", async (id, count, geometryType) => {
  server = await startMockServer();
  const target = new URL(`${server.url}/rest/services/${id}/FeatureServer/0/query?f=geojson`);
  const result = await loadPagedFeatureSource(
    target,
    {
      sourceBaseUrl: server.url,
      documentUrl: server.url,
      getAuth: () => undefined,
    },
    new AbortController().signal,
  );
  const features = result.features as { properties: { OBJECTID: number }; geometry: { type: string } }[];
  expect(features).toHaveLength(count);
  expect(features[0]).toMatchObject({ properties: { OBJECTID: 1 }, geometry: { type: geometryType } });
});

it("serves distinct bounded pages with transfer-limit evidence and keeps GeoJSON reads", async () => {
  server = await startMockServer();
  const url = `${server.url}/rest/services/hi-parcels/FeatureServer/0/query`;
  const first = await (await fetch(`${url}?f=json&resultRecordCount=25`)).json();
  const second = await (await fetch(`${url}?f=json&resultRecordCount=25&resultOffset=25`)).json();
  expect(first.features).toHaveLength(25);
  expect(first.exceededTransferLimit).toBe(true);
  expect(second.features).toHaveLength(23);
  expect(second.exceededTransferLimit).toBe(false);
  expect(new Set([...first.features, ...second.features].map((feature) => feature.attributes.OBJECTID)).size).toBe(48);
  const geojson = await (await fetch(`${url}?f=geojson&resultRecordCount=2`)).json();
  expect(geojson).toMatchObject({ type: "FeatureCollection", numberReturned: 2 });
  expect(geojson.features).toHaveLength(2);
});
