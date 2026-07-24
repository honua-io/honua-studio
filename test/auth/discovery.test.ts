import { describe, expect, it, vi } from "vitest";

import { OidcDiscoveryError, discoverOidc } from "../../src/auth/discovery.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("discoverOidc", () => {
  it("fetches .well-known/openid-configuration relative to the issuer", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://idp.example/.well-known/openid-configuration");
      return jsonResponse(200, {
        issuer: "https://idp.example",
        authorization_endpoint: "https://idp.example/authorize",
        token_endpoint: "https://idp.example/token",
      });
    });

    const document = await discoverOidc("https://idp.example", fetchFn as unknown as typeof fetch);
    expect(document.authorization_endpoint).toBe("https://idp.example/authorize");
    expect(document.token_endpoint).toBe("https://idp.example/token");
  });

  it("works whether or not the issuer has a trailing slash", async () => {
    const seen: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return jsonResponse(200, {
        issuer: "https://idp.example/oidc",
        authorization_endpoint: "https://idp.example/oidc/authorize",
        token_endpoint: "https://idp.example/oidc/token",
      });
    });

    await discoverOidc("https://idp.example/oidc", fetchFn as unknown as typeof fetch);
    await discoverOidc("https://idp.example/oidc/", fetchFn as unknown as typeof fetch);
    expect(seen).toEqual([
      "https://idp.example/oidc/.well-known/openid-configuration",
      "https://idp.example/oidc/.well-known/openid-configuration",
    ]);
  });

  it("throws OidcDiscoveryError on a non-OK response", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(500, { error: "boom" }));
    await expect(discoverOidc("https://idp.example", fetchFn as unknown as typeof fetch)).rejects.toThrow(
      OidcDiscoveryError,
    );
  });

  it("throws OidcDiscoveryError when the document is missing required endpoints", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { issuer: "https://idp.example" }));
    await expect(discoverOidc("https://idp.example", fetchFn as unknown as typeof fetch)).rejects.toThrow(
      OidcDiscoveryError,
    );
  });

  it("throws OidcDiscoveryError when the network request itself fails", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("network down");
    });
    await expect(discoverOidc("https://idp.example", fetchFn as unknown as typeof fetch)).rejects.toThrow(
      OidcDiscoveryError,
    );
  });
});
