import { expect, it, vi } from "vitest";
import { loadPagedFeatureSource } from "../../src/map/paged-feature-source.js";

it("uses the actual SDK adapter to page 2501 features and preserve their extent under a verified deployment", async () => {
  const target = new URL("https://host.test/honua/rest/services/roads/FeatureServer/0/query?f=geojson&where=1%3D1");
  const calls: URL[] = [];
  const onIncomplete = vi.fn();
  const auth = { getAccessToken: async () => "human-test-token" };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer human-test-token");
    expect(url.pathname.startsWith("/honua/rest/services/roads/FeatureServer/0")).toBe(true);
    if (!url.pathname.endsWith("/query"))
      return new Response(
        JSON.stringify({
          id: 0,
          geometryType: "esriGeometryPoint",
          objectIdField: "id",
          fields: [{ name: "id", type: "esriFieldTypeOID" }],
        }),
      );
    const offset = Number(url.searchParams.get("resultOffset") ?? 0);
    expect(url.searchParams.get("resultRecordCount")).toBe("2000");
    const count = Math.min(2000, 2501 - offset);
    return new Response(
      JSON.stringify({
        geometryType: "esriGeometryPoint",
        spatialReference: { wkid: 4326 },
        fields: [{ name: "id", type: "esriFieldTypeOID" }],
        features: Array.from({ length: count }, (_, n) => ({
          attributes: { id: offset + n },
          geometry: { x: (offset + n) / 100, y: 1 },
        })),
        exceededTransferLimit: offset + count < 2501,
      }),
    );
  };
  const result = await loadPagedFeatureSource(
    target,
    { sourceBaseUrl: "/honua", documentUrl: "https://host.test/", getAuth: () => auth, fetchImpl, onIncomplete },
    new AbortController().signal,
  );
  expect(result.features).toHaveLength(2501);
  const features = result.features as { geometry: { coordinates: number[] } }[];
  expect(features[2500]!.geometry.coordinates).toEqual([25, 1]);
  expect(
    calls.filter((url) => url.pathname.endsWith("/query")).map((url) => Number(url.searchParams.get("resultOffset"))),
  ).toEqual([0, 2000]);
  expect(onIncomplete).not.toHaveBeenCalled();
});

it("rejects a source authority swap before publishing SDK feature bytes", async () => {
  let auth: { getAccessToken: () => Promise<string> } | undefined = { getAccessToken: async () => "first" };
  const target = new URL("https://host.test/rest/services/roads/FeatureServer/0/query?f=geojson");
  const fetchImpl: typeof fetch = async () => {
    auth = undefined;
    return new Response("{}");
  };
  await expect(
    loadPagedFeatureSource(
      target,
      { sourceBaseUrl: "", documentUrl: "https://host.test/", getAuth: () => auth, fetchImpl },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});

const renewalTarget = new URL("https://host.test/rest/services/roads/FeatureServer/0/query?f=geojson");
const layerMetadata = {
  id: 0,
  geometryType: "esriGeometryPoint",
  objectIdField: "id",
  fields: [{ name: "id", type: "esriFieldTypeOID" }],
};
const featurePage = {
  ...layerMetadata,
  spatialReference: { wkid: 4326 },
  features: [{ attributes: { id: 1 }, geometry: { x: 2, y: 3 } }],
  exceededTransferLimit: false,
};

it.each([
  [401, "metadata"],
  [499, "metadata"],
  [401, "query"],
  [499, "query"],
] as const)("refreshes once after %s on %s without losing the page", async (code, rejectedRoute) => {
  let token = "old-token";
  const auth = {
    getAccessToken: vi.fn(async (options?: { forceRefresh?: boolean }) => {
      if (options?.forceRefresh) token = "renewed-token";
      return token;
    }),
  };
  const rejectedRequests: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const query = new URL(String(input)).pathname.endsWith("/query");
    const header = new Headers(init?.headers).get("authorization");
    if (query === (rejectedRoute === "query")) {
      rejectedRequests.push(String(input));
      if (header === "Bearer old-token")
        return code === 401 ? new Response(null, { status: 401 }) : Response.json({ error: { code: 499 } });
      expect(header).toBe("Bearer renewed-token");
    }
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    return Response.json(query ? featurePage : layerMetadata);
  };
  const result = await loadPagedFeatureSource(
    renewalTarget,
    { sourceBaseUrl: "", documentUrl: "https://host.test/", getAuth: () => auth, fetchImpl },
    new AbortController().signal,
  );
  expect(result.features).toHaveLength(1);
  expect(rejectedRequests).toHaveLength(2);
  expect(rejectedRequests[0]).toBe(rejectedRequests[1]);
  expect(auth.getAccessToken.mock.calls.filter(([options]) => options?.forceRefresh)).toHaveLength(1);
});

it.each([401, 499])("stops a still-rejected query after one refresh for %s", async (code) => {
  const auth = { getAccessToken: vi.fn(async () => "rejected-token") };
  let queryCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (!new URL(String(input)).pathname.endsWith("/query")) return Response.json(layerMetadata);
    queryCalls++;
    return code === 401 ? new Response(null, { status: 401 }) : Response.json({ error: { code: 499 } });
  };
  await expect(
    loadPagedFeatureSource(
      renewalTarget,
      { sourceBaseUrl: "", documentUrl: "https://host.test/", getAuth: () => auth, fetchImpl },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(queryCalls).toBe(2);
  expect(auth.getAccessToken).toHaveBeenLastCalledWith({ forceRefresh: true });
});

it.each(["session", "abort"])("does not retry when %s changes during refresh", async (change) => {
  const abort = new AbortController();
  let active: typeof auth | undefined;
  const auth = {
    getAccessToken: vi.fn(async (options?: { forceRefresh?: boolean }) => {
      if (options?.forceRefresh) {
        if (change === "session") active = undefined;
        else abort.abort();
      }
      return "token";
    }),
  };
  active = auth;
  let queryCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    if (!new URL(String(input)).pathname.endsWith("/query")) return Response.json(layerMetadata);
    queryCalls++;
    return new Response(null, { status: 401 });
  };
  await expect(
    loadPagedFeatureSource(
      renewalTarget,
      { sourceBaseUrl: "", documentUrl: "https://host.test/", getAuth: () => active, fetchImpl },
      abort.signal,
    ),
  ).rejects.toThrow();
  expect(queryCalls).toBe(1);
});
