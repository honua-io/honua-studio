/**
 * OIDC client configuration (honua-studio#4 REQ-001).
 *
 * Two addressing modes, chosen per env var:
 *
 * - **Live / production** (`HONUA_OIDC_ISSUER` set): an absolute URL to the
 *   operator's real external IdP, baked into the client bundle at build
 *   time via Vite's `envPrefix` (vite.config.ts). The browser talks to that
 *   IdP directly, cross-origin — exactly what a public OIDC client does.
 * - **Fixture / dev default** (nothing set): `${origin}/oidc`, proxied by
 *   vite.config.ts's dev/preview `/oidc` rule to whatever `HONUA_BASE_URL`
 *   points at (scripts/dev-mock.mjs, or the Playwright fixture harnesses).
 *   This mirrors `StudioClient`'s `/api` default so one build works against
 *   a fresh mock issuer per test run without rebaking the bundle.
 */

export interface OidcEnvConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  audience?: string;
}

import { runtimeConfig } from "../runtime-config.js";

const DEV_DEFAULT_ISSUER_PATH = "/oidc";
const DEV_DEFAULT_CLIENT_ID = "honua-studio-dev";
const DEV_DEFAULT_SCOPES = "openid profile honua.read honua.write";

/** `window.location.origin`, or a harmless placeholder outside a browser (e.g. Node-environment unit tests). */
function defaultOrigin(): string {
  return typeof window === "undefined" ? "http://localhost" : window.location.origin;
}

/** Resolves the OIDC client config from Vite env vars, defaulting to the same-origin dev fixture path. */
export function resolveOidcConfig(
  env: ImportMetaEnv = import.meta.env,
  origin: string = defaultOrigin(),
): OidcEnvConfig {
  const runtime = runtimeConfig();
  const runtimeIssuer = runtime.oidc.issuer.startsWith("/") ? `${origin}${runtime.oidc.issuer}` : runtime.oidc.issuer;
  const issuer = readEnv(env, "HONUA_OIDC_ISSUER") || runtimeIssuer || `${origin}${DEV_DEFAULT_ISSUER_PATH}`;
  const clientId = readEnv(env, "HONUA_OIDC_CLIENT_ID") || runtime.oidc.clientId || DEV_DEFAULT_CLIENT_ID;
  const redirectUri = readEnv(env, "HONUA_OIDC_REDIRECT_URI") || `${origin}/`;
  const scopesRaw = readEnv(env, "HONUA_OIDC_SCOPES") || runtime.oidc.scopes.join(" ") || DEV_DEFAULT_SCOPES;
  const scopes = scopesRaw.split(/\s+/).filter((scope) => scope.length > 0);
  return {
    issuer,
    clientId,
    redirectUri,
    scopes,
    ...(runtime.oidc.audience ? { audience: runtime.oidc.audience } : {}),
  };
}

function readEnv(env: ImportMetaEnv, key: string): string | undefined {
  const value = (env as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
