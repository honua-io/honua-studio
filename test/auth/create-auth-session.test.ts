import { describe, expect, it, vi } from "vitest";

import { createFixtureHostSessionAdapter } from "../../src/auth/fixture-host-session-adapter.js";
import { HostAdapterAuthSession } from "../../src/auth/host-session.js";
import { createAuthSession, detectHostSessionAdapter } from "../../src/auth/index.js";
import { OidcAuthSession } from "../../src/auth/oidc-session.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("detectHostSessionAdapter", () => {
  it("returns undefined when no host session global is set", () => {
    const target = {} as unknown as Window;
    expect(detectHostSessionAdapter(target)).toBeUndefined();
  });

  it("returns undefined for a malformed global (missing methods)", () => {
    const target = { __HONUA_STUDIO_HOST_SESSION__: { getToken: 42 } } as unknown as Window;
    expect(detectHostSessionAdapter(target)).toBeUndefined();
  });

  it("returns the adapter when it matches the SessionAdapter shape", () => {
    const adapter = createFixtureHostSessionAdapter("token");
    const target = { __HONUA_STUDIO_HOST_SESSION__: adapter } as unknown as Window;
    expect(detectHostSessionAdapter(target)).toBe(adapter);
  });
});

describe("createAuthSession", () => {
  it("builds a HostAdapterAuthSession when a host adapter is supplied", () => {
    const adapter = createFixtureHostSessionAdapter("token");
    const session = createAuthSession({ hostAdapter: adapter });
    expect(session).toBeInstanceOf(HostAdapterAuthSession);
    expect(session.mode).toBe("host-adapter");
  });

  it("builds a standalone OidcAuthSession otherwise", () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(200, {
        issuer: "https://idp.example",
        authorization_endpoint: "https://idp.example/authorize",
        token_endpoint: "https://idp.example/token",
      }),
    );
    const session = createAuthSession({ fetchFn: fetchFn as unknown as typeof fetch });
    expect(session).toBeInstanceOf(OidcAuthSession);
    expect(session.mode).toBe("standalone");
  });
});
