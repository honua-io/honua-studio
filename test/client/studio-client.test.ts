import { afterEach, describe, expect, it, vi } from "vitest";

import { StudioClient, StudioClientError, StudioSessionExpiredError } from "../../src/client/studio-client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StudioClient auth wiring", () => {
  it("attaches the bearer token to every request when a token source is present", async () => {
    const requests: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        requests.push(new Headers(init?.headers).get("authorization") ?? undefined);
        return jsonResponse(200, { success: true, data: { items: [], total: 0, nextCursor: null } });
      }),
    );
    const auth = { getAccessToken: vi.fn(async () => "access-1") };
    const client = new StudioClient("/api", auth);

    await client.listPackages();

    expect(requests).toEqual(["Bearer access-1"]);
    expect(auth.getAccessToken).toHaveBeenCalledWith({ forceRefresh: false });
  });

  it("sends no Authorization header when there is no token source", async () => {
    const requests: (string | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        requests.push(new Headers(init?.headers).get("authorization") ?? undefined);
        return jsonResponse(200, { success: true, data: { items: [], total: 0, nextCursor: null } });
      }),
    );
    const client = new StudioClient("/api");

    await client.listPackages();

    expect(requests).toEqual([undefined]);
  });

  it("on a 401, retries exactly once with a forced refresh, then succeeds", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return call === 1
          ? jsonResponse(401, { error: "unauthorized" })
          : jsonResponse(200, { success: true, data: { items: [], total: 0, nextCursor: null } });
      }),
    );
    const getAccessToken = vi.fn(async (options?: { forceRefresh?: boolean }) =>
      options?.forceRefresh ? "access-2" : "access-1",
    );
    const client = new StudioClient("/api", { getAccessToken });

    const datasets = await client.listPackages();

    expect(datasets).toEqual([]);
    expect(call).toBe(2);
    expect(getAccessToken).toHaveBeenNthCalledWith(1, { forceRefresh: false });
    expect(getAccessToken).toHaveBeenNthCalledWith(2, { forceRefresh: true });
  });

  it("on a second consecutive 401 (refresh didn't help), throws StudioSessionExpiredError — never a third attempt", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return jsonResponse(401, { error: "unauthorized" });
      }),
    );
    const getAccessToken = vi.fn(async () => "access-1");
    const client = new StudioClient("/api", { getAccessToken });

    await expect(client.listPackages()).rejects.toBeInstanceOf(StudioSessionExpiredError);
    expect(call).toBe(2); // exactly one retry, never a loop
  });

  it("a 401 with no token source at all still surfaces StudioSessionExpiredError, not a generic error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(401, { error: "unauthorized" })),
    );
    const client = new StudioClient("/api");

    await expect(client.listPackages()).rejects.toBeInstanceOf(StudioSessionExpiredError);
  });

  it("a non-401, non-OK response is a generic StudioClientError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(500, { error: "boom" })),
    );
    const client = new StudioClient("/api");

    await expect(client.listPackages()).rejects.toBeInstanceOf(StudioClientError);
    await expect(client.listPackages()).rejects.not.toBeInstanceOf(StudioSessionExpiredError);
  });

  it("a transport failure is a generic StudioClientError, not a session-expired one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    const client = new StudioClient("/api");

    await expect(client.listPackages()).rejects.toBeInstanceOf(StudioClientError);
    await expect(client.listPackages()).rejects.not.toBeInstanceOf(StudioSessionExpiredError);
  });
});

const publishedLayer = {
  serviceId: "service-uuid",
  serviceName: "Transportation/Road inventory",
  layerId: 7,
  name: "Roads",
  type: "Feature Layer",
  geometryType: "LineString",
};
function page(layers: unknown[], offset = 0, nextOffset?: number) {
  return { layers, layerCount: layers.length, totalCount: 2, offset, hasMore: nextOffset !== undefined, nextOffset };
}
function mockCatalog(pages: unknown[], textContent = false) {
  const requests: { url: string; init?: RequestInit; body: { method: string; params: Record<string, unknown> } }[] = [];
  let next = 0;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url, init, body });
    const result =
      body.method === "initialize"
        ? { protocolVersion: "2025-03-26", serverInfo: { name: "server", version: "1" } }
        : textContent
          ? { content: [{ type: "text", text: JSON.stringify(pages[next++]) }] }
          : { structuredContent: pages[next++] };
    return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result });
  });
  vi.stubGlobal("fetch", fetcher);
  return { requests, fetcher };
}

