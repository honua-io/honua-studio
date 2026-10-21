// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => {
  const listeners = new Map<string, (() => void)[]>();
  const protocols = new Map<string, (request: { url: string }, controller: AbortController) => Promise<unknown>>();
  const mapOptions: { transformRequest?: (url: string, type?: string) => { url: string } }[] = [];
  return {
    listeners,
    protocols,
    mapOptions,
    namespace: {
      setWorkerUrl: vi.fn(),
      addProtocol: vi.fn(
        (name: string, handler: (request: { url: string }, controller: AbortController) => Promise<unknown>) =>
          protocols.set(name, handler),
      ),
      removeProtocol: vi.fn((name: string) => protocols.delete(name)),
      Map: class {
        constructor(options: (typeof mapOptions)[number]) {
          mapOptions.push(options);
        }
        on(type: string, listener: () => void) {
          listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        }
        remove() {
          for (const listener of listeners.get("remove") ?? []) listener();
          listeners.delete("remove");
        }
      },
    },
  };
});

it.each(["Source", "Tile", undefined])(
  "refuses a catalog feature URL outside the reader trust root without anonymous fallback (type=%s)",
  async (resourceType) => {
    const feature = "https://console.test/api/operator/rest/services/parcels/FeatureServer/1/query?f=geojson";
    const tile = "https://tiles.test/basemap/0/0/0.png";
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1]).buffer));
    const getAccessToken = vi.fn(async () => undefined);
    const fetchRequest = vi.fn(async () => new Response("{}"));
    const map = await defaultCompositionMapFactory({
      container: document.createElement("div"),
      style: {
        version: 8,
        sources: {
          feature: { type: "geojson", data: feature },
          basemap: { type: "raster", tiles: [tile], tileSize: 256 },
        },
        layers: [],
      },
      center: [0, 0],
      zoom: 1,
      attributionText: "Test",
      getAuth: () => ({ getAccessToken, fetchRequest }),
      sourceBaseUrl: "https://console.test/api/studio/viewer/data",
      authorizedFeatureUrls: [feature],
      anonymousStyleResources: true,
    });
    try {
      const transform = runtime.mapOptions.at(-1)?.transformRequest;
      const denied = transform?.(feature, resourceType)?.url;
      expect(denied).toMatch(/^honua-public-\d+:\/\//);
      const scheme = denied?.split("://")[0] ?? "";
      await expect(runtime.protocols.get(scheme)?.({ url: denied! }, new AbortController())).rejects.toThrow();
      // Even a style asset which addresses this map's anonymous protocol
      // directly cannot bypass the outer transform's feature classification.
      await expect(
        runtime.protocols.get(scheme)?.({ url: `${scheme}://${encodeURIComponent(feature)}` }, new AbortController()),
      ).rejects.toThrow("Catalog features require the current-reader transport");
      expect(network).not.toHaveBeenCalled();
      expect(getAccessToken).not.toHaveBeenCalled();
      expect(fetchRequest).not.toHaveBeenCalled();
      const allowed = transform?.(tile, "Tile")?.url;
      await runtime.protocols.get(allowed?.split("://")[0] ?? "")?.({ url: allowed! }, new AbortController());
      expect(network).toHaveBeenCalledWith(tile, expect.objectContaining({ credentials: "omit" }));
    } finally {
      map.remove();
      network.mockRestore();
    }
  },
);

it.each([undefined, () => undefined])("refuses catalog reads with an absent reader (%s)", async (getAuth) => {
  const feature = "https://console.test/api/studio/viewer/data/rest/services/parcels/FeatureServer/1/query?f=geojson";
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected global fetch."));
  const map = await defaultCompositionMapFactory({
    container: document.createElement("div"),
    style: { version: 8, sources: { feature: { type: "geojson", data: feature } }, layers: [] },
    center: [0, 0],
    zoom: 1,
    attributionText: "Test",
    getAuth,
    sourceBaseUrl: "https://console.test/api/studio/viewer/data",
    authorizedFeatureUrls: [feature],
  });
  try {
    const admitted = runtime.mapOptions.at(-1)?.transformRequest?.(feature, "Source")?.url;
    expect(admitted).toMatch(/^honua-session-\d+:\/\//);
    await expect(
      runtime.protocols.get(admitted?.split("://")[0] ?? "")?.({ url: admitted! }, new AbortController()),
    ).rejects.toThrow("Current-reader map transport is unavailable");
    expect(network).not.toHaveBeenCalled();
  } finally {
    map.remove();
    network.mockRestore();
  }
});
// Deliberately no named runtime exports: the supported default namespace must own both Map and protocol hooks.
vi.mock("maplibre-gl", () => ({ default: runtime.namespace }));
vi.mock("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url", () => ({ default: "/test-worker.js" }));

import { defaultCompositionMapFactory } from "../../src/map/composition-map-view.js";

it("uses the default-only MapLibre namespace for authenticated source registration and removal", async () => {
  runtime.namespace.addProtocol.mockClear();
  runtime.namespace.removeProtocol.mockClear();
  const map = await defaultCompositionMapFactory({
    container: document.createElement("div"),
    style: { version: 8, sources: {}, layers: [] },
    center: [0, 0],
    zoom: 1,
    attributionText: "Test",
    getAuth: () => undefined,
    sourceBaseUrl: "/api",
  });
  expect(runtime.namespace.setWorkerUrl).toHaveBeenCalledWith("/test-worker.js");
  expect(runtime.namespace.addProtocol).toHaveBeenCalledTimes(1);
  expect(runtime.namespace.addProtocol.mock.calls[0]?.[1]).toBeTypeOf("function");
  map.remove();
  expect(runtime.namespace.removeProtocol).toHaveBeenCalledWith(runtime.namespace.addProtocol.mock.calls[0]?.[0]);
});
