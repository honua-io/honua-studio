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


Protected chart and table data uses the same bounded Honua feature endpoint trust
policy as the map. The current host session supplies each outgoing bearer, with
one refresh on HTTP 401 or GeoServices error 499. Credentials are never forwarded
to external catalog origins, redirects are refused, and browser credentials are
omitted. Replacing or expiring a session clears displayed widget rows and aborts
pending loads; removing the deck also cancels its requests. Public external and
host-provided loaders continue to decide their own authorization, including when
the Honua session is unavailable. Widgets retain the
500-feature request bound and report truncation.

## Console cookie host session

A Console host may assign this session before connecting the element:

```ts
studio.session = {
  kind: "cookie",
  baseUrl: "/api/studio",
  environmentId: session.environmentId,
  principalId: session.principalId,
  expiresAt: session.expiresAt,
  csrfToken: session.csrfToken,
  onExpired: subscribeToHostExpiry,
};
```

Studio reports `fresh` without a bearer in `AuthState` or `getAccessToken()`.
Requests carry same-origin cookies, an environment binding, and CSRF on mutations;
expiry or a 401 stops further transport. The host BFF must independently authorize
and bound every route. Cookie transport permits Studio REST, read-only layer
catalog MCP discovery, and bounded feature queries. It never lends human
credentials to the model's canonical tools.

`principalId` is the host's stable opaque user partition, not a credential. Pass
the same partition to `ServerProcessWorkspace`; run submission requires it.
Pending process commands and accepted receipts are retained separately for each
environment and principal, so switching users cannot adopt another user's run.

Build `npm run build:console-assets` for `dist-console/console.js`, `style.css`,
and its complete dynamic chunk/worker directory. This production entry exports
registration, the existing SDK session/verifier, and Processes adapters without
fixture credentials or automatic mounting. The Console owns one shared agent
session using its separately authenticated agent BFF. Assign
`studio.agentSessionAdapter.submitTurn(prompt, {signal, onEvent})` to retain the
same host context-capture and turn loop. Supplying this adapter hides Studio's
standalone chat slot: the host supplies the one primary composer across views.
Removing it restores the standalone composer. The hidden chat bridge retains
session/context projection, explicit cancellation and activity tracking; view
navigation does not cancel host-owned turns.

`studio.addPublishedLayer(receipt)` resolves an actual published layer against
live catalog locators before applying a map command; it fails when no unique
source exists. Built-in Processes graphs use the existing server workflow-package
compiler and orchestration engine. The separate local custom-code bridge uses
immutable project/fixture snapshots and the installed GP devkit inside a pinned
container. A successful file run is not an imported dataset or a published layer:
the custom-code adapter verifies artifact bytes, uses normal import, and then
uses the returned physical dataset identity for publication. Async operations
remain pending until their actual result is observed.

The host calls `await studio.attachWorkspaceDraft(draftId)` after native turns
and when restoring a `studio-composition` task. This reads the authorized
`package-drafts/{draftId}` REST resource and observes its actual body, without
replaying tools or injecting model history. `honua-workspace-draft-change` emits
`{draftId, generation, packageKey}` from that resource. Persist the typed task
reference and pass `{draftId,generation}` to the shared SDK session's `attachDraft`.
Human canvas edits and undo/redo replace the same draft with optimistic generation
checks and preserve envelope metadata; a conflict requires explicit reread, with
no overwrite retry. Cookie canvas editing refuses local success before a shared
draft is attached. `setWorkspaceConversation(messages)` projects authorized host
conversation into its transcript projection without changing the SDK's model history;
it returns false while that bridge streams. The host owns the visible conversation.

Review bundles currently use the separately packed SDK artifact from
`50d8f1d6fcbbcee89f666949722c6b7ac904e5c4`, including schema-aware dispatch,
canonical live-style bindings, and the dataset import transports. This is not a published 0.2.3 release. Record its
actual tarball SHA and Studio commit in the embedding application's manifest.

`build:console-assets` verifies every installed SDK package file against the
reviewed receipt. Published 0.2.2 still supports standalone builds; it cannot emit
this broad native bundle. Preserve all other dependencies from `package-lock.json`:

