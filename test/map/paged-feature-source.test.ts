import { expect, it, vi } from "vitest";
import { loadPagedFeatureSource } from "../../src/map/paged-feature-source.js";

it("uses the actual SDK adapter to page 2501 features and preserve their extent under a verified deployment", async () => {
  const target = new URL("https://host.test/honua/rest/services/roads/FeatureServer/0/query?f=geojson&where=1%3D1");
  const calls: URL[] = [];
  const onIncomplete = vi.fn();
  const auth = { getAccessToken: async () => "human-test-token" };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer human-test-token");
    expect(url.pathname.startsWith("/honua/rest/services/roads/FeatureServer/0")).toBe(true);
    if (!url.pathname.endsWith("/query")) return new Response(JSON.stringify({ id: 0, geometryType: "esriGeometryPoint", objectIdField: "id", fields: [{ name: "id", type: "esriFieldTypeOID" }] }));
    const offset = Number(url.searchParams.get("resultOffset") ?? 0);
    expect(url.searchParams.get("resultRecordCount")).toBe("2000");
    const count = Math.min(2000, 2501 - offset);
    return new Response(JSON.stringify({ geometryType: "esriGeometryPoint", spatialReference: { wkid: 4326 }, fields: [{ name: "id", type: "esriFieldTypeOID" }], features: Array.from({ length: count }, (_, n) => ({ attributes: { id: offset + n }, geometry: { x: (offset + n) / 100, y: 1 } })), exceededTransferLimit: offset + count < 2501 }));
  };
  const result = await loadPagedFeatureSource(target, { sourceBaseUrl: "/honua", documentUrl: "https://host.test/", getAuth: () => auth, fetchImpl, onIncomplete }, new AbortController().signal);
  expect(result.features).toHaveLength(2501);
  const features = result.features as { geometry: { coordinates: number[] } }[];
  expect(features[2500]!.geometry.coordinates).toEqual([25, 1]);
  expect(calls.filter((url) => url.pathname.endsWith("/query")).map((url) => Number(url.searchParams.get("resultOffset")))).toEqual([0, 2000]);
  expect(onIncomplete).not.toHaveBeenCalled();
});

it("rejects a source authority swap before publishing SDK feature bytes", async () => {
  let auth: { getAccessToken: () => Promise<string> } | undefined = { getAccessToken: async () => "first" };
  const target = new URL("https://host.test/rest/services/roads/FeatureServer/0/query?f=geojson");
  const fetchImpl: typeof fetch = async () => { auth = undefined; return new Response("{}"); };
  await expect(loadPagedFeatureSource(target, { sourceBaseUrl: "", documentUrl: "https://host.test/", getAuth: () => auth, fetchImpl }, new AbortController().signal)).rejects.toThrow();
});
