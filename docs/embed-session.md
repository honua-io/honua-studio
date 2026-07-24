# Embed session handoff contract

honua-studio#4 (REQ-003), feeding honua-studio#5's element contract and the
future Honua Console embed (honua-console#324, `.specifica/studio-v0/spec.md`
Phase 3). AD-6: Studio is authenticated to honua-server, always — this
document specifies the second of the two ways a session reaches Studio: the
embed host hands it one instead of Studio running its own OIDC flow.

## The two modes

| | Standalone | Embed (host-adapter) |
|---|---|---|
| Who authenticates | Studio itself, via OIDC Authorization Code + PKCE (`src/auth/oidc-session.ts`) | The host page — console, or any third-party embedder |
| Who initiates sign-in / sign-out | Studio | Never Studio. `AuthSession.signIn()` / `signOut()` reject in this mode. |
| Where the token comes from | The mock or real OIDC issuer's token endpoint | `SessionAdapter.getToken()` |
| Redirects | Yes — full-page navigation to the IdP | Never |

Exactly one mode is active per app instance, decided once at boot by
`createAuthSession()` (`src/auth/index.ts`) and never switched at runtime.

## Detecting a host session (Phase 0 seam)

Before Studio boots (`src/main.ts`), a host page that wants to hand off its
own session sets:

```js
window.__HONUA_STUDIO_HOST_SESSION__ = {
  getToken() { /* -> Promise<string | undefined> */ },
  onExpired(listener) { /* -> unsubscribe function */ },
};
```

`detectHostSessionAdapter()` structurally checks for `getToken` +
`onExpired` functions on that global — nothing more is required, so a plain
object (like a raw host page might construct) and the vitest fixture
(`src/auth/fixture-host-session-adapter.ts`) both satisfy it identically;
the two Playwright specs (`test/playwright/oidc-login.spec.mjs` and
`test/playwright/host-adapter-boot.spec.mjs`) exercise both.

This global is a **Phase 0 placeholder for a Phase 0/1 deliverable**, not the
final attach point: honua-studio#5 defines the actual embeddable custom
element and its typed properties, and the session hand-off will move to a
property/attribute on that element (e.g. `<honua-studio session={adapter}>`).
Both will detect the exact same `SessionAdapter` shape, so nothing in
`src/auth/host-session.ts` needs to change when #5 lands — only
`detectHostSessionAdapter()`'s source gains a second (or replacement) way to
receive the adapter.

## The `SessionAdapter` contract

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

Full type: `src/auth/types.ts`. Reference implementation used by tests:
`src/auth/fixture-host-session-adapter.ts` (`createFixtureHostSessionAdapter`).

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
- The app shell (`src/app.ts`) renders no sign-in/sign-out buttons at all
  when `auth.mode === "host-adapter"` — only a status label — so there is no
  UI affordance that could even attempt to trigger Studio's own flow.

## Threat model note (REQ-011)

REQ-011 (`.specifica/studio-v0/spec.md`) flags that embedding
browser-direct SDK calls into console changes its threat model: console
today fails closed behind a per-operator BFF for mutations. This contract
only specifies the **session handoff shape** — it does not decide whether a
production host adapter wraps a BFF-mediated session or a scoped browser
bearer token; that design is still owned by honua-console and is explicitly
**not** resolved by this document. Per REQ-011, Phases 0–1 of this
workstream run **admin-only by declaration** regardless of which adapter
shape a host eventually uses — non-admin authorization widening is
honua-server#3001 (Phase 2). Any concrete host adapter implementation must
be reviewed against honua-console's own security posture before it ships,
not inferred from the fact that it satisfies this TypeScript interface.

## Testing this contract

- `test/auth/host-session.test.ts` — unit tests against
  `createFixtureHostSessionAdapter()`: proactive token resolution, expiry
  propagation, and — the specific assertion REQ-003 exists for —
  `signIn()`/`signOut()` rejecting and `isRedirectCallback()` never being
  true, i.e. host-adapter mode never redirects.
- `test/playwright/host-adapter-boot.spec.mjs` — boots the real built app
  with `window.__HONUA_STUDIO_HOST_SESSION__` injected before any Studio
  code runs (`page.addInitScript`, a plain inline object — deliberately
  *not* importing the TypeScript fixture, to prove the contract really is
  structural), and asserts: no navigation to an authorize endpoint ever
  happens, the catalog loads using the host's token, and no sign-in/sign-out
  controls are rendered.
