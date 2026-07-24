/**
 * Pure token-lifecycle reducer (honua-studio#4): fresh -> refresh -> rotate,
 * or -> expire. Kept independent of the OAuth2 provider / DOM / network so
 * the state machine itself is directly unit-testable — see
 * test/auth/state-machine.test.ts. {@link OidcAuthSession} and
 * {@link HostAdapterAuthSession} are both thin drivers of this reducer.
 */
import type { AuthState } from "./types.js";

export type AuthTransitionEvent =
  | { type: "sign-in-started" }
  | { type: "callback-started" }
  /** A credential was issued for the first time (sign-in or callback exchange completed). */
  | { type: "credential-issued"; accessToken: string; expiresAt?: number }
  /** A refresh round-trip started — the previous access token, if any, is still usable in flight. */
  | { type: "refresh-started" }
  /** The refresh round-trip minted a new access token (and, for rotation, a new refresh token). */
  | { type: "token-rotated"; accessToken: string; expiresAt?: number }
  | { type: "refresh-failed"; error: string }
  | { type: "signed-out" };

export const INITIAL_AUTH_STATE: AuthState = { status: "signed-out" };

export function reduceAuthState(state: AuthState, event: AuthTransitionEvent): AuthState {
  switch (event.type) {
    case "sign-in-started":
      return { status: "signing-in" };
    case "callback-started":
      return { status: "authenticating" };
    case "credential-issued":
      return { status: "fresh", accessToken: event.accessToken, expiresAt: event.expiresAt };
    case "refresh-started":
      return { ...state, status: "refreshing" };
    case "token-rotated":
      return { status: "fresh", accessToken: event.accessToken, expiresAt: event.expiresAt };
    case "refresh-failed":
      return { status: "expired", error: event.error };
    case "signed-out":
      return { status: "signed-out" };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
