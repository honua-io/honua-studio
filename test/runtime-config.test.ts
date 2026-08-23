// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { getRuntimeConfig, loadRuntimeConfig, normalizeRuntimeConfig } from "../src/runtime-config.js";

describe("runtime config", () => {
  afterEach(() => {
    window.__HONUA_STUDIO_CONFIG__ = undefined;
  });

  it("normalizes server, OIDC, and BYOM routing without credentials", () => {
    expect(
      normalizeRuntimeConfig({
        serverBaseUrl: " https://honua.example ",
        oidc: { issuer: "https://idp.example", clientId: "studio", scopes: "openid honua.read" },
        model: { provider: "bedrock", model: "operator-default" },
      }),
    ).toEqual({
      serverBaseUrl: "https://honua.example",
      oidc: {
        issuer: "https://idp.example",
        clientId: "studio",
        redirectUri: undefined,
        scopes: ["openid", "honua.read"],
      },
      model: { provider: "bedrock", model: "operator-default" },
    });
  });

  it("loads config once into the runtime global", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ serverBaseUrl: "https://honua.example" }), { status: 200 });
    await loadRuntimeConfig({ fetchImpl: fetchImpl as typeof fetch, target: window });
    expect(getRuntimeConfig(window).serverBaseUrl).toBe("https://honua.example");
  });

  it("uses same-origin defaults when config.json is absent", async () => {
    const config = await loadRuntimeConfig({
      fetchImpl: (async () => new Response(null, { status: 404 })) as typeof fetch,
    });
    expect(config).toEqual({ serverBaseUrl: "/api" });
  });
});
