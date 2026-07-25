import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

// Resolved once per vite invocation (dev / dev:live / build / preview each
// spawn a fresh process). Neither dev mode bakes this URL into client code —
// the bundle always calls the relative /api/* and /oidc/* paths in
// src/client/studio-client.ts and src/auth/config.ts; only the server-side
// proxy target changes. See scripts/dev-mock.mjs (fixture mode) and
// README.md (live mode).
//
// /oidc is a *discovery-bootstrap* convenience, not the whole OIDC surface:
// the mock issuer's discovery document (honua-studio#4) returns absolute
// authorize/token/revoke URLs on its own origin, so only the initial
// `.well-known/openid-configuration` fetch actually needs this proxy entry.
// A real deployment's external IdP is reached directly via an absolute
// HONUA_OIDC_ISSUER baked in at build time (see src/auth/config.ts) — /oidc
// here exists purely so `npm run dev` / the Playwright fixture builds can
// swap issuers per run without rebaking the bundle, exactly like /api.
const honuaBaseUrl = process.env.HONUA_BASE_URL;

// Optional admin API key for LIVE runs against a real honua-server (e.g. the
// demo environment): when set, the dev/preview PROXY attaches it server-side
// as `X-API-Key` on every forwarded request. The key never reaches client
// code or the built bundle — it lives only in this Node process, exactly the
// posture README.md documents for live-mode credentials. The client keeps
// sending its own bearer header (or none); honua-server authenticates the
// request off the injected API key. Used by
// test/playwright/live-demo-journeys.spec.mjs (HONUA_LIVE_API_KEY is passed
// through as HONUA_API_KEY when it spawns `vite preview`).
const honuaApiKey = process.env.HONUA_API_KEY;

export default defineConfig(({ mode }) => {
  if (mode === "live" && !honuaBaseUrl) {
    throw new Error(
      "HONUA_BASE_URL must be set to run Honua Studio in live mode. " +
        "Example: HONUA_BASE_URL=http://localhost:8080 npm run dev:live",
    );
  }

  const apiKeyHeaders = honuaApiKey ? { "x-api-key": honuaApiKey } : undefined;
  const proxy = honuaBaseUrl
    ? {
        "/api": {
          target: honuaBaseUrl,
          changeOrigin: true,
          rewrite: (requestPath: string) => requestPath.replace(/^\/api/, ""),
          ...(apiKeyHeaders ? { headers: apiKeyHeaders } : {}),
        },
        "/oidc": {
          target: honuaBaseUrl,
          changeOrigin: true,
        },
        // MCP lives at the server ORIGIN's /mcp (honua-server#3002 serves it
        // at the root, not under the REST /api prefix). Against the mock
        // fixture HONUA_BASE_URL has no path, so this target is identical to
        // the base itself (and the fixture's /mcp is also reachable via the
        // /api rewrite above — both paths keep working); against a real
        // deployment whose HONUA_BASE_URL carries an /api path (e.g.
        // https://demo.honua.io/api) this strips the path so /mcp resolves
        // at the origin. Used by live MCP journeys via
        // `enableLiveComposition({ baseUrl: "" })`.
        "/mcp": {
          target: new URL(honuaBaseUrl).origin,
          changeOrigin: true,
          ...(apiKeyHeaders ? { headers: apiKeyHeaders } : {}),
        },
      }
    : undefined;

  return {
    // Exposes HONUA_* env vars to client code (import.meta.env.HONUA_*) on
    // top of Vite's default VITE_* prefix — unused today (the client only
    // ever fetches relative /api paths) but kept available for REQ-003's
    // future needs (e.g. surfacing which server is connected in the UI).
    envPrefix: ["VITE_", "HONUA_"],
    server: { proxy },
    preview: { proxy },
    build: {
      // Multi-page build (honua-studio#5): the standalone shell (index.html)
      // plus the bare embed harness (harness/bare/index.html), so
      // `vite preview` — what test/playwright/helpers.mjs's
      // startPreviewServer spins up for every browser spec, including the
      // bare-harness one — serves both from the same static output without
      // a second dev server or build step.
      rollupOptions: {
        input: {
          main: resolve(projectRoot, "index.html"),
          bareHarness: resolve(projectRoot, "harness/bare/index.html"),
        },
      },
    },
  };
});
