import { afterEach, describe, expect, it } from "vitest";

import {
  installRuntimeConfig,
  loadRuntimeConfig,
  parseRuntimeConfig,
  runtimeServerBaseUrl,
} from "../src/runtime-config.js";

const valid = {
  schemaVersion: "honua.studio.runtime-config.v1",
  serverBaseUrl: "https://honua.example/api/",
  oidc: {
    issuer: "https://id.example/",
    clientId: "studio",
    audience: "honua-api",
    scopes: ["openid", "honua.read"],
  },
  model: { mode: "server-proxy" },
};

afterEach(() => {
  installRuntimeConfig(undefined);
});

describe("runtime config", () => {
  it("parses and normalizes the versioned deployment contract", () => {
    const config = parseRuntimeConfig(valid);
    expect(config.serverBaseUrl).toBe("https://honua.example/api");
    expect(config.oidc.audience).toBe("honua-api");
  });

  it("rejects client-direct model transport without a base URL", () => {
    expect(() => parseRuntimeConfig({ ...valid, model: { mode: "client-direct" } })).toThrow(/model.baseUrl/);
  });

  it("loads config without cache and installs it as every client default", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(valid), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    installRuntimeConfig(await loadRuntimeConfig(fetchImpl));
    expect(calls).toEqual([{ input: "/config.json", init: { cache: "no-store" } }]);
    expect(runtimeServerBaseUrl()).toBe("https://honua.example/api");
  });

  it("fails closed when the deployment config cannot be loaded", async () => {
    const fetchImpl = (async () => new Response("missing", { status: 404 })) as typeof fetch;
    await expect(loadRuntimeConfig(fetchImpl)).rejects.toThrow(/404/);
  });
});
