/**
 * Auth session contract (honua-studio#4 REQ-001/002/003).
 *
 * `AuthSession` is the one surface the rest of the app depends on — the app
 * shell (login/logout controls, signed-in state) and the Studio client
 * (bearer attachment, 401 retry) never know whether they're driving a
 * standalone OIDC flow ({@link OidcAuthSession}) or an embed host's session
 * ({@link HostAdapterAuthSession}, see docs/embed-session.md). Exactly one of
 * those two implementations is ever constructed per app instance — see
 * `createAuthSession` in `src/auth/index.ts`.
 */

/** Discrete stages of the token lifecycle: fresh -> refresh -> rotate, or -> expire. */
export type AuthStatus = "signed-out" | "signing-in" | "authenticating" | "fresh" | "refreshing" | "expired";

/** A single point-in-time snapshot of the auth session. */
export interface AuthState {
  status: AuthStatus;
  /** The current bearer access token, when `status` is "fresh" or "refreshing". */
  accessToken?: string;
  /** Absolute expiry (epoch ms) of `accessToken`, when known. */
  expiresAt?: number;
  /** Set on "expired" — a human-readable reason surfaced by the UI. */
  error?: string;
}

export type AuthSessionListener = (state: AuthState) => void;
/** Call to unsubscribe. */
export type Unsubscribe = () => void;

/**
 * Contract every embed host must satisfy to hand its session to Studio
 * (REQ-003). Fully documented in docs/embed-session.md — that document is
 * the source of truth this type mirrors.
 */
export interface SessionAdapter {
  /**
   * Resolve the current bearer token, refreshing on the host's side if the
   * host deems it necessary. Resolve to `undefined` (never throw for the
   * "no session" case) when no token is available — Studio treats that as
   * "expired" and never attempts its own sign-in.
   */
  getToken(): Promise<string | undefined>;
  /**
   * Subscribe to the host's session-expiry notification. Studio calls this
   * once, at construction, and surfaces "expired" the moment it fires.
   */
  onExpired(listener: () => void): Unsubscribe;
}

export interface GetAccessTokenOptions {
  /** Force a refresh even if the current credential looks unexpired (used for the 401 retry). */
  forceRefresh?: boolean;
}

/** The common surface both auth-session implementations expose. */
export interface AuthSession {
  readonly mode: "standalone" | "host-adapter";
  getState(): AuthState;
  subscribe(listener: AuthSessionListener): Unsubscribe;
  /** Resolve the current bearer token (or `undefined` when signed out / expired). Never throws. */
  getAccessToken(options?: GetAccessTokenOptions): Promise<string | undefined>;
  /** Whether the current URL looks like an OAuth2 redirect callback. Always `false` in host-adapter mode. */
  isRedirectCallback(url?: string): boolean;
  /** Complete a redirect callback. No-op in host-adapter mode. */
  handleRedirectCallback(url?: string): Promise<void>;
  /**
   * Start interactive sign-in. Standalone mode redirects the browser;
   * host-adapter mode always rejects — REQ-003 requires the embed session to
   * never initiate its own flow.
   */
  signIn(): Promise<void>;
  /** Clear the session. Standalone mode also revokes server-side; host-adapter mode always rejects. */
  signOut(): Promise<void>;
}
