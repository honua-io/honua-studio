import { createServer } from "node:http";
import type { AddProtocolAction, ResourceType } from "maplibre-gl";
import { type Mock, afterEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "../../src/auth/types.js";
import { installAuthenticatedSourceProtocol, trustedSourceUrl } from "../../src/map/authenticated-source-protocol.js";

import { isCompositionSourceResolution, resolveCompositionSource } from "../../src/map/source-resolution.js";

const documentUrl = "https://studio.test/app/";
const sourceBaseUrl = "https://honua.test/deployment/api";
const source = "https://honua.test/deployment/rest/services/Maps/Roads/FeatureServer/7/query?f=geojson";
const collection = {
  type: "FeatureCollection",
  features: [{ type: "Feature", geometry: null, properties: { id: 1 } }],
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function setup(fetchImpl = vi.fn(async () => response(collection)), legacySourceBaseUrl?: string) {
  let handler: AddProtocolAction | undefined;
  let protocol = "";
  let auth: { getAccessToken: Mock<AuthSession["getAccessToken"]> } | undefined = {
    getAccessToken: vi.fn(async () => "fresh-token"),
  };
  const registry = {
    addProtocol: vi.fn((name: string, action: AddProtocolAction) => {
      protocol = name;
      handler = action;
    }),
    removeProtocol: vi.fn(),
  };
  const onError = vi.fn();
  const transport = installAuthenticatedSourceProtocol(registry, {
    sourceBaseUrl,
    legacySourceBaseUrl,
    documentUrl,
    getAuth: () => auth,
    fetchImpl,
    onError,
  });
  return {
    registry,
    transport,
    fetchImpl,
    onError,
    get auth() {
      return auth;
    },
    set auth(value) {
      auth = value;
    },
    run: (url = source, controller = new AbortController()) =>
      handler?.({ url: `${protocol}://${encodeURIComponent(url)}` }, controller),
  };
}
afterEach(() => vi.restoreAllMocks());

describe("trusted authenticated map sources", () => {
  it.each([
    ["ogc-features", "/api"],
    ["geoservices-feature-service", "/api"],
    ["ogc-features", "/honua/api"],
    ["geoservices-feature-service", "/honua/api"],
    ["ogc-features", "https://legacy.test/honua/api"],
    ["geoservices-feature-service", "https://legacy.test/honua/api"],
  ])("authenticates actual no-locator %s resolution under %s", async (protocol, baseUrl) => {
    const resolved = resolveCompositionSource(
      { id: "roads", sourceId: "roads", visible: true },
      {
        baseUrl,
        catalog: [{ id: "roads", title: "Roads", protocol, geometryType: "LineString" }],
      },
    );
    expect(isCompositionSourceResolution(resolved)).toBe(true);
    if (!isCompositionSourceResolution(resolved)) throw new Error("Expected source resolution");
    const url = String(resolved.source.data);
    const context = setup(undefined, baseUrl);
    const transformed = await context.transport.transformRequest(url, "Source" as ResourceType);
    expect(transformed?.url).toMatch(/^honua-session-\d+:\/\//);
    expect(await context.run(url)).toEqual({ data: collection });
    expect(context.fetchImpl).toHaveBeenCalledWith(
      new URL(url, documentUrl).href,
      expect.objectContaining({ headers: { Authorization: "Bearer fresh-token" } }),
    );
  });
  it.each([
    "https://foreign.test/honua/api/rest/services/Roads/FeatureServer/0/query",
    "https://legacy.test/honua/api-other/rest/services/Roads/FeatureServer/0/query",
    "https://legacy.test/honua/rest/services/Roads/FeatureServer/0/query",
    "https://legacy.test/honua/api/admin",
    "https://legacy.test/honua/api/rest/services/%252fadmin/FeatureServer/0/query",
  ])("refuses untrusted legacy URL before accessing auth: %s", async (url) => {
    const context = setup(undefined, "https://legacy.test/honua/api");
    expect(await context.transport.transformRequest(url, "Source" as ResourceType)).toEqual({ url });
    await expect(context.run(url)).rejects.toThrow("outside the trusted");
    expect(context.auth?.getAccessToken).not.toHaveBeenCalled();
    expect(context.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    source,
    "https://honua.test/deployment/rest/services/City%20Maps/Roads/FeatureServer/7/query",
    "https://honua.test/deployment/ogc/collections/parcels/items?limit=20",
  ])("accepts actual feature endpoint %s", (url) => {
    expect(trustedSourceUrl(url, sourceBaseUrl, documentUrl)?.href).toBe(url);
  });
  it.each([
    "https://evil.test/deployment/rest/services/Roads/FeatureServer/7/query",
    "https://honua.test/deployment-other/rest/services/Roads/FeatureServer/7/query",
    "https://honua.test/rest/services/Roads/FeatureServer/7/query",
    "https://honua.test/deployment/../rest/services/Roads/FeatureServer/7/query",
    "https://user:secret@honua.test/deployment/rest/services/Roads/FeatureServer/7/query",
    "https://honua.test/deployment/rest/services/Roads/FeatureServer",
    "https://honua.test/deployment/mcp",
    "https://honua.test/deployment/ogc/collections/parcels",
    "https://honua.test/deployment/rest/services/%2f..%2f..%2fadmin/FeatureServer/7/query",
    "https://honua.test/deployment/rest/services/%5c..%5cadmin/FeatureServer/7/query",
    "https://honua.test/deployment/rest/services/%252fadmin/FeatureServer/7/query",
    "data:application/json,{}",
  ])("refuses foreign or non-feature URL before token access: %s", async (url) => {
    const context = setup();
    await expect(context.run(url)).rejects.toThrow("outside the trusted");
    expect(context.auth?.getAccessToken).not.toHaveBeenCalled();
    expect(context.fetchImpl).not.toHaveBeenCalled();
  });
  it("resolves relative same-origin routes and preserves deployment boundaries", () => {
    expect(trustedSourceUrl("/honua/ogc/collections/roads/items", "/honua/api", documentUrl)?.pathname).toBe(
      "/honua/ogc/collections/roads/items",
    );
    expect(trustedSourceUrl("/ogc/collections/roads/items", "/honua/api", documentUrl)).toBeUndefined();
  });
  it("transforms only trusted Source requests and never puts credentials in the URL", async () => {
    const context = setup();
    const transformed = await context.transport.transformRequest(source, "Source" as ResourceType);
    expect(transformed?.url).toMatch(/^honua-session-\d+:\/\//);
    expect(transformed?.url).not.toContain("fresh-token");
    expect(await context.transport.transformRequest(source, "Tile" as ResourceType)).toEqual({ url: source });
    expect(
      await context.transport.transformRequest("https://external.test/source.json", "Source" as ResourceType),
    ).toEqual({ url: "https://external.test/source.json" });
    expect(context.auth?.getAccessToken).not.toHaveBeenCalled();
  });
  it("gets a fresh token per request and returns parsed GeoJSON with no token in data", async () => {
    const context = setup();
    expect(await context.run()).toEqual({ data: collection });
    context.auth?.getAccessToken.mockResolvedValueOnce("rotated-token");
    await context.run();
    expect(context.fetchImpl).toHaveBeenNthCalledWith(
      2,
      source,
      expect.objectContaining({
        headers: { Authorization: "Bearer rotated-token" },
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      }),
    );
    expect(context.auth?.getAccessToken).toHaveBeenCalledTimes(2);
  });
  it.each([401, 499])("refreshes once for authorization failure %i", async (code) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(code === 401 ? response({}, 401) : response({ error: { code: 499 } }))
      .mockResolvedValueOnce(response(collection));
    const context = setup(fetcher);
    expect(await context.run()).toEqual({ data: collection });
    expect(context.auth?.getAccessToken).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("surfaces terminal authorization failure without unbounded retry", async () => {
    const context = setup(vi.fn(async () => response({ error: { code: 499 } })));
    await expect(context.run()).rejects.toThrow("cannot authorize");
    expect(context.fetchImpl).toHaveBeenCalledTimes(2);
    expect(context.onError).toHaveBeenCalledTimes(1);
  });
  it("does not retry anonymous failures or fabricate an empty collection", async () => {
    const context = setup(vi.fn(async () => response({ error: { code: 499 } })));
    context.auth = undefined;
    await expect(context.run()).rejects.toThrow("cannot authorize");
    expect(context.fetchImpl).toHaveBeenCalledTimes(1);
    expect(context.fetchImpl).toHaveBeenCalledWith(source, expect.objectContaining({ headers: {} }));
  });
  it("resolves the current host session on each request", async () => {
    const context = setup();
    await context.run();
    context.auth = { getAccessToken: vi.fn(async () => "replacement-session") };
    await context.run();
    expect(context.fetchImpl).toHaveBeenLastCalledWith(
      source,
      expect.objectContaining({ headers: { Authorization: "Bearer replacement-session" } }),
    );
  });
  it("refuses a stale token when the host session changes during token resolution", async () => {
    const context = setup();
    context.auth?.getAccessToken.mockImplementation(async () => {
      context.auth = { getAccessToken: vi.fn(async () => "replacement") };
      return "old-session";
    });
    await expect(context.run()).rejects.toThrow("session changed");
    expect(context.fetchImpl).not.toHaveBeenCalled();
  });
  it.each([{ error: { code: 500 } }, { type: "FeatureCollection" }, { type: "Feature", properties: {} }])(
    "refuses malformed or backend-error HTTP200 data",
    async (body) => {
      const context = setup(vi.fn(async () => response(body)));
      await expect(context.run()).rejects.toThrow("did not return a GeoJSON FeatureCollection");
      expect(context.fetchImpl).toHaveBeenCalledTimes(1);
      expect(context.onError).toHaveBeenCalledTimes(1);
    },
  );
  it("refuses data returned after a session replacement while fetch was pending", async () => {
    let finish: ((response: Response) => void) | undefined;
    const context = setup(
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const pending = context.run();
    await vi.waitUntil(() => finish !== undefined);
    context.auth = { getAccessToken: vi.fn(async () => "replacement") };
    finish?.(response(collection));
    await expect(pending).rejects.toThrow("session changed");
  });
  it("aborts disposed requests and removes only its own protocol exactly once", async () => {
    let resolveToken: ((token: string) => void) | undefined;
    const context = setup();
    context.auth?.getAccessToken.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveToken = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = context.run(source, controller);
    context.transport.dispose();
    context.transport.dispose();
    resolveToken?.("too-late");
    await expect(pending).rejects.toThrow();
    expect(controller.signal.aborted).toBe(true);
    expect(context.fetchImpl).not.toHaveBeenCalled();
    expect(context.onError).not.toHaveBeenCalled();
    expect(context.registry.removeProtocol).toHaveBeenCalledTimes(1);
    expect(context.registry.removeProtocol).toHaveBeenCalledWith(context.registry.addProtocol.mock.calls[0]?.[0]);
  });
  it("respects an already-aborted MapLibre request before reading tokens", async () => {
    const context = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(context.run(source, controller)).rejects.toThrow();
    expect(context.auth?.getAccessToken).not.toHaveBeenCalled();
  });
  it("rejects an actual redirect without sending a token to the destination", async () => {
    let destinationRequests = 0;
    const server = createServer((request, result) => {
      if (request.url === "/rest/services/Roads/FeatureServer/0/query")
        result.writeHead(302, { Location: "/foreign" }).end();
      else {
        destinationRequests++;
        result.end("{}");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server port");
      const base = `http://127.0.0.1:${address.port}`;
      let handler: AddProtocolAction | undefined;
      let name = "";
      const auth = { getAccessToken: async () => "token" };
      const active = installAuthenticatedSourceProtocol(
        {
          addProtocol: (scheme, action) => {
            name = scheme;
            handler = action;
          },
          removeProtocol: vi.fn(),
        },
        { sourceBaseUrl: base, documentUrl, getAuth: () => auth },
      );
      try {
        await expect(
          handler?.(
            { url: `${name}://${encodeURIComponent(`${base}/rest/services/Roads/FeatureServer/0/query`)}` },
            new AbortController(),
          ),
        ).rejects.toThrow();
      } finally {
        active.dispose();
      }
      expect(destinationRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