describe("StudioClient real discovery", () => {
  it("enumerates authenticated MCP pages and retains the real service name and nonzero layer id", async () => {
    const { requests } = mockCatalog([
      page([publishedLayer], 0, 1),
      page([{ ...publishedLayer, layerId: 8, name: "Bridges" }], 1),
    ]);
    const auth = { getAccessToken: vi.fn(async () => "token") };
    const catalog = await new StudioClient("https://host/api", auth).listCatalog();
    expect(catalog.map((entry) => entry.id)).toEqual(["service-uuid/7", "service-uuid/8"]);
    expect(catalog[0]?.locator).toEqual({
      url: "https://host/rest/services/Transportation/Road%20inventory/FeatureServer",
      layerId: 7,
      serviceId: "service-uuid",
    });
    expect(requests.map((request) => request.url)).toEqual(Array(3).fill("https://host/mcp"));
    expect(requests.map((request) => new Headers(request.init?.headers).get("authorization"))).toEqual(
      Array(3).fill("Bearer token"),
    );
    expect(requests[2]?.body.params).toEqual({ name: "honua_list_layers", arguments: { offset: 1, limit: 100 } });
  });

  it("accepts the real MCP JSON text content envelope and configured origin", async () => {
    const { requests } = mockCatalog([page([publishedLayer])], true);
    expect(await new StudioClient("/api", undefined, "https://server").listCatalog()).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://server/mcp");
  });

  it.each([
    page([publishedLayer], 0, 0),
    { ...page([publishedLayer]), layers: undefined },
    page([{ ...publishedLayer, layerId: -1 }]),
  ])("rejects malformed catalog identity or nonadvancing pagination", async (value) => {
    mockCatalog([value]);
    await expect(new StudioClient().listCatalog()).rejects.toBeInstanceOf(StudioClientError);
  });

  it("does not relabel duplicate identities as new datasets", async () => {
    mockCatalog([page([publishedLayer], 0, 1), page([publishedLayer], 1)]);
    await expect(new StudioClient().listCatalog()).rejects.toThrow("repeated an identity");
  });

  it("refreshes once on MCP 401 and preserves the terminal session-expired error", async () => {
    const fetcher = vi.fn(async () => jsonResponse(401, {}));
    vi.stubGlobal("fetch", fetcher);
    const auth = { getAccessToken: vi.fn(async () => "token") };
    await expect(new StudioClient("/api", auth).listCatalog()).rejects.toBeInstanceOf(StudioSessionExpiredError);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(auth.getAccessToken).toHaveBeenLastCalledWith({ forceRefresh: true });
  });

  it("uses the lifecycle envelope and cursor without inventing runtime status or format", async () => {
    const item = {
      itemId: "item-1",
      packageKey: "roads",
      family: "map",
      state: "current",
      updatedAt: "2026-10-14T00:00:00Z",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { success: true, data: { items: [item], total: 2, nextCursor: "next token" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          success: true,
          data: { items: [{ ...item, itemId: "item-2", state: "published" }], total: 2, nextCursor: null },
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    const packages = await new StudioClient("https://host/api").listPackages();
    expect(packages[0]).toEqual({
      id: "item-1",
      title: "roads",
      family: "map",
      state: "current",
      updatedAt: item.updatedAt,
    });
    expect(packages[1]?.state).toBe("published");
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("/api/v1/studio/content-items?cursor=next+token&limit=100");
  });

  it("rejects a repeated lifecycle cursor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { success: true, data: { items: [], total: 1, nextCursor: "stuck" } })),
    );
    await expect(new StudioClient().listPackages()).rejects.toThrow("repeated a cursor");
  });
});

describe("real discovery contract against the authenticated fixture", () => {
  it("uses MCP and actual lifecycle routes, with empty content represented honestly", async () => {
    const { startMockServer, mintFixtureAccessToken } = await import("../../mock-server.mjs");
    const server = await startMockServer();
    try {
      const client = new StudioClient(
        `${server.url}/api`,
        { getAccessToken: async () => mintFixtureAccessToken() },
        server.url,
      );
      const catalog = await client.listCatalog();
      expect(catalog[0]).toMatchObject({
        id: "hi-parcels/0",
        geometryType: "Polygon",
        locator: { layerId: 0, serviceId: "hi-parcels" },
      });
      expect(await client.listPackages()).toEqual([]);
      const source = catalog[0]?.locator;
      const response = await fetch(`${source?.url}/${source?.layerId}/query?f=geojson`);
      expect(response.ok).toBe(true);
      expect((await response.json()).features.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });
});

it("the real Studio API prefix also reaches authenticated AI streaming routes", async () => {
  const { startMockServer, mintFixtureAccessToken } = await import("../../mock-server.mjs");
  const server = await startMockServer();
  try {
    const response = await fetch(`${server.url}/api/v1/studio/ai/chat`, {
      method: "POST",
      headers: { authorization: `Bearer ${mintFixtureAccessToken()}`, "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Add the Hawai'i statewide parcels layer and style it by district." }],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("add_layer");
  } finally {
    await server.close();
  }
});
