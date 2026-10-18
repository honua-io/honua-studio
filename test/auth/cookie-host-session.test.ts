import { afterEach, describe, expect, it, vi } from "vitest";
import { HostAdapterAuthSession } from "../../src/auth/host-session.js";
import { StudioLifecycleClient } from "../../src/lifecycle/lifecycle-client.js";

const sessions: HostAdapterAuthSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.unstubAllGlobals();
});
function session(expiresAt = new Date(Date.now() + 60000).toISOString(), sourcePathBase?: string) {
  const result = new HostAdapterAuthSession({
    kind: "cookie",
    baseUrl: "/api/studio",
    csrfToken: "csrf",
    environmentId: "env-a",
    principalId: "opaque-principal",
    sourcePathBase,
    expiresAt,
    onExpired: () => () => {},
  });
  sessions.push(result);
  return result;
}
describe("cookie host session", () => {
  it("bounds OGC reads to the actual features collection route", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const auth = session();
    await auth.fetchRequest!("/ogc/features/collections/roads/items?f=json&limit=500");
    expect(fetch.mock.calls[0][0]).toBe("/api/studio/data/ogc/features/collections/roads/items?f=json&limit=500");
    await expect(auth.fetchRequest!("/ogc/features/collections/roads/items", { method: "POST" })).rejects.toThrow();
    await expect(auth.fetchRequest!("/ogc/features/collections/roads%2Fsecret/items")).rejects.toThrow();
  });

  it("represents authentication without any JavaScript bearer", async () => {
    const auth = session();
    expect(auth.getState().status).toBe("fresh");
    expect(auth.getState().accessToken).toBeUndefined();
    expect(await auth.getAccessToken()).toBeUndefined();
  });
  it("bounds transport, strips credentials, pins environment and adds mutation CSRF", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: { draftId: "draft" } })));
    vi.stubGlobal("fetch", fetch);
    const auth = session();
    await auth.fetchRequest!("/api/v1/studio/package-drafts/draft", {
      method: "PUT",
      headers: { authorization: "Bearer forbidden", "x-api-key": "forbidden" },
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/studio/v1/studio/package-drafts/draft");
    expect(init.credentials).toBe("same-origin");
    expect(init.redirect).toBe("error");
    expect(init.headers.get("authorization")).toBeNull();
    expect(init.headers.get("x-api-key")).toBeNull();
    expect(init.headers.get("X-CSRF-Token")).toBe("csrf");
    expect(init.headers.get("X-Honua-Environment")).toBe("env-a");
    expect(init.headers.get("X-Honua-Session-Partition")).toBe("opaque-principal");
    for (const url of [
      "https://evil.invalid/api/v1/studio/package-drafts",
      "/api/mcp",
      "/api/v1/admin/users",
      "/api/v1/studio/../admin",
      "/api/v1/studio/%2e%2e/admin",
    ]) {
      await expect(auth.fetchRequest!(url)).rejects.toThrow();
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("uses the cookie seam in the real lifecycle client", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: [] })));
    vi.stubGlobal("fetch", fetch);
    await new StudioLifecycleClient({ auth: session() }).getPackageFamilies();
    expect(fetch.mock.calls[0][0]).toBe("/api/studio/v1/studio/package-families");
  });
  it("fails expired sessions without sending a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const auth = session(new Date(Date.now() - 1).toISOString());
    expect(auth.getState().status).toBe("expired");
    await expect(auth.fetchRequest!("/api/v1/studio/catalog")).rejects.toThrow("expired");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("expires on a server 401 without issuing a token refresh", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    const auth = session();
    await auth.fetchRequest!("/api/v1/studio/catalog");
    expect(auth.getState().status).toBe("expired");
    expect(await auth.getAccessToken()).toBeUndefined();
    expect(auth.getState().status).toBe("expired");
  });
  it("allows only read-only human catalog MCP and same-origin feature requests", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("location", { origin: "http://localhost" });
    const auth = session();
    await auth.fetchRequest!("/mcp", { method: "POST", body: JSON.stringify({ method: "initialize" }) });
    await auth.fetchRequest!("/mcp", {
      method: "POST",
      body: JSON.stringify({
        method: "tools/call",
        params: { name: "honua_list_layers", arguments: { offset: 0, limit: 100 } },
      }),
    });
    expect(fetch.mock.calls[0][0]).toBe("/api/studio/catalog-mcp");
    await expect(
      auth.fetchRequest!("/mcp", {
        method: "POST",
        body: JSON.stringify({ method: "tools/call", params: { name: "honua_studio_add_layer" } }),
      }),
    ).rejects.toThrow("layer discovery");
    await auth.fetchRequest!("http://localhost/rest/services/analysis/FeatureServer/47/query?f=geojson");
    expect(fetch.mock.calls[2][0]).toBe("/api/studio/data/rest/services/analysis/FeatureServer/47/query?f=geojson");
    await expect(
      auth.fetchRequest!("http://foreign.invalid/rest/services/analysis/FeatureServer/47/query"),
    ).rejects.toThrow("host origin");
  });
});

it("normalizes only the verified deployment segment for bounded metadata and query reads", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetch);
  const auth = session(undefined, "/honua");
  await auth.fetchRequest!("/honua/rest/services/roads/FeatureServer/0?f=json");
  await auth.fetchRequest!("/honua/rest/services/roads/FeatureServer/0/query?f=json&resultOffset=2000");
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "/api/studio/data/rest/services/roads/FeatureServer/0?f=json",
    "/api/studio/data/rest/services/roads/FeatureServer/0/query?f=json&resultOffset=2000",
  ]);
  for (const path of [
    "/honua-other/rest/services/roads/FeatureServer/0",
    "/other/honua/rest/services/roads/FeatureServer/0",
    "/honua/honua/rest/services/roads/FeatureServer/0",
    "/honua/rest/services/roads/FeatureServer/0/edit",
  ])
    await expect(auth.fetchRequest!(path)).rejects.toThrow();
  await expect(session().fetchRequest!("/honua/rest/services/roads/FeatureServer/0")).rejects.toThrow();
  for (const prefix of ["/honua/", "//evil", "/honua/..", "/honua%2Fother", "https://upstream.invalid/honua"])
    expect(() => session(undefined, prefix)).toThrow("deployment source path");
});
