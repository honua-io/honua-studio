import { afterEach, expect, it, vi } from "vitest";

import { HostAdapterAuthSession } from "../../src/auth/host-session.js";
import type { CookieSessionAdapter, SessionAdapter } from "../../src/auth/types.js";
import {
  STYLE_SUGGESTION_NEEDS_HOST_SESSION,
  hostStyleSuggestionTransport,
} from "../../src/styles/style-suggestion-transport.js";

const sessions: HostAdapterAuthSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.unstubAllGlobals();
});

function nativeAdapter(fetchRequest: typeof fetch, principalId = "cookie:operator@example.test"): CookieSessionAdapter {
  return {
    kind: "cookie",
    baseUrl: "/api/v1/studio",
    principalId,
    environmentId: "demo",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    fetchRequest,
    onExpired: () => () => {},
  };
}

function hostFor(adapter: SessionAdapter) {
  const auth = new HostAdapterAuthSession(adapter);
  sessions.push(auth);
  let session: SessionAdapter = adapter;
  return {
    host: { session: () => session, auth: () => auth },
    replaceSession: (next: SessionAdapter) => {
      session = next;
    },
  };
}

const init = () => ({ signal: new AbortController().signal, draftRevision: "rev-1", composedLayerId: "parcels" });
const suggestion = { success: true, data: { observations: ["Geometry follows the server default."] } };

it("is unavailable without a cookie host session", () => {
  const bearer: SessionAdapter = { getToken: async () => "token", onExpired: () => () => {} };
  const auth = new HostAdapterAuthSession(bearer);
  sessions.push(auth);
  expect(hostStyleSuggestionTransport({ session: () => bearer, auth: () => auth })).toEqual({
    ok: false,
    reason: STYLE_SUGGESTION_NEEDS_HOST_SESSION,
  });
  expect(hostStyleSuggestionTransport({ session: () => undefined, auth: () => undefined }).ok).toBe(false);
});

it("binds a native Console response to the captured lease, layer and draft", async () => {
  const raw = vi.fn();
  vi.stubGlobal("fetch", raw);
  const captured = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(suggestion), { status: 200 }));
  const { host } = hostFor(nativeAdapter(captured));
  const resolved = hostStyleSuggestionTransport(host);
  if (!resolved.ok) throw new Error(resolved.reason);
  expect(resolved).toMatchObject({ principalId: "cookie:operator@example.test", environmentId: "demo" });
  const response = await resolved.transport(7, init());
  expect(captured).toHaveBeenCalledOnce();
  expect(captured.mock.calls[0]?.[0]).toBe("api/v1/admin/metadata/layers/7/suggest-style");
  expect(captured.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: "{}" });
  expect(raw).not.toHaveBeenCalled();
  expect(await response.json()).toEqual({
    binding: {
      principalId: "cookie:operator@example.test",
      environmentId: "demo",
      canonicalLayerId: 7,
      draftRevision: "rev-1",
      composedLayerId: "parcels",
    },
    suggestion,
  });
});

it("passes a refused native response through unbound", async () => {
  const captured = vi.fn<typeof fetch>(async () => new Response("{}", { status: 403 }));
  const { host } = hostFor(nativeAdapter(captured));
  const resolved = hostStyleSuggestionTransport(host);
  if (!resolved.ok) throw new Error(resolved.reason);
  const response = await resolved.transport(7, init());
  expect(response.status).toBe(403);
  expect(await response.text()).toBe("{}");
});

it("refuses to bind a response once the host session belongs to another principal", async () => {
  const swap: { to?: (next: SessionAdapter) => void } = {};
  const captured = vi.fn<typeof fetch>(async () => {
    swap.to?.(nativeAdapter(captured, "cookie:other@example.test"));
    return new Response(JSON.stringify(suggestion), { status: 200 });
  });
  const { host, replaceSession } = hostFor(nativeAdapter(captured));
  swap.to = replaceSession;
  const resolved = hostStyleSuggestionTransport(host);
  if (!resolved.ok) throw new Error(resolved.reason);
  await expect(resolved.transport(7, init())).rejects.toThrow("The host session changed.");
});

it("sends the draft binding to the legacy Console BFF and returns its envelope", async () => {
  const envelope = { binding: { principalId: "p" }, suggestion };
  const raw = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(envelope), { status: 200 }));
  vi.stubGlobal("fetch", raw);
  const adapter: CookieSessionAdapter = {
    kind: "cookie",
    baseUrl: "/api/studio",
    csrfToken: "csrf",
    principalId: "operator",
    environmentId: "demo",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    onExpired: () => () => {},
  };
  const { host } = hostFor(adapter);
  const resolved = hostStyleSuggestionTransport(host);
  if (!resolved.ok) throw new Error(resolved.reason);
  const response = await resolved.transport(7, init());
  expect(raw).toHaveBeenCalledOnce();
  expect(raw.mock.calls[0]?.[0]).toBe("/api/studio/layers/7/suggest-style");
  expect(JSON.parse(String(raw.mock.calls[0]?.[1]?.body))).toEqual({
    draftRevision: "rev-1",
    composedLayerId: "parcels",
  });
  expect(await response.json()).toEqual(envelope);
});
