/**
 * Embed-mode auth session (honua-studio#4 REQ-003).
 *
 * Consumes a host-provided {@link SessionAdapter} instead of running any
 * OIDC flow of its own. This is the load-bearing rule REQ-003 exists to
 * enforce: `signIn()` / `handleRedirectCallback()` are unreachable no-ops or
 * throw, and there is no code path here that ever navigates the browser or
 * calls a token endpoint. See docs/embed-session.md for the full contract
 * and rationale (including the REQ-011 admin-only note for Phase 0/1).
 */
import { type AuthTransitionEvent, INITIAL_AUTH_STATE, reduceAuthState } from "./state-machine.js";
import type { AuthSession, AuthSessionListener, AuthState, SessionAdapter, Unsubscribe } from "./types.js";

export class HostAdapterAuthSession implements AuthSession {
  readonly mode = "host-adapter" as const;

  private state: AuthState = INITIAL_AUTH_STATE;
  private readonly listeners = new Set<AuthSessionListener>();
  private readonly unsubscribeExpired: Unsubscribe;

  constructor(private readonly adapter: SessionAdapter) {
    this.unsubscribeExpired = this.adapter.onExpired(() => {
      this.dispatch({ type: "refresh-failed", error: "The host session expired." });
    });
    // Resolve the host's token proactively (fire-and-forget) rather than
    // waiting for the first outgoing API request to ask for one — otherwise
    // any UI gated on `status === "fresh"` (see src/pages/home.ts) would
    // never leave "signed-out", since nothing else calls getAccessToken()
    // until a request needs it.
    void this.getAccessToken();
  }

  getState(): AuthState {
    return this.state;
  }

  subscribe(listener: AuthSessionListener): Unsubscribe {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getAccessToken(): Promise<string | undefined> {
    let token: string | undefined;
    try {
      token = await this.adapter.getToken();
    } catch (error) {
      this.dispatch({ type: "refresh-failed", error: describeError(error) });
      return undefined;
    }
    if (!token) {
      this.dispatch({ type: "refresh-failed", error: "The host session returned no token." });
      return undefined;
    }
    this.dispatch({ type: "credential-issued", accessToken: token });
    return token;
  }

  isRedirectCallback(_url?: string): boolean {
    return false;
  }

  async handleRedirectCallback(_url?: string): Promise<void> {
    // Never applicable: the host owns the whole session lifecycle, so no
    // redirect back to this app is ever part of the auth flow.
  }

  async signIn(): Promise<void> {
    throw new Error(
      "Host-adapter auth mode never initiates its own sign-in flow (honua-studio#4 REQ-003) — " +
        "the host page owns the session lifecycle. See docs/embed-session.md.",
    );
  }

  async signOut(): Promise<void> {
    throw new Error(
      "Host-adapter auth mode never initiates its own sign-out (honua-studio#4 REQ-003) — " +
        "the host page owns the session lifecycle. See docs/embed-session.md.",
    );
  }

  /** Detaches from the host's onExpired subscription. Call when the app unmounts. */
  dispose(): void {
    this.unsubscribeExpired();
  }

  private dispatch(event: AuthTransitionEvent): void {
    this.state = reduceAuthState(this.state, event);
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
