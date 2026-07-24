# Embed session handoff contract

honua-studio#4 (REQ-001/002/003) + honua-studio#5 (REQ-001/002), reconciled
into one document after #4 merged to `main` ahead of #5's branch. Feeds the
future Honua Console embed (honua-console#324, `.specifica/studio-v0/spec.md`
Phase 3). AD-6: Studio is authenticated to honua-server, always — this
document specifies the two ways a session reaches Studio (standalone OIDC,
or an embed host handing one off) and the two ways a host can hand one off
(the element's `.session` property — primary — or a window global —
documented fallback).

## The two auth modes

| | Standalone | Embed (host-adapter) |
|---|---|---|
| Who authenticates | Studio itself, via OIDC Authorization Code + PKCE (`src/auth/oidc-session.ts`) | The host page — console, or any third-party embedder |
| Who initiates sign-in / sign-out | Studio (`<honua-studio-app>`'s own sign-in/out controls) | Never Studio. `AuthSession.signIn()` / `signOut()` reject in this mode. |
| Where the token comes from | The mock or real OIDC issuer's token endpoint | `SessionAdapter.getToken()` |
| Redirects | Yes — full-page navigation to the IdP | Never |

Exactly one mode is active per `<honua-studio-app>` instance, decided by
`createAuthSession()` (`src/auth/index.ts`) — host-adapter mode when a
`SessionAdapter` is available (from either handoff path below), standalone
OIDC otherwise. Reassigning `.session` after the element is already
connected switches modes live (tears down the old `AuthSession` — including
unsubscribing/disposing it — and rebuilds).

## Handing off a session: two paths, one shape

Both paths hand Studio the exact same `SessionAdapter` shape
(`src/auth/types.ts`):

```ts
interface SessionAdapter {
  /**
   * Resolve the current bearer token. Refresh on the host's side if the
   * host deems it necessary — Studio never manages the host's token
   * lifecycle itself. Resolve to `undefined` (never throw) for "no session
   * right now"; Studio treats that as "expired" and shows a signed-out
   * state, but still never starts its own sign-in flow.
   */
  getToken(): Promise<string | undefined>;

  /**
   * Subscribe to the host's session-expiry notification. Studio calls this
   * exactly once, at construction, and surfaces "expired" the moment it
   * fires. Return an unsubscribe function.
   */
  onExpired(listener: () => void): () => void;
}
```

Full type, plus the richer `AuthSession` every Studio element actually
drives its UI from (wrapping whichever mode is active): `src/auth/types.ts`.
Reference test fixture: `src/auth/fixture-host-session-adapter.ts`
(`createFixtureHostSessionAdapter`, used by `test/auth/host-session.test.ts`)
and `harness/bare/fixture-session.ts` (`createFixtureSession`, used by both
browser harnesses — `harness/bare` and `harness/blazor-host`).

### Path 1 (primary): the `<honua-studio-app>.session` property

```ts
const app = document.createElement("honua-studio-app");
app.session = mySessionAdapter; // before or after connecting the element — both work
document.body.append(app);
```

This is the honua-studio#5 element contract's injection surface
(`docs/element-contract.md`) and, as of this reconciliation, the path every
host should reach for first — it's typed, doesn't require timing the
assignment before any Studio code runs, and is the one descendant
placeholders (`<honua-studio-chat>`, `<honua-studio-canvas>`) inherit
through automatically (`src/elements/session.ts`'s `resolveInjectedAuth`,
climbing to the nearest `<honua-studio-app>` ancestor and reading its
resolved `.auth`).

### Path 2 (documented fallback): the window global

Before Studio boots, a host page can instead set:

```js
window.__HONUA_STUDIO_HOST_SESSION__ = {
  getToken() { /* -> Promise<string | undefined> */ },
  onExpired(listener) { /* -> unsubscribe function */ },
};
```

`detectHostSessionAdapter()` (`src/auth/index.ts`) structurally checks for
`getToken` + `onExpired` functions on that global — nothing more is
required. `createAuthSession()` falls back to it whenever `.session` (path 1)
is unset, so a host that set the global before any Studio code ran gets
identical behavior either way. This was honua-studio#4's original (and, at
the time, only) handoff mechanism; it remains fully supported —
`test/playwright/host-adapter-boot.spec.mjs` exercises exactly this path
against the current element-based shell — but a host building against #5's
element contract should prefer path 1.

