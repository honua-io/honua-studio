import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { HostAdapterAuthSession, isSameCookiePrincipal } from "../../src/auth/host-session.js";
import type { CookieSessionAdapter } from "../../src/auth/types.js";

let server: Awaited<ReturnType<typeof startMockServer>>;
beforeAll(async () => {
  server = await startMockServer();
});
afterAll(async () => {
  await server.close();
});

function fixtureTransport() {
  const networkFetch = globalThis.fetch;
  const token = mintFixtureAccessToken();
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return networkFetch(`${server.url}/${input}`, { ...init, headers });
  });
}

const sessions: HostAdapterAuthSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.unstubAllGlobals();
});
function adapter(fetchRequest: typeof fetch): CookieSessionAdapter {
  return {
    kind: "cookie",
    baseUrl: "/api/v1/studio",
    principalId: "cookie:operator@example.test",
    environmentId: "demo",
    sourcePathBase: "/deployment",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    fetchRequest,
    onExpired: () => () => {},
  };
}
function session(cookie: CookieSessionAdapter) {
  const auth = new HostAdapterAuthSession(cookie);
  sessions.push(auth);
  return auth;
}
describe("native captured host session", () => {
  it("creates and reads a real REST draft through the captured transport", async () => {
    const captured = fixtureTransport();
    const auth = session(adapter(captured));
    const created = await auth.fetchRequest!("/deployment/api/v1/studio/package-drafts", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "must-be-stripped" },
      body: JSON.stringify({ packageKey: "native-capture", envelope: { family: "map", schemaVersion: "1.0" } }),
    });
    expect(created.status).toBe(201);
    const draft = (await created.json()).data;
    const read = await auth.fetchRequest!(`/api/v1/studio/package-drafts/${draft.draftId}`);
    expect(read.status).toBe(200);
    expect((await read.json()).data).toMatchObject({ draftId: draft.draftId, packageKey: "native-capture" });
    expect(new Headers(captured.mock.calls[0]![1]?.headers).has("authorization")).toBe(false);
  });

  it("streams the fixture chat and reads a real FeatureServer page", async () => {
    const auth = session(adapter(fixtureTransport()));
    const chat = await auth.fetchRequest!("/deployment/api/v1/studio/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Compose a map" }] }),
    });
    expect(chat.status).toBe(200);
    expect(chat.headers.get("content-type")).toContain("text/event-stream");
    expect(await chat.text()).toContain("event: message_stop");
    const page = await auth.fetchRequest!("/deployment/rest/services/hi-parcels/FeatureServer/0/query?f=json");
    expect(page.status).toBe(200);
    expect((await page.json()).features.length).toBeGreaterThan(0);
  });

  it("uses the fixture MCP session for catalog discovery", async () => {
    const auth = session(adapter(fixtureTransport()));
    const initialized = await auth.fetchRequest!("/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(initialized.status).toBe(200);
    expect((await initialized.json()).result).toHaveProperty("protocolVersion");
    const sessionId = initialized.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    const layers = await auth.fetchRequest!("/mcp", {
      method: "POST",
      headers: { "Mcp-Session-Id": sessionId! },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "honua_list_layers", arguments: {} },
      }),
    });
    expect(layers.status).toBe(200);
    expect((await layers.json()).result.structuredContent.layers.length).toBeGreaterThan(0);
  });

  it.each([
    ["/api/v1/studio/package-drafts", "api/v1/studio/package-drafts", "POST"],
    ["/deployment/api/v1/studio/ai/chat", "api/v1/studio/ai/chat", "POST"],
    ["/api/health", "api/health", "GET"],
    [
      "/deployment/rest/services/demo/FeatureServer/0/query?f=json",
      "rest/services/demo/FeatureServer/0/query?f=json",
      "GET",
    ],
    ["/ogc/features/collections/demo/items", "ogc/features/collections/demo/items", "GET"],
    ["/api/v1/admin/metadata/layers/1/suggest-style", "api/v1/admin/metadata/layers/1/suggest-style", "POST"],
    ["/mcp", "mcp", "POST"],
  ])("delegates %s to the captured relative route", async (input, target, method) => {
    const raw = vi.fn();
    vi.stubGlobal("fetch", raw);
    const captured = vi.fn().mockResolvedValue(new Response("{}"));
    const auth = session(adapter(captured));
    await auth.fetchRequest!(input, {
      method,
      body: method === "POST" ? JSON.stringify({ method: "initialize" }) : undefined,
      headers: {
        Authorization: "ignored",
        "X-API-Key": "ignored",
        "X-Honua-CSRF": "ignored",
        "X-CSRF-Token": "ignored",
        "Mcp-Session-Id": "session",
      },
    });
    expect(captured).toHaveBeenCalledOnce();
    expect(captured.mock.calls[0]![0]).toBe(target);
    const headers = captured.mock.calls[0]![1].headers as Headers;
    expect([...headers.keys()]).toEqual(["mcp-session-id"]);
    expect(raw).not.toHaveBeenCalled();
    expect(await auth.getAccessToken()).toBeUndefined();
  });

  it("requires the native transport and keeps the legacy CSRF requirement", () => {
    expect(() => session({ ...adapter(vi.fn()), fetchRequest: undefined })).toThrow("Invalid cookie");
    expect(() => session({ ...adapter(vi.fn()), baseUrl: "/api/studio" })).toThrow("Invalid cookie");
  });

  it("rejects out-of-scope requests before delegating", async () => {
    const captured = vi.fn();
    const auth = session(adapter(captured));
    for (const route of [
      "/api/v1/admin/users",
      "/api/v1/studio/%2e%2e/admin",
      "https://other.test/api/v1/studio/session",
    ]) {
      await expect(auth.fetchRequest!(route)).rejects.toThrow();
    }
    await expect(
      auth.fetchRequest!("/mcp", {
        method: "POST",
        body: JSON.stringify({ method: "tools/call", params: { name: "honua_delete_layer" } }),
      }),
    ).rejects.toThrow();
    expect(captured).not.toHaveBeenCalled();
  });

  it("reissues an in-flight read through the renewed capture without expiring on its stale 401", async () => {
    let finish!: (response: Response) => void;
    const old = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const cookie = adapter(old);
    const auth = session(cookie);
    const pending = auth.fetchRequest!("/api/v1/studio/session");
    const renewed = vi.fn().mockResolvedValue(new Response("renewed"));
    auth.renewCookie({ ...cookie, fetchRequest: renewed });
    finish(new Response(null, { status: 401 }));
    expect(await (await pending).text()).toBe("renewed");
    expect(renewed).toHaveBeenCalledOnce();
    expect(auth.getState().status).toBe("fresh");
    expect(isSameCookiePrincipal(cookie, { ...cookie, baseUrl: "/api/studio" })).toBe(false);
    expect(() => auth.renewCookie({ ...cookie, baseUrl: "/api/studio", csrfToken: "csrf" })).toThrow("authority");
  });

  it.each(["/api", "/rest", "/ogc", "/rest/services/tenant"])(
    "preserves canonical and prefixed routes under %s",
    async (sourcePathBase) => {
      const captured = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}")));
      const auth = session({ ...adapter(captured), sourcePathBase });
      for (const route of [
        "/api/v1/studio/package-drafts",
        "/api/health",
        "/rest/services/demo/FeatureServer/0/query",
        "/ogc/features/collections/demo/items",
      ]) {
        await auth.fetchRequest!(route);
        expect(captured.mock.lastCall![0]).toBe(route.slice(1));
        await auth.fetchRequest!(`${sourcePathBase}${route}`);
        expect(captured.mock.lastCall![0]).toBe(route.slice(1));
      }
    },
  );

  it.each(["GET", "POST", "ABORT"])("handles a rejected old capture with %s semantics", async (kind) => {
    let reject!: (reason: Error) => void;
    const old = vi.fn(
      () =>
        new Promise<Response>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const cookie = adapter(old);
    const auth = session(cookie);
    const controller = new AbortController();
    const pending = auth.fetchRequest!("/api/v1/studio/package-drafts", {
      method: kind === "POST" ? "POST" : "GET",
      signal: controller.signal,
    });
    const renewed = vi.fn().mockResolvedValue(new Response("renewed"));
    auth.renewCookie({ ...cookie, fetchRequest: renewed });
    if (kind === "ABORT") controller.abort();
    const error = new Error("Console capture revision changed");
    reject(error);
    if (kind === "GET") {
      expect(await (await pending).text()).toBe("renewed");
      expect(renewed).toHaveBeenCalledOnce();
    } else {
      await expect(pending).rejects.toBe(error);
      expect(renewed).not.toHaveBeenCalled();
    }
    expect(auth.getState().status).toBe("fresh");
  });

  it("does not replay writes after renewal and blocks requests after disposal", async () => {
    let finish!: (response: Response) => void;
    const old = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const cookie = adapter(old);
    const auth = session(cookie);
    const pending = auth.fetchRequest!("/api/v1/studio/package-drafts", { method: "POST" });
    const renewed = vi.fn();
    auth.renewCookie({ ...cookie, fetchRequest: renewed });
    finish(new Response("created"));
    expect(await (await pending).text()).toBe("created");
    expect(renewed).not.toHaveBeenCalled();
    auth.dispose();
    await expect(auth.fetchRequest!("/api/v1/studio/session")).rejects.toThrow("expired");
  });
});
