import { once } from "node:events";
import { type Server, createServer as createHttpServer } from "node:http";
import { build, createServer as createViteServer, loadEnv } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("real server proxy routes", () => {
  it.each(["fixture-key", undefined])(
    "selects the proxy credential without a conflicting bearer when API key is %s",
    async (apiKey) => {
      const upstream = createHttpServer((request, response) => {
        const authorized = apiKey
          ? !request.headers.authorization && request.headers["x-api-key"] === apiKey
          : request.headers.authorization === "Bearer valid-server-session" && !request.headers["x-api-key"];
        response.writeHead(authorized ? 200 : 401);
        response.end("{}");
      });
      const upstreamUrl = await listen(upstream);
      vi.stubEnv("HONUA_BASE_URL", `${upstreamUrl}/api`);
      vi.stubEnv("HONUA_API_KEY", apiKey);
      const { default: defineConfig } = await import("../vite.config.js");
      if (typeof defineConfig !== "function") throw new Error("Expected the Vite configuration factory");
      const config = await defineConfig({ command: "serve", mode: "live", isSsrBuild: false, isPreview: false });
      const vite = await createViteServer({
        configFile: false,
        server: { middlewareMode: true, proxy: config.server?.proxy },
      });
      const proxy = createHttpServer(vite.middlewares);
      try {
        const proxyUrl = await listen(proxy);
        for (const path of ["/api/v1/studio/content-items", "/mcp", "/rest/services", "/ogc/features"]) {
          const response = await fetch(`${proxyUrl}${path}`, {
            headers: { authorization: apiKey ? "Bearer live-proxy-placeholder" : "Bearer valid-server-session" },
          });
          expect(response.status, path).toBe(200);
          await response.text();
        }
      } finally {
        await vite.close();
        await Promise.all([close(proxy), close(upstream)]);
      }
    },
  );
  it("exposes public OIDC settings while keeping live credentials outside the browser environment", async () => {
    const publicSettings = {
      HONUA_OIDC_ISSUER: "https://identity.example.test",
      HONUA_OIDC_CLIENT_ID: "studio",
      HONUA_OIDC_REDIRECT_URI: "https://studio.example.test/",
      HONUA_OIDC_SCOPES: "openid profile",
    };
    const credentials = ["HONUA_API_KEY", "HONUA_LIVE_API_KEY", "HONUA_LIVE_HUMAN_TOKEN", "HONUA_OIDC_CLIENT_SECRET"];
    for (const [name, value] of Object.entries(publicSettings)) vi.stubEnv(name, value);
    for (const name of credentials) vi.stubEnv(name, `fixture-${name}`);
    const { default: defineConfig } = await import("../vite.config.js");
    if (typeof defineConfig !== "function") throw new Error("Expected the Vite configuration factory");
    const config = await defineConfig({ command: "build", mode: "production", isSsrBuild: false, isPreview: false });
    const browserEnv = loadEnv("production", process.cwd(), config.envPrefix);
    expect(browserEnv).toMatchObject(publicSettings);
    for (const name of credentials) expect(browserEnv).not.toHaveProperty(name);
    const result = await build({
      configFile: false,
      envPrefix: config.envPrefix,
      logLevel: "silent",
      build: { write: false, lib: { entry: "src/auth/config.ts", formats: ["es"] } },
    });
    const bundles = Array.isArray(result) ? result : [result];
    const bundle = bundles
      .flatMap((output) => ("output" in output ? output.output : []))
      .map((file) => (file.type === "chunk" ? file.code : ""))
      .join("\n");
    expect(bundle).toContain(publicSettings.HONUA_OIDC_ISSUER);
    for (const name of credentials) expect(bundle).not.toContain(`fixture-${name}`);
  });

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

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback listener");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
