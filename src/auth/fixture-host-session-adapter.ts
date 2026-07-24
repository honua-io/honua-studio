/**
 * A controllable, in-memory {@link SessionAdapter} fixture (honua-studio#4
 * REQ-003) — implements the exact interface documented in
 * docs/embed-session.md so unit and browser tests can drive
 * {@link HostAdapterAuthSession} against a real object that satisfies the
 * contract, not a hand-rolled mock. Never imported by app code; test-only.
 */
import type { SessionAdapter, Unsubscribe } from "./types.js";

export interface FixtureHostSessionAdapter extends SessionAdapter {
  /** Sets the token `getToken()` resolves next. `undefined` simulates "no session". */
  setToken(token: string | undefined): void;
  /** Fires every subscriber registered via `onExpired`. */
  triggerExpired(): void;
  /** Number of currently-registered `onExpired` listeners. */
  readonly listenerCount: number;
}

export function createFixtureHostSessionAdapter(initialToken?: string): FixtureHostSessionAdapter {
  let token = initialToken;
  const listeners = new Set<() => void>();

  return {
    async getToken(): Promise<string | undefined> {
      return token;
    },
    onExpired(listener: () => void): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setToken(next: string | undefined): void {
      token = next;
    },
    triggerExpired(): void {
      for (const listener of listeners) {
        listener();
      }
    },
    get listenerCount(): number {
      return listeners.size;
    },
  };
}
