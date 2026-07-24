/**
 * honua-studio doesn't reimplement PKCE — src/auth/oidc-session.ts drives
 * `@honua/sdk-js/auth`'s `oauth2()` provider, which owns verifier/challenge
 * generation (see honua-sdk-js's examples/oauth-signin, the established
 * seam this workstream builds on). These tests hold that dependency to
 * RFC 7636 so a seam regression fails here, not silently in the browser.
 */
import { createHash } from "node:crypto";

import { createPkcePair, createStateToken } from "@honua/sdk-js/auth";
import { describe, expect, it } from "vitest";

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function independentS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

describe("PKCE helpers (@honua/sdk-js/auth)", () => {
  it("generates a verifier within RFC 7636's 43-128 char range, base64url only", async () => {
    const { codeVerifier } = await createPkcePair();
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(codeVerifier.length).toBeLessThanOrEqual(128);
    expect(codeVerifier).toMatch(BASE64URL_PATTERN);
  });

  it("computes the S256 challenge as BASE64URL(SHA-256(verifier))", async () => {
    const { codeVerifier, codeChallenge, codeChallengeMethod } = await createPkcePair();
    expect(codeChallengeMethod).toBe("S256");
    expect(codeChallenge).toMatch(BASE64URL_PATTERN);
    expect(codeChallenge).toBe(independentS256Challenge(codeVerifier));
  });

  it("never repeats a verifier across calls", async () => {
    const pairs = await Promise.all(Array.from({ length: 10 }, () => createPkcePair()));
    const verifiers = new Set(pairs.map((pair) => pair.codeVerifier));
    expect(verifiers.size).toBe(pairs.length);
  });

  it("generates a high-entropy, base64url state token that differs every call", () => {
    const a = createStateToken();
    const b = createStateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect(a).toMatch(BASE64URL_PATTERN);
  });
});
