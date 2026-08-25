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
(brand, nav, auth status/sign-in-out controls, optional theme switcher), a
routed view outlet, and a persistent area slotting in `<honua-studio-chat>`
+ `<honua-studio-canvas>` (created automatically unless the host already
supplied its own light-DOM children with those tag names — see
"Composition" below).

**Attributes / properties**

| Attribute | Property | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| `routing-mode` | `routingMode` | `"hash" \| "host"` | `"hash"` | See "Routing" below. |
| `current-path` | `currentPath` | `string` | `"/"` | Host-owned mode only; the host's source of truth for what the element renders. |
| `base-path` | — | `string?` | unset | Host-owned mode only; a path prefix the element strips before internal route matching and re-applies when requesting navigation. |
| `theme-switcher` | `themeSwitcherVisibility` | `"visible" \| "hidden"` | `"visible"` | Hides the built-in theme-set/mode buttons; the element still themes correctly when a host drives theming externally. |
| `data-theme-set` | `themeSet` | `"standalone" \| "console"` | `"standalone"` | See "Theming". |
| `data-theme` | `themeMode` | `"light" \| "dark"` (absent = auto) | unset (auto) | See "Theming". |
| — | `session` | `SessionAdapter \| undefined` | unset | The embed session injection surface (primary path) — see `docs/embed-session.md`. Reassigning after connection switches auth mode live. |
| — | `auth` | `AuthSession` (read-only) | resolved lazily | The live session `.session` resolves to (standalone OIDC or a host-adapter wrapping `.session`) — what the shell (and, by inheritance, `<honua-studio-chat>`/`<honua-studio-canvas>`) actually renders from. |
| — | `studioClient` | `StudioClient` | a default instance reading `/api`, bearer-attached via `.auth` | Override for fixtures/tests. |
| — | `sourceCatalog` | `CatalogDataset[] \| undefined` | fetched once a session exists | What the composition map resolves layer sources against and the AI map kit advertises to a model. Assigning it takes ownership: no fetch will overwrite it, and a session change will not discard it. |
| — | `aiMapKit` | `HonuaAiMapKit` (read-only) | built lazily | The SDK's `createHonuaAiMapKit` over `.composition` — tool definitions (Honua/MCP/OpenAI), capability-aware map context, system prompt, policy-gated `execute()`. See `src/map/agent-map-kit.ts`. |

