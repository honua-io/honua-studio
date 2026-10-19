# Honua Studio editor runtime

**The embedded editor for the unified Honua Console workspace.**

This repository currently supplies Console's reusable map, styling, app, and
Processes editing runtime. Console owns product navigation, authentication,
workspace context, and the one shared conversation. Visual edits and agent
commands operate on the same authorized draft and revision; ordinary creative
editing does not require a generate/approve/handoff workflow. Publication and
other governed operations remain explicit actions.

The standalone shell and embed harnesses are compatibility and development
surfaces, not a separate product. Repository consolidation is still pending;
Console currently depends on the qualified editor bundle from this repository.

The Console bundle also exposes the canonical SDK clients for dataset
tasks, uploads, submission status, and bounded file hashing. Its browser packaging
check is `npm run test:console-assets`; see [the public SDK setup](docs/embed-session.md).
These exports do not establish deployment readiness or a completed large-file
import → query → map journey.

- **BYOM** — bring your own model: Studio talks to honua-server's Studio AI
  proxy, so the provider is the operator's choice (Bedrock, any hosted API, or
  a local model) and no key ever reaches the browser. Live turns use the SDK's
  `StudioAgentSession` to declare tools, execute them, and return results to
  the model; fixture-conversation mode remains available with no model at all.
- **Typed, not generated** — every mutation goes through a closed command
  vocabulary mirroring the SDK's agent-tools contract, applied by a reducer or
  by honua-server's `honua_studio_*` MCP tools. No arbitrary code eval; a live
  activity log shows every action, replayable step by step.
