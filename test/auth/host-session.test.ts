import { describe, expect, it } from "vitest";

import { createFixtureHostSessionAdapter } from "../../src/auth/fixture-host-session-adapter.js";
import { HostAdapterAuthSession } from "../../src/auth/host-session.js";
import type { AuthState } from "../../src/auth/types.js";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("HostAdapterAuthSession", () => {
  it("resolves the host token proactively and reports fresh — no caller has to ask first", async () => {
    const adapter = createFixtureHostSessionAdapter("host-token-1");
    const session = new HostAdapterAuthSession(adapter);
    await flushMicrotasks();

    expect(session.getState()).toEqual({ status: "fresh", accessToken: "host-token-1" });
  });

  it("getAccessToken always defers to the adapter, never caching independently", async () => {
    const adapter = createFixtureHostSessionAdapter("host-token-1");
    const session = new HostAdapterAuthSession(adapter);
    await flushMicrotasks();

    adapter.setToken("host-token-2");
    await expect(session.getAccessToken()).resolves.toBe("host-token-2");
    expect(session.getState().accessToken).toBe("host-token-2");
  });

  it("reports expired when the adapter has no token", async () => {
    const adapter = createFixtureHostSessionAdapter(undefined);
    const session = new HostAdapterAuthSession(adapter);
    await flushMicrotasks();

    expect(session.getState().status).toBe("expired");
  });

  it("surfaces expired the moment the host fires onExpired", async () => {
    const adapter = createFixtureHostSessionAdapter("host-token-1");
    const session = new HostAdapterAuthSession(adapter);
    await flushMicrotasks();
    expect(session.getState().status).toBe("fresh");

    adapter.triggerExpired();
    expect(session.getState().status).toBe("expired");
  });

  it("propagates a getToken() rejection as expired rather than throwing out of getAccessToken", async () => {
    const adapter = createFixtureHostSessionAdapter("host-token-1");
    adapter.getToken = () => Promise.reject(new Error("host session revoked"));
    const session = new HostAdapterAuthSession(adapter);

    await expect(session.getAccessToken()).resolves.toBeUndefined();
    expect(session.getState()).toEqual({ status: "expired", error: "host session revoked" });
  });

  it("signIn() rejects and never touches window.location — host-adapter mode never redirects", async () => {
    const adapter = createFixtureHostSessionAdapter("host-token-1");
    const session = new HostAdapterAuthSession(adapter);

    await expect(session.signIn()).rejects.toThrow(/never initiates its own sign-in/);
  });

  it("signOut() rejects — the host owns sign-out too", async () => {
    const adapter = createFixtureHostSessionAdapter("host-token-1");
    const session = new HostAdapterAuthSession(adapter);

    await expect(session.signOut()).rejects.toThrow(/never initiates its own sign-out/);
  });

  it("isRedirectCallback is always false and handleRedirectCallback is a no-op", async () => {
    const adapter = createFixtureHostSessionAdapter("host-token-1");
    const session = new HostAdapterAuthSession(adapter);

    expect(session.isRedirectCallback("https://console.example/?code=abc&state=xyz")).toBe(false);
    await expect(session.handleRedirectCallback()).resolves.toBeUndefined();
  });

  it("notifies subscribers immediately with the current state, then on every transition", async () => {
    const adapter = createFixtureHostSessionAdapter("host-token-1");
    const session = new HostAdapterAuthSession(adapter);
    await flushMicrotasks();

    const seen: AuthState[] = [];
    const unsubscribe = session.subscribe((state) => seen.push(state));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.status).toBe("fresh");

    adapter.triggerExpired();
    expect(seen).toHaveLength(2);
    expect(seen[1]?.status).toBe("expired");

    unsubscribe();
    adapter.triggerExpired();
    expect(seen).toHaveLength(2); // no further notifications after unsubscribe
  });

  it("dispose() detaches from the adapter's onExpired subscription", async () => {
    const adapter = createFixtureHostSessionAdapter("host-token-1");
    const session = new HostAdapterAuthSession(adapter);
    await flushMicrotasks();
    expect(adapter.listenerCount).toBe(1);

    session.dispose();
    expect(adapter.listenerCount).toBe(0);
  });
});
