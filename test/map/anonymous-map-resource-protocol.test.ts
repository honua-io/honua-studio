import type { AddProtocolAction, ResourceType } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";

import { installAnonymousMapResourceProtocol } from "../../src/map/anonymous-map-resource-protocol.js";
import { installAuthenticatedSourceProtocol } from "../../src/map/authenticated-source-protocol.js";

const documentUrl = "https://viewer.test/maps/123";
const tile = "https://tiles.example/1/2/3.png";
const feature = "https://viewer.test/rest/services/current/FeatureServer/1/query?f=geojson";

function registry() {
  const handlers = new Map<string, AddProtocolAction>();
  return {
    handlers,
    addProtocol: vi.fn((scheme: string, handler: AddProtocolAction) => handlers.set(scheme, handler)),
    removeProtocol: vi.fn((scheme: string) => handlers.delete(scheme)),
    run: (url: string, controller = new AbortController()) => {
      const scheme = url.slice(0, url.indexOf("://"));
      const handler = handlers.get(scheme);
      if (!handler) throw new Error(`No handler for ${scheme}`);
      return handler({ url }, controller);
    },
  };
}

describe("published anonymous map resources", () => {
  it("loads declared raster and basemap assets without touching a host bearer or cookies", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]).buffer, {
          headers: { "content-type": "image/png" },
        }),
    );
    const network = registry();
    const anonymous = installAnonymousMapResourceProtocol(network, {
      documentUrl,
      style: {
        version: 8,
        sources: {
          publicTiles: { type: "raster", tiles: ["https://tiles.example/{z}/{x}/{y}.png"], tileSize: 256 },
          basemap: { type: "raster", url: "/public/basemap.json", tileSize: 256 },
        },
        layers: [],
      },
      fetchImpl,
    });
    const transformed = anonymous.transformRequest(tile, "Tile" as ResourceType);
    expect(transformed?.url).toMatch(/^honua-public-\d+:\/\//);
    expect(await network.run(String(transformed?.url))).toEqual({ data: new Uint8Array([1, 2, 3]).buffer });
    expect(fetchImpl).toHaveBeenCalledWith(
      tile,
      expect.objectContaining({
        method: "GET",
        headers: {},
        credentials: "omit",
        redirect: "error",
      }),
    );
    const basemap = anonymous.transformRequest("/public/basemap.json", "Source" as ResourceType);
    expect(basemap?.url).toMatch(/^honua-public-\d+:\/\//);
    expect(anonymous.transformRequest("data:image/png;base64,aQ==", "Tile" as ResourceType)).toEqual({
      url: "data:image/png;base64,aQ==",
    });
    anonymous.dispose();
    expect(network.handlers.size).toBe(0);
  });

  it("refuses undeclared origins and oversized or redirected assets", async () => {
    const network = registry();
    const fetchImpl = vi.fn(async () => new Response("x", { status: 200, headers: { "content-length": "16777217" } }));
    const onError = vi.fn();
    const anonymous = installAnonymousMapResourceProtocol(network, {
      documentUrl,
      style: { version: 8, sources: { tiles: { type: "raster", tiles: [tile], tileSize: 256 } }, layers: [] },
      fetchImpl,
      onError,
    });
    const foreign = anonymous.transformRequest("https://foreign.test/private", "Tile" as ResourceType);
    await expect(network.run(String(foreign?.url))).rejects.toThrow("origin is not declared");
    expect(fetchImpl).not.toHaveBeenCalled();
    const allowed = anonymous.transformRequest(tile, "Tile" as ResourceType);
    await expect(network.run(String(allowed?.url))).rejects.toThrow("size limit");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://foreign.test" } }));
    await expect(network.run(String(allowed?.url))).rejects.toThrow("request failed (302)");
    expect(onError).toHaveBeenCalledTimes(3);
    anonymous.dispose();
  });

  it("reserves the bearer protocol for exact current-reader FeatureServer URLs", async () => {
    const network = registry();
    const getAccessToken = vi.fn(async () => "viewer-token");
    const auth = { getAccessToken };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ type: "FeatureCollection", features: [] })));
    const authenticated = installAuthenticatedSourceProtocol(network, {
      documentUrl,
      sourceBaseUrl: "https://viewer.test/api",
      getAuth: () => auth,
      allowedSourceUrls: new Set([feature]),
      fetchImpl,
    });
    const current = authenticated.transformRequest(feature, "Source" as ResourceType);
    expect(current?.url).toMatch(/^honua-session-\d+:\/\//);
    await network.run(String(current?.url));
    expect(fetchImpl).toHaveBeenCalledWith(
      feature,
      expect.objectContaining({
        headers: { Authorization: "Bearer viewer-token" },
        credentials: "omit",
      }),
    );
    const other = feature.replace("current", "operator");
    expect(authenticated.transformRequest(other, "Source" as ResourceType)).toEqual({ url: other });
    await expect(
      network.run(String(current?.url).replace(encodeURIComponent(feature), encodeURIComponent(other))),
    ).rejects.toThrow("outside the trusted");
    const publicFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([7]).buffer, {
          headers: { "content-type": "image/png" },
        }),
    );
    const anonymous = installAnonymousMapResourceProtocol(network, {
      documentUrl,
      style: {
        version: 8,
        sources: { raster: { type: "raster", tiles: [tile], tileSize: 256 } },
        layers: [],
      },
      fetchImpl: publicFetch,
    });
    expect(authenticated.transformRequest(tile, "Tile" as ResourceType)).toEqual({ url: tile });
    await network.run(String(anonymous.transformRequest(tile, "Tile" as ResourceType)?.url));
    await network.run(String(anonymous.transformRequest(other, "Source" as ResourceType)?.url));
    const foreignSessionUrl = String(current?.url);
    const quarantined = String(anonymous.transformRequest(foreignSessionUrl, "Tile" as ResourceType)?.url);
    expect(quarantined).toMatch(/^honua-public-\d+:\/\//);
    await expect(network.run(quarantined)).rejects.toThrow("origin is not declared");
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(publicFetch).toHaveBeenCalledWith(
      tile,
      expect.objectContaining({
        headers: {},
        credentials: "omit",
        referrerPolicy: "no-referrer",
      }),
    );
    expect(publicFetch).toHaveBeenCalledWith(other, expect.objectContaining({ headers: {}, credentials: "omit" }));
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    anonymous.dispose();
    authenticated.dispose();
  });
});
