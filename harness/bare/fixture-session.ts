/**
 * A minimal fixture implementation of {@link HonuaStudioSessionAdapter}
 * (src/elements/types.ts, docs/embed-session.md) — exactly what a
 * third-party host wires up in place of a real OIDC session (honua-studio#4)
 * to prove session injection end to end without a live honua-server. No
 * network, no tokens beyond a fixed string; a real host's adapter differs
 * only in what backs `getAccessToken`/`onChange`, never in shape.
 */
import type { HonuaStudioSessionAdapter, HonuaStudioSessionSnapshot } from "../../src/elements/types.js";

export function createFixtureSession(baseUrl = "/api"): HonuaStudioSessionAdapter {
  let snapshot: HonuaStudioSessionSnapshot = { status: "authenticated", subject: "fixture-user" };
  const listeners = new Set<(snapshot: HonuaStudioSessionSnapshot) => void>();

  const adapter: HonuaStudioSessionAdapter & { setSnapshot(next: HonuaStudioSessionSnapshot): void } = {
    baseUrl,
    getSnapshot: () => snapshot,
    getAccessToken: async () => (snapshot.status === "authenticated" ? "fixture-token" : undefined),
    onChange(listener) {
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    },
    // Fixture-only escape hatch (not part of HonuaStudioSessionAdapter) so
    // the Playwright spec can flip auth state and assert the element
    // reacts via onChange — a real adapter's equivalent is whatever drives
    // its own login/logout/refresh.
    setSnapshot(next) {
      snapshot = next;
      for (const listener of listeners) listener(snapshot);
    },
  };
  return adapter;
}
