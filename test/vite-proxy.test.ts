import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("real server proxy routes", () => {
  it.each([
    ["https://host/honua/api", "https://host/honua"],
    ["https://host/honua/api/", "https://host/honua"],
    ["http://localhost:8080", "http://localhost:8080"],
  ])("preserves deployment prefix for %s", async (upstream, expectedRoot) => {
    vi.stubEnv("HONUA_BASE_URL", upstream);
    vi.resetModules();
    const { default: defineConfig } = await import("../vite.config.js");
    if (typeof defineConfig !== "function") throw new Error("Expected the Vite configuration factory");
    const config = await defineConfig({ command: "serve", mode: "live", isSsrBuild: false, isPreview: false });
    const proxy = config.server?.proxy;
    for (const path of ["/api", "/rest", "/ogc", "/mcp"]) {
      expect(proxy?.[path]).toMatchObject({ target: expectedRoot });
    }
    const api = proxy?.["/api"];
    if (!api || typeof api === "string") throw new Error("Expected API proxy options");
    expect(api.rewrite?.("/api/v1/studio/content-items?limit=100")).toBe("/api/v1/studio/content-items?limit=100");
    expect(api.rewrite?.("/api/health")).toBe("/health");
  });
});