```sh
npm ci --ignore-scripts
python3 scripts/install-reviewed-sdk.py --archive /path/to/honua-sdk-js-0.2.3.tgz
npm run build:console-assets
```

The installer checks archive SHA-256
`4592fae1917971394a54e33487b345476cdbfe40dddeb819e5661c30f41a1d8b`,
all 2,113 payload hashes, and the installed dependency versions against the lock.
It does not run npm dependency resolution. The build emits `SDK-PROVENANCE.json`
and license notices. Release qualification requires the actual immutable published
SDK release, updated pins/provenance, and repeated native-session qualification.

The Console entry exports `DatasetImportTaskClient`, `DatasetImportUploadClient`,
`DatasetImportSubmissionClient`, and `hashDatasetImportFile` from that SDK.
Console supplies fresh authenticated headers and its workspace-bound BFF transport;
these exports do not grant import authority or enable a host that is not ready.
After installing the reviewed SDK and pinned Maputnik assets, run
`npm run test:console-assets` to build the bundle and exercise its real hashing
and read transports in Chromium. This packaging check uses controlled HTTP
responses; live import, query, and map qualification remains separate.

Before capturing a turn, `await studio.prepareWorkspaceTurn()` flushes accepted
human edits and returns their `{draftId,generation,packageKey}` without fetching
or overwriting state. It refuses pending form changes or failed writes. Compare
its draft identity to the synchronously captured task; never retarget a prompt
when the user switches context while it waits. For idle external observation,
`refreshWorkspaceDraft()` returns false while unsaved authoring fields or a failed
write need reconciliation. The host also suppresses polling during native turns.

### Shared task attachment

Cookie hosts provide a stable opaque `principalId` for the operator/environment partition. Rotating CSRF or expiry for the same principal retains the observed draft and renews its REST transport; changing principal or environment clears the draft and emits `honua-workspace-draft-change` with undefined detail. Hosts must clear the shared SDK draft with `attachDraft(undefined)` on that event.

`app.createWorkspaceDraft(packageKey)` is an explicit human action. It accepts a trimmed key matching `[A-Za-z0-9._-]{1,200}`, creates an empty canonical map through the authenticated lifecycle REST API, then reads and attaches the actual server draft. It returns `{draftId,generation,packageKey}`. Viewing the canvas or submitting a prompt never creates a draft implicitly. Existing lifecycle `honua-studio-lifecycle-activity` events with kind `draft-loaded` or `version-reopened` identify an actual draft for guarded authorized attachment.

The built-in Processes element exposes `prepareWorkspaceTask()` returning `{packageId,version,contentHash}` only after pending saves settle and the current graph is validated. `attachWorkspaceTask(reference)` reads the immutable version and verifies all three fields before projecting its graph; it returns false when local editing would be discarded. Hosts bind these references as server task kind `workflow-package`, id `packageId`, revision `version`, and `contentHash`. Raw graph/source content is not automatically included in prompts. Local custom source editing has no server workflow-package authority.

The custom Processes client takes a `workspaceId: () => string` getter and sends `X-Honua-Workspace` on each bounded BFF request. Its explicit human `bind()` action uses the configured server/daemon pairing; no daemon credential reaches JavaScript. Saving includes the observed project revision and file SHA. Running first retains an immutable source/input snapshot, persists a command reference, and reconciles an uncertain response through `GET commands/{commandId}` before any retry.

`custom.prepareWorkspaceTask()` waits for pending UI writes, rejects unsaved source or an externally changed project, and returns `{projectId,revision,sourceDigest}`. `attachWorkspaceTask(reference)` and `refreshWorkspaceTask()` read actual authorized project state and preserve dirty text. `honua-local-process-task-change` carries only that reference, or undefined while source is unsaved. Hosts bind this as task kind `local-process-workspace`, id `projectId`, revision `revision`, and contentHash `sourceDigest`. Binding/ownership authorization remains separate from context selection; the canonical server captures an actual immutable snapshot for the turn. Local run and artifact identities remain distinct from imported datasets, workflow packages, and map layers.
