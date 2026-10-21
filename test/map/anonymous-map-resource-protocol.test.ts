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
  it("admits validated style-import origins without granting undeclared or credential-bearing origins", async () => {
    const network = registry();
    const fetchImpl = vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } }));
    const style = {
      version: 8 as const,
      sources: {},
      layers: [],
      imports: [
        { id: "fragment", url: "https://fragments.example/style.json" },
        { id: "bad", url: "https://secret:password@private.example/style.json" },
        { id: "file", url: "file:///private/style.json" },
        null,
      ],
    };
    const anonymous = installAnonymousMapResourceProtocol(network, { documentUrl, style, fetchImpl });
    const invoke = (url: string) => network.run(anonymous.transformRequest(url).url);
    await expect(invoke("https://fragments.example/style.json")).resolves.toEqual({ data: {} });
    await expect(invoke("https://private.example/style.json")).rejects.toThrow("origin is not declared");
    await expect(invoke("https://unlisted.example/style.json")).rejects.toThrow("origin is not declared");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://fragments.example/style.json",
      expect.objectContaining({ credentials: "omit", headers: {}, redirect: "error" }),
    );
    anonymous.dispose();
  });

  it("bounds buffering for empty and tiny fragments and cancels an overflow", async () => {
    const network = registry();
    const canceled = vi.fn();
    const empty = new Uint8Array(0);
    let read = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        read++;
        if (read <= 1024) controller.enqueue(read % 2 === 0 ? new Uint8Array([7]) : empty);
        else controller.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream));
    const anonymous = installAnonymousMapResourceProtocol(network, {
      documentUrl,
      style: { version: 8, sources: { tiles: { type: "raster", tiles: [tile] } }, layers: [] },
      fetchImpl,
    });
    const invoke = () => network.run(anonymous.transformRequest(tile).url);
    const result = await invoke();
    expect(new Uint8Array(result.data as ArrayBuffer)).toEqual(new Uint8Array(512).fill(7));
    let chunks = 0;
    fetchImpl.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            chunks++;
            controller.enqueue(new Uint8Array(chunks === 1 ? 16 * 1024 * 1024 : 1));
          },
          cancel: canceled,
        }),
      ),
    );
    await expect(invoke()).rejects.toThrow("size limit");
    expect(canceled).toHaveBeenCalledTimes(1);
    anonymous.dispose();
  });

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
