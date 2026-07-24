import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { OidcAuthSession } from "../../src/auth/oidc-session.js";

const ISSUER = "https://idp.example/oidc";
const REDIRECT_URI = "https://app.example/";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function discoveryDocument() {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    revocation_endpoint: `${ISSUER}/revoke`,
  };
}

/** Waits for the redirect — discovery + async PKCE (WebCrypto) + assign span more than a few microtask ticks. */
async function waitForAssign(windowRef: Window): Promise<void> {
  await vi.waitFor(() => {
    expect(windowRef.location.assign).toHaveBeenCalled();
  });
}

function createFakeWindow() {
  return { location: { assign: vi.fn(), href: REDIRECT_URI } } as unknown as Window;
}

function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

describe("OidcAuthSession", () => {
  it("signIn() runs discovery then redirects with S256 PKCE params and a CSRF state", async () => {
    const windowRef = createFakeWindow();
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return jsonResponse(200, discoveryDocument());
      throw new Error(`unexpected fetch ${url}`);
    });
    const session = new OidcAuthSession(
      { issuer: ISSUER, clientId: "studio-test", redirectUri: REDIRECT_URI, scopes: ["openid", "honua.read"] },
      { fetchFn: fetchFn as unknown as typeof fetch, windowRef },
    );

    void session.signIn(); // redirect mode never resolves — do not await
    await waitForAssign(windowRef);

    expect(windowRef.location.assign).toHaveBeenCalledTimes(1);
    const assignedUrl = new URL((windowRef.location.assign as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string);
    expect(assignedUrl.origin + assignedUrl.pathname).toBe(`${ISSUER}/authorize`);
    expect(assignedUrl.searchParams.get("client_id")).toBe("studio-test");
    expect(assignedUrl.searchParams.get("response_type")).toBe("code");
    expect(assignedUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(assignedUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(assignedUrl.searchParams.get("state")).toBeTruthy();
    expect(assignedUrl.searchParams.get("scope")).toBe("openid honua.read");
    expect(session.getState().status).toBe("signing-in");
  });

  it("completes the full sign-in round trip: discovery -> authorize redirect -> code exchange -> fresh", async () => {
    const windowRef = createFakeWindow();
    let capturedVerifier = "";
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return jsonResponse(200, discoveryDocument());
      if (url === `${ISSUER}/token`) {
        const body = new URLSearchParams(String(init?.body ?? ""));
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("client_id")).toBe("studio-test");
        capturedVerifier = body.get("code_verifier") ?? "";
        return jsonResponse(200, {
          access_token: "access-1",
          token_type: "Bearer",
          expires_in: 60,
          refresh_token: "refresh-1",
          scope: "openid",
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const session = new OidcAuthSession(
      { issuer: ISSUER, clientId: "studio-test", redirectUri: REDIRECT_URI, scopes: ["openid"] },
      { fetchFn: fetchFn as unknown as typeof fetch, windowRef },
    );

    void session.signIn();
    await waitForAssign(windowRef);
    const assignedUrl = new URL((windowRef.location.assign as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string);
    const state = assignedUrl.searchParams.get("state") ?? "";
    const codeChallenge = assignedUrl.searchParams.get("code_challenge") ?? "";

    const callbackUrl = `${REDIRECT_URI}?code=auth-code-1&state=${encodeURIComponent(state)}`;
    expect(session.isRedirectCallback(callbackUrl)).toBe(true);
    await session.handleRedirectCallback(callbackUrl);

    // The exact verifier the token exchange sent really does hash to the
    // challenge the browser was redirected with (RFC 7636 end to end).
    expect(s256Challenge(capturedVerifier)).toBe(codeChallenge);
    expect(session.getState()).toEqual({ status: "fresh", accessToken: "access-1", expiresAt: expect.any(Number) });
  });

  it("getAccessToken({forceRefresh:true}) rotates the token and transitions fresh -> refreshing -> fresh", async () => {
    let refreshCallCount = 0;
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return jsonResponse(200, discoveryDocument());
      if (url === `${ISSUER}/token`) {
        const body = new URLSearchParams(String(init?.body ?? ""));
        if (body.get("grant_type") === "authorization_code") {
          return jsonResponse(200, {
            access_token: "access-1",
            token_type: "Bearer",
            expires_in: 60,
            refresh_token: "refresh-1",
          });
        }
        refreshCallCount += 1;
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("refresh-1");
        return jsonResponse(200, {
          access_token: "access-2",
          token_type: "Bearer",
          expires_in: 60,
          refresh_token: "refresh-2",
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const windowRef = createFakeWindow();
    const session = new OidcAuthSession(
      { issuer: ISSUER, clientId: "studio-test", redirectUri: REDIRECT_URI, scopes: [] },
      { fetchFn: fetchFn as unknown as typeof fetch, windowRef },
    );

    void session.signIn();
    await waitForAssign(windowRef);
    const assignedUrl = new URL((windowRef.location.assign as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string);
    const state = assignedUrl.searchParams.get("state") ?? "";
    await session.handleRedirectCallback(`${REDIRECT_URI}?code=auth-code-1&state=${encodeURIComponent(state)}`);
    expect(session.getState().accessToken).toBe("access-1");

    const statuses: string[] = [];
    session.subscribe((s) => statuses.push(s.status));
    const token = await session.getAccessToken({ forceRefresh: true });

    expect(token).toBe("access-2");
    expect(refreshCallCount).toBe(1);
    expect(session.getState()).toEqual({ status: "fresh", accessToken: "access-2", expiresAt: expect.any(Number) });
    // subscribe() replays the current state immediately, then the refresh
    // transition fires: fresh (replay) -> refreshing -> fresh (rotated).
    expect(statuses).toEqual(["fresh", "refreshing", "fresh"]);
  });

  it("a rotated-away (invalid_grant) refresh signs the session all the way out", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) return jsonResponse(200, discoveryDocument());
      if (url === `${ISSUER}/token`) {
        const body = new URLSearchParams(String(init?.body ?? ""));
        if (body.get("grant_type") === "authorization_code") {
          return jsonResponse(200, {
            access_token: "access-1",
            token_type: "Bearer",
            expires_in: 60,
            refresh_token: "dead",
          });
        }
        return jsonResponse(400, {
          error: "invalid_grant",
          error_description: "unknown or already-rotated refresh token",
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const windowRef = createFakeWindow();
    const session = new OidcAuthSession(
      { issuer: ISSUER, clientId: "studio-test", redirectUri: REDIRECT_URI, scopes: [] },
      { fetchFn: fetchFn as unknown as typeof fetch, windowRef },
    );

    void session.signIn();
    await waitForAssign(windowRef);
    const assignedUrl = new URL((windowRef.location.assign as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string);
    const state = assignedUrl.searchParams.get("state") ?? "";
    await session.handleRedirectCallback(`${REDIRECT_URI}?code=auth-code-1&state=${encodeURIComponent(state)}`);
    expect(session.getState().status).toBe("fresh");

    const token = await session.getAccessToken({ forceRefresh: true });
    expect(token).toBeUndefined();
    expect(session.getState().status).toBe("signed-out");
  });

  it("isRedirectCallback() recognizes both a code+state success and an error callback", () => {
    const session = new OidcAuthSession(
      { issuer: ISSUER, clientId: "c", redirectUri: REDIRECT_URI, scopes: [] },
      { fetchFn: (async () => jsonResponse(200, discoveryDocument())) as unknown as typeof fetch },
    );
    expect(session.isRedirectCallback(`${REDIRECT_URI}?code=a&state=b`)).toBe(true);
    expect(session.isRedirectCallback(`${REDIRECT_URI}?error=access_denied`)).toBe(true);
    expect(session.isRedirectCallback(REDIRECT_URI)).toBe(false);
  });
});