Both paths funnel into the exact same `HostAdapterAuthSession`
(`src/auth/host-session.ts`); nothing about how Studio behaves once it has
an adapter depends on which path supplied it.

## What Studio does in host-adapter mode

`HostAdapterAuthSession` (`src/auth/host-session.ts`) is the entire
implementation:

- On construction, it resolves the host's token once, proactively (so
  session-gated UI — see `src/pages/home.ts` — doesn't have to wait for its
  first API call before knowing it's signed in).
- `getAccessToken()` always calls `adapter.getToken()` again — it never
  caches independently, so it can never serve a token the host has already
  rotated away or revoked.
- `signIn()` and `signOut()` **always reject** with an explanatory error.
  This is the enforceable half of REQ-003: nothing in this class can ever
  navigate the browser, open a popup, or call a token endpoint.
- `isRedirectCallback()` is always `false`; `handleRedirectCallback()` is a
  no-op. There is no redirect leg to complete in this mode.
- `<honua-studio-app>` (`src/elements/studio-app-element.ts`) renders no
  sign-in/sign-out buttons at all when `auth.mode === "host-adapter"` — only
  a status label — so there is no UI affordance that could even attempt to
  trigger Studio's own flow. (Standalone mode's redirect-callback completion
  — awaiting the IdP round trip and scrubbing `code`/`state` from the
  address bar — lives in the element's own `onConnect`/
  `completeStandaloneRedirectCallback`, not in a host's bootstrap script, so
  every host that mounts `<honua-studio-app>` gets it for free; see
  `docs/element-contract.md`.)

## Threat model note (REQ-011)

REQ-011 (`.specifica/studio-v0/spec.md`) flags that embedding
browser-direct SDK calls into console changes its threat model: console
today fails closed behind a per-operator BFF for mutations. This contract
only specifies the **session handoff shape** — it does not decide whether a
production host adapter wraps a BFF-mediated session or a scoped browser
bearer token; that design is still owned by honua-console and is explicitly
**not** resolved by this document. Per REQ-011, Phases 0–1 of this
workstream run **admin-only by declaration** regardless of which adapter
shape or handoff path a host eventually uses — non-admin authorization
widening is honua-server#3001 (Phase 2). Any concrete host adapter
implementation must be reviewed against honua-console's own security posture
before it ships, not inferred from the fact that it satisfies this
TypeScript interface.

## Testing this contract

- `test/auth/host-session.test.ts` — unit tests against
  `createFixtureHostSessionAdapter()`: proactive token resolution, expiry
  propagation, and — the specific assertion REQ-003 exists for —
  `signIn()`/`signOut()` rejecting and `isRedirectCallback()` never being
  true, i.e. host-adapter mode never redirects.
- `test/elements/studio-app-element.test.ts`'s "auth integration" suite —
  `.session` (path 1) driving `<honua-studio-app>`'s auth mode, including
  reassigning it after connection to switch modes live.
- `test/playwright/host-adapter-boot.spec.mjs` — boots the real built app
  with `window.__HONUA_STUDIO_HOST_SESSION__` injected before any Studio
  code runs (path 2, `page.addInitScript`, a plain inline object —
  deliberately *not* importing a TypeScript fixture, to prove the contract
  really is structural), and asserts: no navigation to an authorize endpoint
  ever happens, the catalog loads using the host's token, and no
  sign-in/sign-out controls are rendered.
- `test/playwright/bare-harness.spec.mjs` and
  `test/playwright/blazor-host.spec.mjs` — both exercise path 1
  (`<honua-studio-app>.session`) via `harness/bare/fixture-session.ts`,
  proving the *contract*, not the transport, is what's shared across hosts:
  a bare static page and a real Blazor Web App inject sessions identically.
- `test/playwright/boot-mock.spec.mjs` — the full mock-issuer standalone
  login journey (sign-in unlocks the catalog, sign-out re-locks it) against
  the element-based shell.

No fixture in this repo touches `localStorage`/cookies for tokens — matches
honua-studio#4 REQ-002 ("no tokens in localStorage in default mode").
