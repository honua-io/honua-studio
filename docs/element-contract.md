# The Honua Studio element contract

honua-studio#5 (Phase 0, blocking the console embed — epic #2 AD-1/AD-2,
REQ-001). Every Studio surface is a plain custom element. The standalone
shell (`src/main.ts`) is a thin bootstrap that mounts exactly one
`<honua-studio-app>`; nothing in this repo has a privileged way to reach
Studio that a third-party host page or Honua Console couldn't also use
(REQ-002). Three harnesses prove the contract from the outside:

| Harness | What it proves | Run it |
| --- | --- | --- |
| Standalone shell (`src/main.ts`, `index.html`) | The reference host — the shell IS the contract | `npm run dev` |
| Bare embed (`harness/bare/`) | Third-party hosting with zero console/shell code | `npm run test:browser` (includes `bare-harness.spec.mjs`) |
| Blazor Web App test host (`harness/blazor-host/`) | Console's real hazards: SSR/enhanced-nav DOM patching, render-mode re-instantiation, router URL ownership, focus across shadow DOM | `npm run test:browser:blazor`; see `harness/blazor-host/README.md` |

## Elements

### `<honua-studio-app>` — the full shell

Implementation: `src/elements/studio-app-element.ts`. Composes a header
(brand, nav, optional theme switcher), a routed view outlet, and a
persistent area slotting in `<honua-studio-chat>` + `<honua-studio-canvas>`
(created automatically unless the host already supplied its own light-DOM
children with those tag names — see "Composition" below).

**Attributes / properties**

| Attribute | Property | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| `routing-mode` | `routingMode` | `"hash" \| "host"` | `"hash"` | See "Routing" below. |
| `current-path` | `currentPath` | `string` | `"/"` | Host-owned mode only; the host's source of truth for what the element renders. |
| `base-path` | — | `string?` | unset | Host-owned mode only; a path prefix the element strips before internal route matching and re-applies when requesting navigation. |
| `theme-switcher` | `themeSwitcherVisibility` | `"visible" \| "hidden"` | `"visible"` | Hides the built-in theme-set/mode buttons; the element still themes correctly when a host drives theming externally. |
| `data-theme-set` | `themeSet` | `"standalone" \| "console"` | `"standalone"` | See "Theming". |
| `data-theme` | `themeMode` | `"light" \| "dark"` (absent = auto) | unset (auto) | See "Theming". |
| — | `session` | `HonuaStudioSessionAdapter \| undefined` | unset | See `docs/embed-session.md`. |
| — | `studioClient` | `StudioClient` | a default instance reading `/api` | Override for fixtures/tests. |

**Events** (all `CustomEvent`, `bubbles: true, composed: true` — cross the
shadow boundary): `honua-studio-ready` (base contract, see below),
`honua-studio-navigate` (`{ path, replace? }` — host-owned mode only, a
*request*, never applied by the element itself), `honua-studio-theme-change`
(`{ themeSet, mode }`), `honua-studio-session-required` (`{ reason }`),
`honua-studio-error` (`{ message, error? }`).

### `<honua-studio-chat>` — chat console placeholder

Implementation: `src/elements/studio-chat-element.ts`. The real streaming
chat console is honua-studio#6; this proves the contract shape a composer
surface needs. Attributes: `label`, `placeholder`. Property: `session`
(direct override; falls back to the nearest `<honua-studio-app>` ancestor's
session — see `src/elements/session.ts`). Event:
`honua-studio-chat-message` (`{ text }`) on composer submit.

### `<honua-studio-canvas>` — composition canvas placeholder

Implementation: `src/elements/studio-canvas-element.ts`. The real
composition engine is honua-studio#8. Attribute: `label`. Property:
`session` (same fallback as chat). Runs a `ResizeObserver` on itself
(`honua-studio-canvas-resize`, `{ width, height }`) specifically to give the
cleanup-invariant tests something non-trivial to assert on — a
`ResizeObserver` is exactly the kind of subscription that leaks silently if
`disconnectedCallback` is incomplete. `HonuaStudioCanvasElement.instanceCount`
is a static live-instance counter (not part of the contract proper) used by
`test/elements/cleanup.test.ts` and `harness/blazor-host`'s render-mode-switch
spec to assert no leak across repeated mount/unmount cycles.

## Lifecycle

`src/elements/base-element.ts`'s `HonuaStudioElementBase` (every element
extends it):

- `connectedCallback` creates a fresh `AbortController`, attaches an open
  shadow root, calls the subclass's `onConnect(signal)` hook, renders, and —
  only on an element's first-ever connection — dispatches
  `honua-studio-ready`.