**Methods**: `enableLiveComposition({ packageKey, family?, schemaVersion?,
baseUrl? })` attaches a live MCP session so tool calls mutate a real Studio
draft; `disableLiveComposition()` returns to fixture/offline mode (the
default). Both are also reachable from the header's own control
(honua-studio#23 REQ-004) — the "Fixture mode" / "Live · &lt;key&gt;" badge
plus a "Go live…" form; there is no test-hook-only path.

**Events** (all `CustomEvent`, `bubbles: true, composed: true` — cross the
shadow boundary): `honua-studio-ready` (base contract, see below),
`honua-studio-navigate` (`{ path, replace? }` — host-owned mode only, a
*request*, never applied by the element itself), `honua-studio-theme-change`
(`{ themeSet, mode }`), `honua-studio-session-required` (`{ reason }`),
`honua-studio-error` (`{ message, error? }`),
`honua-studio-composition-mode-change` (`{ mode: "fixture" | "live",
packageKey?, family? }`).

Sign-in/sign-out controls (and any interactive auth affordance at all) only
render when `auth.mode === "standalone"` — REQ-003 (honua-studio#4): in
host-adapter mode Studio never renders anything that could initiate its own
auth flow, only the status label.

### `<honua-studio-chat>` — chat console

Implementation: `src/elements/studio-chat-element.ts` (honua-studio#6,
realizing the honua-studio#5 placeholder shape). Renders a user/assistant/
tool-call message list with streaming text, a composer with removable
annotation reference chips (spec REQ-012), and cancellation. Talks to the
model exclusively through the `ChatTransport` seam (`src/chat/transport.ts`)
— never `fetch` directly — so the same element renders identically against
the real server AI proxy or a deterministic fixture conversation (AD-4). Per
AD-5/AD-8 this element EMITS tool-call intents and renders results; it does
not own composition state (honua-studio#8 owns that).

**Attributes**: `label`, `placeholder`.

**Properties**:

| Property | Type | Notes |
| --- | --- | --- |
| `auth` | `AuthSession \| undefined` | Direct override; falls back to the nearest `<honua-studio-app>` ancestor's `.auth` (`src/elements/session.ts`). |
| `transport` | `ChatTransport` | Defaults to a lazily-constructed `SseChatTransport` reading `/api` (honua-server#3010), bearer-attached via `.auth`. Override with `FixtureChatTransport` (`src/chat/fixture-transport.ts`) for deterministic dev/CI/demo replay — AD-4's "no-model fixture-conversation mode". |
| `activityLog` | `ActivityLog` | This console's own replayable log (`src/chat/activity-log.ts`) — read-only in practice; assign a fresh instance (e.g. with a deterministic `clock`) before sending any messages to control it. |
| `messages` | `readonly ChatMessage[]` | Read-only. |
| `pendingAnnotations` | `readonly AnnotationRef[]` | Read-only — chips attached in the composer but not yet sent. |
| `streaming` | `boolean` | Read-only. |

**Methods**: `addAnnotation(input: CreateAnnotationInput): AnnotationRef`
(spec REQ-012 — the public API a canvas uses to inject a reference chip;
`id`/`createdAt` are optional for live use, always explicit for fixture
replay), `removeAnnotation(id: string): void`, `sendMessage(text: string): Promise<void>`
(folds pending annotations into the outgoing wire content — see
`src/chat/annotation.ts`'s `composeMessageContent` — and streams the reply;
resolves once the turn settles, never rejects), `cancel(): void` (aborts the
in-flight turn, if any).

**Events**: `honua-studio-chat-message` (`{ text }`, unchanged since
honua-studio#5), `honua-studio-chat-annotation-added` (`{ annotation }`),
`honua-studio-chat-annotation-removed` (`{ id }`),
`honua-studio-chat-tool-call-start` (`{ messageId, toolCallId, toolName }`),
`honua-studio-chat-tool-call-result` (`{ messageId, toolCallId, toolName?, arguments }`
— the tool-call INTENT this console emits once a call's arguments are fully
assembled; the intended consumer is honua-studio#8's composition engine),
`honua-studio-chat-turn-complete` (`{ messageId, stopReason?, promptTokens?, completionTokens?, latencyMs? }`),
`honua-studio-chat-turn-error` (`{ messageId, errorMessage }`),
`honua-studio-chat-turn-cancelled` (`{ messageId }`).

**Injection event**: `honua-studio-annotate` — dispatched BY a host/canvas
(bubbles+composed; this element listens on `window`, so it reaches
`<honua-studio-chat>` regardless of DOM position) to add an annotation
without holding a direct element reference. Detail shape matches
`CreateAnnotationInput`.

See `docs/ai-chat-wire-contract.md` for the exact honua-server#3010 wire
shapes this element's `SseChatTransport` speaks, and `src/chat/fixtures/*.json`
for the deterministic fixture-conversation replay format
(`src/chat/fixture-conversation.ts`).

### `<honua-studio-activity-log>` — replayable activity log

Implementation: `src/elements/studio-activity-log-element.ts`
(honua-studio#6, spec REQ-012: "annotations are visible, removable, and
recorded in the activity log like any other context"). A sibling surface,
not a child of `<honua-studio-chat>` — wire the two together explicitly:

```ts
const chat = document.querySelector("honua-studio-chat");
const log = document.querySelector("honua-studio-activity-log");
log.log = chat.activityLog;
```

**Attribute**: `label`.

**Properties**: `log: ActivityLog` (the log this element renders; defaults
to an empty, self-owned instance until assigned — same "own it vs. render an
assigned override" pattern as `.transport`/`.studioClient` elsewhere in this
contract), `entries: readonly ActivityLogEntry[]` (read-only, mirrors
`log.entries()`).

**Methods** (the replay API — step through recorded entries, re-emitting
each as an event; no timers, every step is caller-driven):
`startReplay(entries?)`, `replayNext(): ActivityLogEntry | undefined`,
`resetReplay()`, `exportJson(): string`, `importJson(json: string): void`
(throws `InvalidActivityLogExportError` for malformed input, leaving the log
untouched).

**Events**: `honua-studio-activity-replay-step` (`{ entry, index, total }`),
`honua-studio-activity-replay-complete` (`{ total }`).

### `<honua-studio-canvas>` — composition canvas

Implementation: `src/elements/studio-canvas-element.ts`. Unset
`composition` (the honua-studio#5 default) still renders the original
placeholder surface. Set, the element renders a **live MapLibre GL map**
bound to the controller's `CompositionState` (honua-studio#23), with the
honua-studio#8 structured readout kept alongside it.

| Attribute | Property | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| `label` | — | `string` | `"Canvas"` | Panel heading and `aria-label`. |
| `surface` | `surface` | `"map" \| "details"` | `"map"` | Which surface has the panel. `"map"` shows the map with the readout beneath it as a table of contents; `"details"` gives the readout the whole panel. Falls back to `"details"` (and disables the Map button) whenever no map could be constructed. |
| — | `composition` | `CompositionController \| undefined` | unset | `src/composition/controller.ts`. Drives both surfaces. |
| — | `auth` | `AuthSession \| undefined` | inherited | Same ancestor fallback as `<honua-studio-chat>`. |
| — | `sourceCatalog` | `CompositionSourceDescriptor[] \| undefined` | unset | What the server advertises (`StudioClient.listCatalog()`). Turns a composition layer's bare `sourceId` into a renderable source — see `src/map/source-resolution.ts`. `<honua-studio-app>` assigns this automatically. |
| — | `basemapStyle` | `HonuaStyleSpecification \| undefined` | the vendored offline basemap | A deployment with its own style/tile/glyph server overrides the default here. |
| — | `sourceBaseUrl` | `string` | `"/api"` | Server root for composed source URLs. |
| — | `viewTransitionMs` | `number \| undefined` | `700` | Camera animation duration; `0` jumps. |
| — | `mapFactory` | `CompositionMapFactory \| undefined` | the `maplibre-gl` import | Test seam only. |
| — | `mapView` | `CompositionMapView \| undefined` (read-only) | — | The live binding: `.status`, `.statusDetail`, `.projection` (the `HonuaMapPackage` and any unrenderable layers), `.map`. |
| — | `widgetDataLoader` | `WidgetDataLoader \| undefined` | the catalog-backed loader | Test seam only — the grid/chart analogue of `mapFactory`. |
| — | `widgetDeck` | `HonuaStudioWidgetDeckElement \| undefined` (read-only) | — | The composed `<honua-studio-widget-deck>` (honua-studio#24), built once with the shell and fed catalog/base-url/loader. |
| — | `controlBar` | `HonuaStudioControlBarElement \| undefined` (read-only) | — | The composed `<honua-studio-control-bar>` (honua-studio#25), built once with the shell above the map. |
| — | `interactions` | `StudioInteractionRuntime \| undefined` (read-only) | — | The ADR-0030 interaction runtime, created lazily the first time the composition declares a control or a binding. `.compiled` carries the compiler's `issues`/`unsupported`/`bindings`; `.appearance` is the per-layer filter/opacity the map projects. |

**The map.** Composition state is projected to a `honua_map_package.v1`
package and composed with the SDK's own `composeStyle`, then handed to
MapLibre's style differ — so an applied command mutates the running map
rather than re-mounting it. Layer ids on the map are the composition's own
layer ids. A click on a rendered feature dispatches
`honua-studio-selection-change` with the most specific target first
(`{ kind: "feature", sourceId, featureId }`, then `{ kind: "layer", id }`).
All map assets are vendored — there is no runtime CDN dependency
(honua-studio#23 REQ-003); see `src/map/assets/README.md`.

**The readout is still here, and still asserted against.** It is the map's
accessible description (the map region carries `aria-describedby` pointing
at it), the keyboard-reachable way to select layers/widgets/annotations, and
the only surface that can show what a map structurally cannot: widgets,
pins, annotations, and layers whose source did not resolve to anything
renderable (flagged "not on map", with the reason as a tooltip). It is
present in the DOM in **both** surface modes. Each row is a clickable button
that calls `composition.select([target])` and dispatches
`honua-studio-selection-change` — the deictic reference honua-studio#6's
chat console attaches to a follow-up prompt as a "THIS" chip (REQ-012).
Pinned targets render a 📌 marker and `data-pinned="true"`.

When the map cannot be constructed (no WebGL, a refused context), that is a
**state, not an error**: the canvas reports it in
`[data-testid="studio-canvas-map-status"]` and falls back to the readout —
exactly the surface it had before honua-studio#23.

Also runs a `ResizeObserver` on itself (`honua-studio-canvas-resize`,
`{ width, height }`) specifically to give the cleanup-invariant tests
something non-trivial to assert on — a `ResizeObserver` is exactly the kind
of subscription that leaks silently if `disconnectedCallback` is incomplete.
`HonuaStudioCanvasElement.instanceCount` is a static live-instance counter
(not part of the contract proper) used by `test/elements/cleanup.test.ts`
and `harness/blazor-host`'s render-mode-switch spec to assert no leak across
repeated mount/unmount cycles; the `composition` subscription is torn down
on disconnect (and on reassignment) with the same discipline.

### `<honua-studio-control-bar>` — the composed controls

Implementation: `src/elements/studio-control-bar-element.ts`
(honua-studio#25). `<honua-studio-canvas>` composes one into its own shadow
DOM **above** the map — controls are chrome, so they read before the thing
they act on — and it hides itself entirely (`[data-empty="true"]`) while the
composition holds no controls. Usable standalone, like the deck.

Controls are a **peer collection of widgets, not a widget kind**
(geospatial-mcp ADR-0031): they are input affordances, they are chrome
rather than `layout` grid items, and `CompositionState.controls` is their
own collection with its own `addControl`/`removeControl` commands.

| Attribute | Property | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| `label` | — | `string` | `"Controls"` | `aria-label` for the bar region. |
| — | `composition` | `CompositionController \| undefined` | unset | Subscribed to. Every control is a projection of `controller.state`. |
| — | `interactions` | `StudioInteractionRuntime \| undefined` | unset | Where a `change` is published. Without it, change-emitting controls render disabled and say so. |
| — | `map` | `ControlBarMapBridge \| undefined` | unset | The narrow duck-typed map seam the intrinsic affordances act on (`camera`, `nudge`, `container`, `attributions`, `setBasemap`). Declared locally so this element never imports the lazy map chunk — and so every intrinsic behavior is testable against an object literal. |
| — | `dataLoader` | `WidgetDataLoader \| undefined` | catalog-backed | Derives a `filterSelect`'s option domain from its bound source. Same seam the deck uses. |
| — | `isMeasuring()` | `() => boolean` | — | True while a `measure` control is collecting vertices; the canvas suppresses selection so a measuring click does not also select. |
| — | `appendMeasurePoint(point)` | `(LngLat) => void` | — | Feeds one map click into every active `measure` control. |

**Kinds.** The closed 14-kind ADR-0031 vocabulary, in two halves the
upstream schema itself draws:

- **Map affordances** — `navigation`, `scale`, `fullscreen`, `geolocate`,
  `attribution`, `basemapSwitcher`, `bookmarks`, `measure`. Behavior is
  *intrinsic*: an agent writes `addControl({ kind: "navigation" })` and gets
  working zoom buttons, with no authored binding. Where the behavior is a
  composition mutation (a bookmark's camera move, a geolocate fix) it goes
  through `controller.apply(...)` — the same reducer, pins, history and
  draft sync as any agent-authored `setView`.
- **Data-binding affordances** — `timeSlider`, `filterSelect`,
  `filterSlider`, `filterDateRange`, `opacity`. These emit `change`.

`search` reports **explicit unsupported**: ADR-0031's control `config`
declares no search-provider vocabulary (geocoder endpoint vs. feature search
over `sourceId`), and Studio will neither invent one privately nor call an
off-origin geocoder. Any control whose config or `sourceId` cannot be
resolved reports its own reason in
`[data-testid="studio-control-unsupported"]` and renders
`data-state="unsupported"`. Nothing is ever silently dropped, and the
canvas readout carries a matching "not rendered" flag.

**How `change` reaches an interaction.** One transport, and it is the SDK's:
a control publishes a `FilterClause` keyed by its own id through
`bindFilterControlsToExploration` (`@honua/sdk-js/interactions`) on a shared
`ExplorationContext`. The compiler — `compileHonuaInteractions` from
`@honua/sdk-js/interactions/declarative` — subscribes to that same slice on a
*separate* exploration view and runs the bound verb;
`src/interactions/studio-interactions.ts` supplies the component registry the
verbs land in. `honua-studio-control-change` is a DOM **notification** of the
same gesture for hosts, never the transport.

**Actions never emit events** (ADR-0030) is enforced two ways: the compiler's
exploration view is separate from the controls' one (bound views ignore their
own notifications, so a clause a verb writes is structurally invisible to the
compiler that wrote it), and a re-entrancy guard drops any event raised while
a verb is running.

**Verb arguments are the standard's, spelled flat.** `setViewport` reads
`bbox` / `center` / `zoom` / `pitch` / `bearing` directly off `do.args`;
`setFilter` reads `field` / `operator` / `value` (or a whole `clause`), and a
binding that wants the control's own clause passes it through explicitly with
`args: { clause: "$event.clause" }`. A `$event.*` path that resolves to
nothing clears the filter rather than installing a valueless clause.

### `<honua-studio-widget-deck>` — the composed chrome

Implementation: `src/elements/studio-widget-deck-element.ts`
(honua-studio#24). `<honua-studio-canvas>` composes one into its own shadow
DOM between the map and the readout; it is also usable standalone, which is
what lets a host embed just a layer list. It renders one card per
`CompositionWidget` and hides itself entirely (`[data-empty="true"]`) while
the composition holds none.

| Attribute | Property | Type | Default | Notes |
| --- | --- | --- | --- | --- |
| `label` | — | `string` | `"Widgets"` | `aria-label` for the deck region. |
| — | `composition` | `CompositionController \| undefined` | unset | Subscribed to. Every card is a projection of `controller.state`, never a copy. |
| — | `sourceCatalog` | `CompositionSourceDescriptor[] \| undefined` | unset | Resolves a widget's `sourceId` to the route its rows come from — the same resolution the map uses. |
| — | `sourceBaseUrl` | `string` | `"/api"` | Server root for resolved source URLs. |
| — | `dataLoader` | `WidgetDataLoader \| undefined` | catalog-backed | Injection seam (`src/widgets/widget-data.ts`), the grid/chart analogue of `mapFactory`. |
| — | `unrenderableLayers` | `{ layerId, reason }[]` | `[]` | Layers the map could not draw; the TOC flags them "not on map" rather than implying they are drawn. |
| — | `onSelection` | `(targets) => void \| undefined` | unset | Where a selection goes. The canvas points this at its own dispatcher so the composed app has exactly one selection path; unset, the deck selects and dispatches `honua-studio-selection-change` itself. |

**Kinds.** `toc` (layer list), `legend`, `table` (data grid), `chart`,
`compare`, `time` — the bounded `COMPOSITION_WIDGET_KINDS` vocabulary. A
widget that cannot be rendered as authored (a `compare` naming one layer, a
`chart` with no `groupBy`, a `time` with no steps) shows the reason in
`[data-testid="studio-widget-status"]`; it is never silently blank.

**Intrinsic interactions, not authored ones.** A TOC's visibility
checkboxes, the compare switch, and the time stepper come with the kind — an
agent writes `addWidget({ kind: "toc" })` and gets working toggles, never
chrome boilerplate. They are not a side door: each applies a `setVisibility`
**command** through `controller.apply(...)`, so they share the reducer's
validation, pin enforcement, history, and draft sync with any agent-authored
`setVisibility`. A pinned layer's toggle is disabled rather than allowed to
fail.

**Selection.** A grid row resolves to `{ kind: "feature", sourceId,
featureId }` — the same deictic target a map click produces — and travels
the normal path (`onSelection` → the canvas → `controller.select` + one
`honua-studio-selection-change`). Rows are focusable and operable with
Enter/Space.

**Charts** are derived from the SDK's own `chartWidgetToVegaLiteSpec`
(`@honua/sdk-js/studio`) and drawn by a bounded native SVG renderer;
`src/widgets/chart-render.ts` documents that trade. The spec is the
contract — aggregation reads `spec.encoding`, and a deployment wanting full
Vega can hand the same spec object to `vega-embed`. The chart pipeline is
dynamically imported, so a composition without a chart never loads it.

`HonuaStudioWidgetDeckElement.instanceCount` is the same static
live-instance leak probe the other elements carry.

### `<honua-studio-content-browser>` — Studio content browser

Implementation: `src/elements/studio-content-browser-element.ts` (honua-studio#9
build item 1). Lists Studio content items (immutable, saved) and package
drafts (mutable) — server PR #3014's `GET /content-items` / `GET
/package-drafts` shapes exactly: `family`/`workspaceId`/`owner`/`state`/`q`
filters, opaque cursor pagination ("Load more"), and the joined publication
badge on content-item rows. Read-only: the only mutating thing it does is
dispatch `honua-studio-open-item`.

**Properties**: `auth` (same fallback as chat/canvas); `client` —
a `StudioLifecycleClient` (`src/lifecycle/lifecycle-client.ts`); defaults to
one reading `/api`, bearer-attached via `.auth`.

**Methods**: `refresh(): void` — reloads both lists from the start.

**Events**: `honua-studio-open-item` (`{ itemId?, draftId?, family, packageKey }`
— at least one of `itemId`/`draftId` is always present).

### `<honua-studio-lifecycle-panel>` — the open item/draft view

Implementation: `src/elements/studio-lifecycle-panel-element.ts`
(honua-studio#9 build item 2). Draft status (generation, validation
summary), save-as-version, version list, version comparison
(content-hash/dependencies/validation/provenance diff, per the comparison
endpoint shape), reopen-as-draft, and the publish/rollback flows.

**Attributes / properties**: `item-id` / `itemId`; `draft-id` / `draftId`
(setting either reloads); `auth`; `client` (same defaulting as the content
browser); `draft` (read-only, the loaded `StudioPackageDraft`); `versions`
(read-only, the loaded item's immutable versions).

**Events**: `honua-studio-lifecycle-activity`
(`{ kind, itemId?, draftId?, versionId?, message? }` — `kind` one of
`draft-loaded`/`draft-validated`/`version-saved`/`version-reopened`/
`comparison-ready`/`publish-requested`/`publish-rejected`/
`rollback-requested`/`error`; `studio-app-element.ts` forwards every one of
these into the shared activity log as a `lifecycle_action` entry).

**THE HUMAN GATE — spec REQ-009.** `honua_studio_propose_publication`
(server PR #3016, the only publish-adjacent MCP tool an agent can call) only
ever writes `envelope.publicationIntent` onto a draft. When the loaded draft
carries one, this panel renders an informational pending-proposal banner —
it calls nothing. Turning that into an actual publish, or running a
rollback, requires opening this panel's own confirm dialog and typing the
exact package key; only that dialog's confirm button calls
`StudioLifecycleClient.requestPublish`/`.requestRollback` — the ONLY call
site for either method anywhere in this package, verified both statically
and at runtime by `test/lifecycle/human-gate.test.ts`. No chat/MCP
tool-call/activity-log event handler anywhere in the app can reach either
method.

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
no-op, never a `NotSupportedError`.

One tag pulls another in with it: `registerStudioElement("honua-studio-canvas")`
also defines `honua-studio-widget-deck` and `honua-studio-control-bar`,
because the canvas composes those tags into its own shadow DOM and an
undefined tag would upgrade to nothing — the composed widgets and controls
would silently not render, with nothing thrown to explain it. That dependency is declared in `registry.ts` rather than inferred, and
the canvas additionally calls `customElements.upgrade` on the node before
assigning any property to it (assigning to a not-yet-upgraded custom element
writes an own data property that permanently shadows the accessor).

`createStudioComponentRegistry()`
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
`resolveInjectedAuth()` — `closest("honua-studio-app")` — work correctly
for the default composition: the children are genuine light-DOM descendants
of the app element, not something created inside its shadow root.

## Session injection

See `docs/embed-session.md` for the full `SessionAdapter`/`AuthSession`
contract (honua-studio#4 owns `src/auth/*`; this issue's elements consume it
— `src/elements/types.ts` re-exports the types rather than defining its
own, after #4 merged ahead of #5). In short: a host constructs a
`SessionAdapter` (`getToken()`/`onExpired()`) and assigns it to `.session`
on `<honua-studio-app>` — the primary injection path, superseding the
`window.__HONUA_STUDIO_HOST_SESSION__` global #4 shipped first, which
remains a documented fallback. `<honua-studio-app>` resolves that (or
standalone OIDC, if `.session` is unset and the fallback global is absent)
into a full `AuthSession`, exposed read-only as `.auth` and inherited by
descendant placeholders. Every Studio element never initiates its own auth
flow (`AuthSession.signIn()`/`signOut()` reject in host-adapter mode), only
renders what it's given and reacts to `.auth`'s `subscribe()`.

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
