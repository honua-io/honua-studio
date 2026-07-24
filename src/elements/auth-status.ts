import type { AuthState } from "../auth/types.js";

/**
 * Shared human-readable labels for `AuthState["status"]` (honua-studio#4's
 * vocabulary — `src/auth/state-machine.ts`), so `<honua-studio-app>`'s
 * status label and `<honua-studio-chat>`'s session-status display never
 * drift into two different wordings for the same six states.
 */
export const AUTH_STATUS_LABELS: Record<AuthState["status"], string> = {
  "signed-out": "Signed out",
  "signing-in": "Signing in…",
  authenticating: "Completing sign-in…",
  fresh: "Signed in",
  refreshing: "Signed in",
  expired: "Session expired",
};