- `disconnectedCallback` aborts that controller (removing every listener
  registered through the base class's `listen()` helper) and calls the
  subclass's `onDisconnect()` hook for anything an `AbortSignal` can't cover
  (e.g. `ResizeObserver.disconnect()`).
- `setShadowHtml()` is the only sanctioned way a subclass replaces its
  shadow DOM: it captures focus + text selection before the replace and
  restores it after, so a full re-render never steals focus from a control
  inside — the primitive the Blazor SSR-patch hazard needs.

This is verified, not just documented: `test/elements/base-element.test.ts`
and `test/elements/cleanup.test.ts` assert dispatched `honua-studio-ready`
fires exactly once per connection, listeners registered pre-disconnect never
fire post-disconnect, `ResizeObserver`s disconnect, and
`HonuaStudioCanvasElement.instanceCount` returns to baseline after repeated
mount/unmount — see also `harness/blazor-host/README.md`'s hazard 1/2 specs,
which exercise the exact same invariants against a real Blazor Web App.

## Registry discipline

`src/elements/registry.ts` mirrors `@honua/sdk-js`'s own kits
(`src/controls/registry.ts`, `src/web-components/elements.ts`): every
element module (`studio-app-element.ts`, `studio-chat-element.ts`,
`studio-canvas-element.ts`) exports only a class — none of them call
`customElements.define` at module scope, and neither does
`src/elements/registry.ts` or `src/elements/index.ts` on import. Importing
any of these is side-effect-free; registration is always an explicit call:

```ts
import { registerAllStudioElements } from "./elements/registry.js";
registerAllStudioElements(); // or registerStudioElement("honua-studio-canvas")
```

`registerStudioElement`/`registerAllStudioElements` use a `defineIfMissing`
guard — re-registering an already-defined tag (a second host page, a
hot-reloaded module, a second harness importing the same bundle) is always a
no-op, never a `NotSupportedError`. `createStudioComponentRegistry()`
returns a real scoped `CustomElementRegistry` where the runtime supports
constructing one, otherwise an in-memory `{ get, define }` stand-in with the
same idempotency — for a host that wants Studio's tags kept out of its own
global registry entirely.

## Composition

`<honua-studio-app>` composes its chat/canvas surfaces as real light-DOM
children (slotted into its shadow template via `<slot name="chat">` /
`<slot name="canvas">`), created automatically on connect unless the host
already supplied its own `<honua-studio-chat>` / `<honua-studio-canvas>`
children first. This is what makes `src/elements/session.ts`'s
`resolveInjectedSession()` — `closest("honua-studio-app")` — work correctly
for the default composition: the children are genuine light-DOM descendants
of the app element, not something created inside its shadow root.

## Session injection

See `docs/embed-session.md` for the full `HonuaStudioSessionAdapter`
contract (a honua-studio#4 coordination point — that issue's own session
module hadn't merged as of #5, so the interface is defined once, in
`src/elements/types.ts`, and both issues converge on it). In short: a host
constructs an adapter and assigns it to `.session` on `<honua-studio-app>`
(or directly on a standalone placeholder element); every Studio element
never initiates its own auth flow, only renders what it's given and reacts
to `onChange`.

## Theming

Attributes `data-theme-set` (`"standalone" | "console"`) and `data-theme`
(`"light" | "dark"`, absent = follow `prefers-color-scheme`) are the same
vocabulary `src/theme/theme-loader.ts` already used pre-#5 — unchanged by
this issue. `src/theme/tokens.css` / `theme-standalone.css` /
`theme-console.css` already select on `[data-theme-set="…"]` **on any
element carrying the attribute**, not only `:root` — so a host can either:

1. theme globally (stamp the attributes on its own `<html>`, as the
   standalone shell's `src/main.ts` does for the page chrome around the
   element — see its `honua-studio-theme-change` listener), or
2. theme scoped to just the element (`<honua-studio-app data-theme-set="console">`)
   — the embeddable-by-default path, since CSS custom properties inherit
   across the shadow boundary from whichever ancestor carries the matching
   attribute, and a host never has to touch its own document root.

`<honua-studio-app>`'s built-in switcher (hideable via `theme-switcher`) sets
the attributes on **itself** via an internal `ThemeLoader` instance (same
class, targeting `this` instead of `document.documentElement`) — persisted
to `localStorage` under the same `honua-studio:theme-set` /
`honua-studio:theme-mode` keys as before. A host setting the attributes
externally is never overridden: `onConnect` only calls `ThemeLoader.boot()`
(applying the persisted/default choice) when neither attribute is already
present at connect time.

`src/elements/styles.ts` supplies every element's shadow CSS with
`var(--hn-*, fallback)` chains, so an element still renders legibly even
when a host hasn't loaded any of the token CSS files at all — see
`harness/bare/index.html`, which deliberately doesn't, to prove exactly
that.

## Routing

`HonuaStudioRoutingMode` (`src/elements/types.ts`):

- **`"hash"`** (default) — self-owned. The element runs its own internal
  hash router (`src/router/router.ts`, reused unmodified from the Phase 0
  scaffold) and reads/writes `window.location.hash`. Correct when nothing
  else on the page owns the URL — the standalone shell and the bare embed
  harness both use this.
- **`"host"`** — host-owned. The element **never** touches
  `window.location`. It renders whichever route `current-path` says (with
  `base-path` stripped for internal matching), and *requests* navigation by
  dispatching `honua-studio-navigate` — the host is responsible for driving
  its own router and reflecting the result back via `current-path`.
  `harness/blazor-host` is the reference integration: see its README for
  what actually keeping that promise took in a real host framework.

## Mount/unmount cleanup — the invariant this whole issue exists to prove

"No leaked listeners/observers" is enforced structurally, not by convention:
every listener a subclass adds goes through `HonuaStudioElementBase#listen`,
which ties it to the current connection's `AbortSignal`; anything that isn't
an `AbortSignal` consumer (a `ResizeObserver`) is torn down explicitly in
`onDisconnect()`. `test/elements/cleanup.test.ts` asserts this directly;
`harness/blazor-host`'s hazard 1 and hazard 2 specs assert the same
invariant against a real render-mode/navigation cycle in a real host
framework, which is precisely the class of hazard a synthetic unit test
cannot fully stand in for (see that harness's README for what a naive
"persistent DOM region" integration actually does under Blazor Web App's
navigation, and why the shipped integration pattern looks the way it does).
