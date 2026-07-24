import { defineConfig } from "vite";

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

export default defineConfig(({ mode }) => {
  if (mode === "live" && !honuaBaseUrl) {
    throw new Error(
      "HONUA_BASE_URL must be set to run Honua Studio in live mode. " +
        "Example: HONUA_BASE_URL=http://localhost:8080 npm run dev:live",
    );
  }

  const proxy = honuaBaseUrl
    ? {
        "/api": {
          target: honuaBaseUrl,
          changeOrigin: true,
          rewrite: (requestPath: string) => requestPath.replace(/^\/api/, ""),
        },
        "/oidc": {
          target: honuaBaseUrl,
          changeOrigin: true,
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
  };
});
