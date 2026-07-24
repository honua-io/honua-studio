import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

// Resolved once per vite invocation (dev / dev:live / build / preview each
// spawn a fresh process). Neither dev mode bakes this URL into client code —
// the bundle always calls the relative /api/* paths in
// src/client/studio-client.ts; only the server-side proxy target changes.
// See scripts/dev-mock.mjs (fixture mode) and README.md (live mode).
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
