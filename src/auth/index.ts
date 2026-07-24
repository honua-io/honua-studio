/**
 * `src/auth` — public surface (honua-studio#4).
 *
 * `createAuthSession()` is the one entry point main.ts calls: it picks
 * standalone OIDC ({@link OidcAuthSession}) or embed host-adapter mode
 * ({@link HostAdapterAuthSession}) and returns the shared {@link AuthSession}
 * contract either way. `detectHostSessionAdapter()` is how it decides —
 * see docs/embed-session.md for the detection contract.
 */
import { resolveOidcConfig } from "./config.js";
import { HostAdapterAuthSession } from "./host-session.js";
import { OidcAuthSession } from "./oidc-session.js";
import type { AuthSession, SessionAdapter } from "./types.js";

export type { OidcEnvConfig } from "./config.js";
export { resolveOidcConfig } from "./config.js";
export { discoverOidc, OidcDiscoveryError } from "./discovery.js";
export type { OidcDiscoveryDocument } from "./discovery.js";
export { HostAdapterAuthSession } from "./host-session.js";
export { OidcAuthSession } from "./oidc-session.js";
export { INITIAL_AUTH_STATE, reduceAuthState } from "./state-machine.js";
export type { AuthTransitionEvent } from "./state-machine.js";
export type {
  AuthSession,
  AuthSessionListener,
  AuthState,
  AuthStatus,
  GetAccessTokenOptions,
  SessionAdapter,
  Unsubscribe,
} from "./types.js";

/**
 * The well-known global a host page sets *before* Studio boots to hand it a
 * session (REQ-003). A future custom-element property (honua-studio#5) will
 * supersede this as the primary attach point; both will detect the same
 * {@link SessionAdapter} shape. See docs/embed-session.md.
 */
const HOST_SESSION_GLOBAL = "__HONUA_STUDIO_HOST_SESSION__";

function isSessionAdapter(value: unknown): value is SessionAdapter {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SessionAdapter>;
  return typeof candidate.getToken === "function" && typeof candidate.onExpired === "function";
}

/** Reads `window.__HONUA_STUDIO_HOST_SESSION__`, if present and shaped like a {@link SessionAdapter}. */
export function detectHostSessionAdapter(
  target: Window | undefined = typeof window === "undefined" ? undefined : window,
): SessionAdapter | undefined {
  if (!target) return undefined;
  const candidate = (target as unknown as Record<string, unknown>)[HOST_SESSION_GLOBAL];
  return isSessionAdapter(candidate) ? candidate : undefined;
}

export interface CreateAuthSessionOptions {
  /** Explicit host adapter (tests). Defaults to `detectHostSessionAdapter()`. */
  hostAdapter?: SessionAdapter;
  fetchFn?: typeof fetch;
  windowRef?: Window;
}

/** Constructs the one `AuthSession` the app uses — host-adapter mode when a host session is present, standalone OIDC otherwise. */
export function createAuthSession(options: CreateAuthSessionOptions = {}): AuthSession {
  const hostAdapter = options.hostAdapter ?? detectHostSessionAdapter();
  if (hostAdapter) {
    return new HostAdapterAuthSession(hostAdapter);
  }
  return new OidcAuthSession(resolveOidcConfig(), { fetchFn: options.fetchFn, windowRef: options.windowRef });
}