- **Durable artifacts** — compositions serialize to the Studio package
  families (`@honua/sdk-js/studio`) and save through
  [honua-server](https://github.com/honua-io/honua-server)'s Studio package
  lifecycle: drafts, immutable versions, comparisons, publish, rollback.
- **Collaboration through the platform** — asynchronous today via shared
  drafts and version history. Live co-editing exists server-side
  (honua-io/honua-server#2999, landed in honua-server PR #3035); Studio has no
  client for it yet.
- **A platform capability, not a client feature** — packages live in
  honua-server, so any host can read them. Embedding Studio itself in
  [Honua Console](https://github.com/honua-io/honua-console)'s `/studio`
  surface is honua-io/honua-console#324, scheduled for 2026.2.

The current visual styling follow-up is under qualification. It adds a pinned credential-free Maputnik frame over the same authorized map draft, explicit map-local versus shared-catalog save callbacks, host-only navigation/chat, and SDK-paged feature preview. These source changes do not yet establish browser label rendering, shared-symbol publication, actual large-layer coverage, or a new production asset receipt. Font/sprite resource transport and the full public artifact journey remain unfinished.

## Status

**v0.1 preview — self-hosted, bring your own model. Run it from source.**

The 2026.1 browser Preview gates are packaging integrity, security, runtime
configuration, and the in-repo browser and embed smokes. Hosted demo and
real-model journeys are not those gates. The 2026.2 graduation checklist is
[`docs/preview-release-posture.md`](docs/preview-release-posture.md).

The recorded standalone baseline passed 1,237 unit tests across 109 files and
29 Playwright browser journeys, including four accessibility checks. The latest
embedded-workspace validation is recorded in the commands table below.
2026.1 ships Studio as a **self-hosted Preview, not GA**. There is still no
hosted instance you can click into. CI builds the image and runs a browser
BYOM preview against it: the page loads from the container, runtime
`/config.json` points at the candidate, a local model selects from the full
tool catalog, and the browser composes, saves, reopens, and proposes. A
separate approver returns the URL. That journey does not use a demo
credential or a hosted model, and it is not a substitute for the Preview
publish gates. A `v*` tag runs
[`release.yml`](.github/workflows/release.yml), which builds a reproducible
static tarball, pushes the version-only image
`ghcr.io/honua-io/honua-studio:<version>`, and attaches the tarball, its
checksum, and a receipt binding version/source SHA/image digest to the GitHub
release. No such tag has been cut, so no image or tarball exists to pull yet —
see [`docs/self-hosted.md`](docs/self-hosted.md). Standing Studio up
on the public demo remains a 2026.2 decision (D2), so treat every capability
below as something you verify by running it, not by visiting a URL.

The founding specification is
[#1 — agent-composed dynamic UI](https://github.com/honua-io/honua-studio/issues/1),
scoped for delivery by [#2 — Studio v0.1](https://github.com/honua-io/honua-studio/issues/2);
the first flagship deployment is the statewide Hawaii demo
(honua-io/honua-sdk-js#776).

### What works today

| Capability | Where | Landed |
| --- | --- | --- |
| App shell, design system, one embeddable element (`<honua-studio-app>`) | `src/elements/`, `src/theme/` | #11, #13 |
| OIDC Authorization Code + PKCE sign-in, tokens in memory only | `src/auth/` | #12 |
| Chat console, activity log, deterministic fixture-conversation mode | `src/chat/`, `src/composition/fixture-conversation.ts` | #14 |
| SDK-owned live agent loop over honua-server's Studio AI proxy — declares tools, executes model-selected calls, and feeds results back | `@honua/sdk-js/studio-agent`, `src/elements/studio-chat-element.ts` | #40 |
| Composition engine — intent reducer, preview, undo/redo, pinning | `src/composition/` | #15 |
| MCP tool plane — JSON-RPC client against honua-server's `/mcp`, tool bridge, orchestrator. honua-server publishes 17 `honua_studio_*` tools; this client has typed wrappers for the 13 draft-lifecycle/composition ones (`STUDIO_MCP_TOOL_NAMES`) | `src/mcp/` | #16, #31 |
| MapLibre canvas that mutates as tool calls stream | `src/map/composition-map-view.ts` | #27 |
| Map controls — 13 of the closed 14-kind vocabulary render; `search` reports as explicitly unsupported (no provider field upstream) | `src/controls/` | #29 |
| Chrome widgets — layer list (TOC), legend, compare, time, data grid, bar/line/pie charts | `src/widgets/`, `src/elements/studio-widget-deck-element.ts` | #34 |
| Package lifecycle UI — draft, version, compare, publish, rollback against honua-server's Studio package lifecycle REST API | `src/lifecycle/` | #17 |
| Processes registry-driven node palette, port connections and configuration with advanced graph JSON, plus separate local-code adapters; visual and live end-to-end qualification pending | `src/gp/process-workspace.ts`, `src/gp/custom-process-workspace.ts` | #104 |
| Conversational GP authoring, with execution behind a human-confirmed gate | `src/gp/` | #18 |
| Embedding proofs — bare static harness and a real Blazor Web App host | `harness/bare/`, `harness/blazor-host/` | #13, #19 |
| Model-quality eval corpus for the composition loop — typed fixture scoring plus supplemental live semantic diagnostics with per-turn server readback ([`docs/evals.md`](docs/evals.md)) | `src/evals/` | #46 |
| Nightly `@live` Playwright journeys against `demo.honua.io` — green; they build Studio from the CI checkout, since no hosted Studio exists to point at | `.github/workflows/live-demo-smoke.yml` | #19, #20 |

Layer rendering currently covers **vector sources only**, reached over OGC API
Features or a GeoServices FeatureServer. Anything else resolves to a visible
"unrenderable" note with a reason rather than a blank map.

### In progress

- **Live model quality is not a release gate yet.** The full chat → tool call
  → canvas loop now runs through `StudioAgentSession`, while the eval corpus
  ([#46](https://github.com/honua-io/honua-studio/issues/46),
  [`docs/evals.md`](docs/evals.md)) scores fixture transcripts in PR CI today
  and can run scripted or signature-verified model turns against an owned real
  server with `npm run evals:server`. Live runs also report semantic role/configuration checks independently of fixture identifiers, while retaining the strict score; missing authoritative styles remain unmet prerequisites. The [authoritative style provider](docs/authoritative-styles.md) resolves real server definitions for supported vector layers and accepts actual browser observations for hash-bound semantic verification. Signed text-only diagnostic replies are verified separately from SDK-verified action rounds. The scheduled model-quality gate remains
  follow-up work.
- **Processes live qualification remains pending.** Console's built-in and custom
  Processes views use the server-backed adapters in `src/gp/process-workspace.ts`
  and `src/gp/custom-process-workspace.ts`. Their installed edit/run/debug/output
  journey still needs qualification. The older standalone GP compatibility panel
  (`src/gp/job-client.ts`, [#35](https://github.com/honua-io/honua-studio/issues/35))
  continues to use the fixture job store.
- **Fixture chat and MCP clients remain local.** The
  `@honua/sdk-js` pin is `0.2.4`
  ([#30](https://github.com/honua-io/honua-studio/issues/30)), which carries
  the SDK's declarative interaction compiler and Studio lifecycle client —
  both now in use, the second behind `src/lifecycle/composition-draft-store.ts`.
  Live model turns now use `@honua/sdk-js/studio-agent`; the local chat
  transport remains the deterministic fixture seam and the local MCP client
  still powers the existing lifecycle/tool orchestrator. The console's
  lifecycle client (`src/lifecycle/`) stays for reasons recorded in its module
  header. The SDK now includes enumeration and extended lifecycle types;
  consolidating the remaining adapter and its POST refresh behavior is follow-up work.
- **Live composition mutations delegate to the server.** Control and
  interaction commands ([#43](https://github.com/honua-io/honua-studio/issues/43))
  use the landed `honua_studio_*` tools, following visibility delegation in
  [#31](https://github.com/honua-io/honua-studio/issues/31). Routing remains a
  static `serverToolName` table until sdk-js#1397 supplies discovery.
- **Embedded workspace versions use the server lifecycle.** Hosts can save
  the active map as an immutable version, list its versions, and reopen one
  as a new draft through the [element methods](docs/element-contract.md).
  Pending visual edits settle first; a session or map change rejects stale
  results. This does not publish the map or qualify the complete installed
  Console journey.
- **Embedded publication has an explicit host review boundary.** Hosts can
  review a saved version, then submit its publication with a retained command
  identity. Changed session, map or immutable content is refused; retries keep
  the original settings and command. Console controls, durable host recovery
  and live audience qualification are still being integrated.
- **Approval receipts are distinct from completion.** Lifecycle publication
  and rollback show HTTP 202 approval requests as awaiting separate human
  approval, retaining operation and proposal references in activity events.
  Unknown pending responses never count as completed mutations.
- **Sharing follows server policy and stays Preview**
  ([#26](https://github.com/honua-io/honua-studio/issues/26)). The self-hosted
  fixture smoke submits a canonical immutable-version proposal, keeps the
  handle across a reload boundary, shows pending, rejected, and failed in
  the conversation, and copies a server-issued link only after a different
  principal approves. In that configured fixture, private and public both wait.
  The client also recognizes the server's direct `Published` receipt and displays
  its verified share URL. This is receipt handling, not a qualified live
  agent publication journey. This is not a GA claim
  ([posture](docs/share-preview-posture.md)).

### Not started

- Cutting the first release tag, and a hosted instance on the demo server.
  The container, runtime `/config.json` contract, reproducible tarball, tag
  workflow, and local BYOM compose/save/reopen/propose receipt are exercised
  on every pull request. What has not happened is the tag itself, so nothing
  is published on GHCR yet. The hosted demo remains decision D2.
- Raster and image layers: COG, ImageServer, WMS
  ([#36](https://github.com/honua-io/honua-studio/issues/36)).
- 3D — scene projection, 2D/3D toggle, scene agent tools
  ([#37](https://github.com/honua-io/honua-studio/issues/37),
  [#38](https://github.com/honua-io/honua-studio/issues/38),
  [#39](https://github.com/honua-io/honua-studio/issues/39)).
- Dual-mode visual style editor
  ([#22](https://github.com/honua-io/honua-studio/issues/22)).
- Console embed at `/studio`
  ([honua-io/honua-console#324](https://github.com/honua-io/honua-console/issues/324),
  2026.2).

## Run it

```bash
nvm use           # Node 22.23.3 (.nvmrc)
npm ci
npm run dev       # http://localhost:5173 — mock honua-server fixture, no network, no model
```

`npm run dev` is the zero-setup path: `mock-server.mjs` plays honua-server
*and* a fake OIDC issuer with an auto-approving user, so "Sign in" completes
instantly and the fixture conversation drives the canvas without a model.

Against a real server:

```bash
HONUA_BASE_URL=http://localhost:8080 npm run dev:live
```

The catalog reads the authenticated, paged `honua_list_layers` MCP tool and
keeps each service/layer identity in an explicit map locator. **Add to map** uses
the normal composition command path with that identity. The home package
list reads `/api/v1/studio/content-items`: labels are package keys and badges
are actual `draft`, `current`, or `published` item states. Empty content stores
show an empty list. Unknown geometry and ambiguous older bare-service references
remain visibly unrenderable rather than becoming a guessed polygon or layer zero.

Live mode reaches a real honua-server for the catalog, `/mcp` tool plane,
package lifecycle, and Studio AI proxy. A model-selected SDK tool mutates the
same composition controller the canvas renders, then its structured result is
fed back to the next assistant round.

## Development

Phase 0 scaffold (honua-io/honua-studio#3): a Vite + TypeScript app shell
consuming [`@honua/sdk-js`](https://github.com/honua-io/honua-sdk-js),
Biome for lint/format, Vitest for unit tests, and Playwright for browser
boot smokes.

The app itself is exactly one embeddable custom element,
`<honua-studio-app>`, mounted by a thin bootstrap (`src/main.ts`) — see
[`docs/element-contract.md`](docs/element-contract.md) for the full
element/attribute/event contract (honua-io/honua-studio#5) and
[`docs/embed-session.md`](docs/embed-session.md) for how a host injects a
session. Two harnesses prove third-party embedding actually works, not just
the standalone shell: the bare static harness (`harness/bare/`) and a real
Blazor Web App test host (`harness/blazor-host/`, README there) that
exercises the hazards a bare page can't — enhanced navigation, render-mode
re-instantiation, router URL ownership, focus across shadow DOM.

See [Run it](#run-it) above for the dev-server commands.

### Authentication (honua-studio#4)

Map feature requests use the current Studio session through an asynchronous MapLibre
protocol scoped to each map. Only configured Honua GeoServices query and OGC items
routes receive bearer credentials; external sources, metadata and other resources do
not. The transport rejects redirects, refreshes once after an authorization failure,
and cancels pending requests when the map is removed. Tokens are never stored in
styles, compositions or source URLs.


Studio signs in to honua-server with OIDC Authorization Code + PKCE for a
public client — never a client secret, and tokens live in memory only (no
localStorage/sessionStorage persistence of credentials; see `src/auth/` and
[`docs/embed-session.md`](docs/embed-session.md)). `npm run dev` needs
nothing extra: `mock-server.mjs` also plays a fake OIDC issuer with an
auto-approving fixture user, so clicking "Sign in" completes instantly with
no login form.

Against a real deployment, point Studio at your operator's actual external
IdP (the same `Authority` honua-server validates bearer tokens against).
Development accepts environment variables:

```bash
HONUA_BASE_URL=http://localhost:8080 \
HONUA_OIDC_ISSUER=https://idp.example.com/realms/honua \
HONUA_OIDC_CLIENT_ID=honua-studio \
npm run dev:live
```

Production bundles instead load the versioned `/config.json` contract, so
server, OIDC, and model-transport settings can change without rebuilding.
See [`docs/self-hosted.md`](docs/self-hosted.md) for the container, static
bundle, clean-machine launch, and credential boundary.

Embedded inside another shell (honua-console's `/studio`, or any
third-party host), Studio never runs its own OIDC flow — the host hands off
an existing session instead. See
[`docs/embed-session.md`](docs/embed-session.md) for the full contract.

Other commands:

| Command | Purpose |
| --- | --- |
| `npm run build` / `npm run preview` | Production build / preview it locally |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check` / `npm run check:fix` | Biome lint + format check / autofix |
| `npm test` | Unit tests (Vitest) — public SDK 0.2.4 checkpoint: 1410 tests across 123 files, including the composition-loop eval corpus (see [`docs/evals.md`](docs/evals.md)); installed end-to-end workflow qualification remains pending |
| `npm run test:browser:install` | One-time: download the Playwright chromium build the `test:browser*` commands need |
| `npm run test:browser` | Builds, then runs 31 Playwright boot/harness/journey/accessibility tests (chromium); local fixture checkpoint passed with retries disabled |
| `npm run test:browser:blazor` | Builds the Blazor Web App test host (`npm run build:blazor-host`), then runs `harness/blazor-host`'s spec — needs the .NET SDK, see `harness/blazor-host/README.md` |
| `npm run test:browser:live` | Builds, then runs the `@live` journeys against a REAL deployed honua-server. Gated: skips unless `HONUA_LIVE_BASE_URL` (e.g. `https://demo.honua.io/api`) and `HONUA_LIVE_API_KEY` (admin key; injected server-side by the vite proxy as `X-API-Key`, never baked into the bundle) are set. See `test/playwright/live-demo-journeys.spec.mjs`. CI runs this nightly against `demo.honua.io` (`.github/workflows/live-demo-smoke.yml`) |

Design tokens live in `src/theme/`: `tokens.css` holds the structural
spacing/type/radius/elevation scale, and `theme-standalone.css` /
`theme-console.css` are swappable color + density token SETS — the console
embed restyles Studio's chrome by flipping a `data-theme-set` attribute,
with zero component code changes (REQ-002). `src/theme/theme-loader.ts`
owns that attribute plus light/dark (`data-theme`, following
`prefers-color-scheme` unless overridden). The home view
(`src/pages/home.ts`) doubles as the live token-switch demo.

## License

Apache-2.0
