/**
 * A minimal fixture implementation of `SessionAdapter`
 * (src/auth/types.ts, docs/embed-session.md) — exactly what a third-party
 * host wires up in place of a real OIDC session (honua-studio#4) to prove
 * session injection end to end without a live honua-server. No network; the
 * bearer token itself is supplied by the caller (a real, signed
 * `mintFixtureAccessToken()` JWT in the Playwright specs — see
 * test/playwright/bare-harness.spec.mjs and blazor-host.spec.mjs — since
 * the mock honua-server's catalog/packages endpoints validate it, unlike
 * this adapter's own `getToken()`/`onExpired()`, which are unconditional).
 */
import type { SessionAdapter } from "../../src/elements/types.js";

export interface FixtureSessionAdapter extends SessionAdapter {
  /** Fixture-only escape hatch (not part of `SessionAdapter`) so a Playwright spec can drive `onExpired`. */
  triggerExpired(): void;
}

export function createFixtureSession(token: string | undefined = "fixture-token"): FixtureSessionAdapter {
  const listeners = new Set<() => void>();

  return {
    async getToken(): Promise<string | undefined> {
      return token;
    },
    onExpired(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    triggerExpired(): void {
      for (const listener of listeners) listener();
    },
  };
}
