# Host-session adapter coordination note

**Status: TODO(honua-studio#4).** honua-studio#4 ("OIDC sign-in and
authenticated honua-server session") owns the real host-session adapter —
OIDC login/logout/refresh, in-memory tokens with silent refresh, and the
"embed mode consumes a host-provided session and never initiates its own
flow" contract (REQ-003). As of honua-studio#5, #4's branch has not merged,
so this issue defines the interface #4's own session module will also need
to produce, here, in `src/elements/types.ts`, so the element contract has
something concrete to inject against without waiting on #4's own
implementation work.

**When #4 lands:** re-export its session module's type from
`src/elements/types.ts` (or delete this copy in favor of importing #4's),
so there is exactly one `HonuaStudioSessionAdapter` definition, not two that
can drift apart. Search the codebase for `TODO(honua-studio#4)` — every spot
that needs updating is marked.

## The interface

```ts
export interface HonuaStudioSessionSnapshot {
  readonly status: "anonymous" | "authenticated" | "expired";
  readonly subject?: string;
  readonly expiresAt?: string;
}

export interface HonuaStudioSessionAdapter {
  readonly baseUrl: string;
  getSnapshot(): HonuaStudioSessionSnapshot;
  getAccessToken(): Promise<string | undefined>;
  onChange(listener: (snapshot: HonuaStudioSessionSnapshot) => void): { remove(): void };
}
```

- **`baseUrl`** — the honua-server base URL this session's SDK clients
  should target. Read-only; a session doesn't change servers mid-flight.
- **`getSnapshot()`** — synchronous read of the current auth state, for
  rendering (e.g. `<honua-studio-chat>`'s session-status display). Elements
  never make an authz *decision* from this — that's the server's job on
  every request; the snapshot is display-only.
- **`getAccessToken()`** — resolves the current bearer token, `undefined`
  when anonymous/expired. May trigger a silent refresh internally. Async
  because a real adapter's refresh is async; a fixture adapter can resolve
  immediately.
- **`onChange(listener)`** — subscribes to session changes (login, logout,
  refresh, expiry externally detected). Returns an unsubscribe handle in the
  same `{ remove(): void }` shape every other subscription in this codebase
  uses (matches `HonuaWebComponentController#subscribe` in
  `@honua/sdk-js/web-components`), so element cleanup code (which already
  calls `.remove()` on everything it holds — see
  `src/elements/base-element.ts`) doesn't need a special case for sessions.

## Who constructs one, and when

A **host** — never an element itself — constructs an adapter and assigns it:

```ts
const app = document.createElement("honua-studio-app");
app.session = mySessionAdapter; // before or after connecting the element — both work
document.body.append(app);
```

Elements never initiate their own login/logout flow (honua-studio#4
REQ-003's contract, which this interface exists to make injectable ahead of
#4's own implementation). An element connected with no session, and no
ancestor `<honua-studio-app>` supplying one either (see
`src/elements/session.ts`'s `resolveInjectedSession`), dispatches
`honua-studio-session-required` and renders in an anonymous/unauthenticated
state rather than failing — see `<honua-studio-chat>` /
`<honua-studio-canvas>`'s own `onConnect`.

## Reference implementations in this repo

Every harness ships a **fixture** adapter satisfying this exact interface —
proving the shape works end to end without depending on #4's real OIDC flow:

- `harness/bare/fixture-session.ts` — the bare embed harness's session,
  fixed `status: "authenticated"`, a `setSnapshot()` escape hatch (not part
  of the contract) so its Playwright spec can flip auth state.
- `harness/blazor-host-src/mount.ts` reuses the exact same
  `harness/bare/fixture-session.ts` module — deliberately, to prove the
  *contract*, not the transport, is what's shared across hosts: a Blazor
  Web App test host and a bare static page inject sessions identically.

No fixture in this repo touches `localStorage`/cookies for tokens — matches
honua-studio#4 REQ-002 ("no tokens in localStorage in default mode") ahead
of that issue landing the real enforcement.
