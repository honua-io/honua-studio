/**
 * Exercises mock-server.mjs's OIDC issuer + protected Studio routes over
 * real loopback HTTP (honua-studio#4 REQ-001) — the same fixture
 * scripts/dev-mock.mjs and the Playwright specs drive, just without a
 * browser. Proves the discovery document, PKCE-verified authorization-code
 * exchange, bearer-gated catalog/packages routes, and refresh-token
 * ROTATION (P2-8: a spent refresh token never works twice) all hold end to
 * end against the actual fixture — not a re-implementation of it.
 */
import { createHash, randomBytes } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { OIDC_CLIENT_ID, startMockServer } from "../mock-server.mjs";

let server: Awaited<ReturnType<typeof startMockServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function pkcePair() {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

async function signInAndGetTokens(
  baseUrl: string,
  discovery: { authorization_endpoint: string; token_endpoint: string },
) {
  const { codeVerifier, codeChallenge } = pkcePair();
  const redirectUri = `${baseUrl}/callback`;
  const authorizeUrl = new URL(discovery.authorization_endpoint);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", OIDC_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", "state-1");
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" });
  expect(authorizeResponse.status).toBe(302);
  const location = new URL(authorizeResponse.headers.get("location") ?? "", baseUrl);
  expect(location.searchParams.get("state")).toBe("state-1");
  const code = location.searchParams.get("code");
  expect(code).toBeTruthy();

  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code ?? "",
      redirect_uri: redirectUri,
      client_id: OIDC_CLIENT_ID,
      code_verifier: codeVerifier,
    }),
  });
  expect(tokenResponse.status).toBe(200);
  return (await tokenResponse.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
  };
}

describe("mock-server.mjs OIDC issuer + protected Studio routes", () => {
  it("serves a discovery document with the standard endpoints", async () => {
    server = await startMockServer();
    const response = await fetch(`${server.url}/oidc/.well-known/openid-configuration`);
    expect(response.status).toBe(200);
    const document = await response.json();
    expect(document.issuer).toBe(`${server.url}/oidc`);
    expect(document.authorization_endpoint).toBe(`${server.url}/oidc/authorize`);
    expect(document.token_endpoint).toBe(`${server.url}/oidc/token`);
    expect(document.code_challenge_methods_supported).toContain("S256");
    expect(document.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  });

  it("rejects an authorize request without PKCE", async () => {
    server = await startMockServer();
    const url = new URL(`${server.url}/oidc/authorize`);
    url.searchParams.set("client_id", OIDC_CLIENT_ID);
    url.searchParams.set("redirect_uri", `${server.url}/callback`);
    const response = await fetch(url);
    expect(response.status).toBe(400);
  });

  it("rejects the token exchange when code_verifier doesn't match the challenge", async () => {
    server = await startMockServer();
    const discoveryResponse = await fetch(`${server.url}/oidc/.well-known/openid-configuration`);
    const discovery = await discoveryResponse.json();
    const { codeChallenge } = pkcePair();
    const redirectUri = `${server.url}/callback`;
    const authorizeUrl = new URL(discovery.authorization_endpoint);
    authorizeUrl.searchParams.set("client_id", OIDC_CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", "s");
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    const authorizeResponse = await fetch(authorizeUrl, { redirect: "manual" });
    const location = new URL(authorizeResponse.headers.get("location") ?? "", server.url);

    const tokenResponse = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: location.searchParams.get("code") ?? "",
        redirect_uri: redirectUri,
        client_id: OIDC_CLIENT_ID,
        code_verifier: "wrong-verifier",
      }),
    });
    expect(tokenResponse.status).toBe(400);
    const body = await tokenResponse.json();
    expect(body.error).toBe("invalid_grant");
  });

  it("gates the catalog and packages routes behind a valid bearer token", async () => {
    server = await startMockServer();
    const unauthorized = await fetch(`${server.url}/v1/studio/catalog`);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toBe("Bearer");

    const discovery = await (await fetch(`${server.url}/oidc/.well-known/openid-configuration`)).json();
    const tokens = await signInAndGetTokens(server.url, discovery);

    const catalogResponse = await fetch(`${server.url}/v1/studio/catalog`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(catalogResponse.status).toBe(200);
    const catalog = await catalogResponse.json();
    expect(catalog.datasets.length).toBeGreaterThan(0);

    const packagesResponse = await fetch(`${server.url}/v1/studio/packages`, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(packagesResponse.status).toBe(200);
  });

  it("rejects a garbage bearer token", async () => {
    server = await startMockServer();
    const response = await fetch(`${server.url}/v1/studio/catalog`, {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(response.status).toBe(401);
  });

  it("rotates the refresh token: the old one stops working the moment the new one is issued", async () => {
    server = await startMockServer();
    const discovery = await (await fetch(`${server.url}/oidc/.well-known/openid-configuration`)).json();
    const tokens = await signInAndGetTokens(server.url, discovery);

    const firstRefresh = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: OIDC_CLIENT_ID,
      }),
    });
    expect(firstRefresh.status).toBe(200);
    const rotated = await firstRefresh.json();
    // The refresh token is always freshly random. The access-token JWT is
    // reproducible-by-design (same claims -> same signature) and can
    // legitimately collide with the pre-refresh one when both are minted
    // within the same one-second `iat` — rotation is proven by the
    // refresh_token check above and the replay/second-refresh checks below,
    // not by asserting the access token bytes differ.
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);

    // Replaying the ORIGINAL (now-spent) refresh token must fail — this is
    // the P2-8 rotation guarantee, not silent-iframe refresh.
    const replay = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: OIDC_CLIENT_ID,
      }),
    });
    expect(replay.status).toBe(400);
    const replayBody = await replay.json();
    expect(replayBody.error).toBe("invalid_grant");

    // The rotated token, unlike the replayed one, still works.
    const secondRefresh = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: rotated.refresh_token,
        client_id: OIDC_CLIENT_ID,
      }),
    });
    expect(secondRefresh.status).toBe(200);
  });

  it("access tokens are short-lived JWTs carrying the fixture user's claims", async () => {
    server = await startMockServer();
    const discovery = await (await fetch(`${server.url}/oidc/.well-known/openid-configuration`)).json();
    const tokens = await signInAndGetTokens(server.url, discovery);

    expect(tokens.expires_in).toBeLessThanOrEqual(60);
    const parts = tokens.access_token.split(".");
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    expect(payload.sub).toBe("studio-dev-user");
    expect(payload.aud).toBe(OIDC_CLIENT_ID);
    expect(typeof payload.exp).toBe("number");
  });

  it("revokes a refresh token via /oidc/revoke", async () => {
    server = await startMockServer();
    const discovery = await (await fetch(`${server.url}/oidc/.well-known/openid-configuration`)).json();
    const tokens = await signInAndGetTokens(server.url, discovery);

    const revokeResponse = await fetch(discovery.revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.refresh_token, client_id: OIDC_CLIENT_ID }),
    });
    expect(revokeResponse.status).toBe(200);

    const refreshAfterRevoke = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: OIDC_CLIENT_ID,
      }),
    });
    expect(refreshAfterRevoke.status).toBe(400);
  });
});
