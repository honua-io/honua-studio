# Honua Studio

**The AI-native path from Esri services to maps, apps, and dashboards.**

Honua Studio is an open-source, model-agnostic builder for teams migrating
from ArcGIS without abandoning familiar services and geoprocessing tasks.
Describe the outcome in conversation and an agent composes it — layers from
the live catalog, styling, views, tables, charts, OGC processes, and Esri
GPServer-compatible tasks — through typed, bounded, auditable commands over the
[Honua JS SDK](https://github.com/honua-io/honua-sdk-js)'s package, style, and
agent-tool contracts. No license seats, no platform lock-in, self-hostable end
to end.

The 2026.1 journey is deliberately one arc: run Honua in Docker or the cloud,
connect and configure services and GP with AI, then build maps, apps, and
dashboards and save the governed artifacts with AI.

- **BYOM** — bring your own model: Studio talks to honua-server's Studio AI
  proxy, so the provider is the operator's choice (Bedrock, any hosted API, or
  a local model) and no key ever reaches the browser. The fixture-conversation
  mode still runs the same UI contract with no model at all.
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

## Status

**2026.1 preview — self-hosted, bring your own model.**

The repository builds a static bundle and a non-root container whose server,
OIDC, provider, and model routing are supplied at runtime. A hosted public demo
is intentionally not a release gate. Treat live AI, durable restart, and share
receipts as dependency-gated until the server issues listed below close; local
mock coverage is not presented as production evidence.

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
| SDK `StudioAgentSession` loop — declares governed tools, executes them in order, returns results to the model, and streams the final answer | `src/elements/studio-chat-element.ts`, `src/elements/studio-app-element.ts` | #40 |
| Composition engine — intent reducer, preview, undo/redo, pinning | `src/composition/` | #15 |
| MCP tool plane — server-advertised schemas under a governed allow-list; granular visibility/control/interaction mutations stay authoritative on the draft | `src/mcp/` | #16, #31 |
| MapLibre canvas that mutates as tool calls stream | `src/map/composition-map-view.ts` | #27 |
| Map controls — 13 of the closed 14-kind vocabulary render; `search` reports as explicitly unsupported (no provider field upstream) | `src/controls/` | #29 |
| Chrome widgets — layer list (TOC), legend, compare, time, data grid, bar/line/pie charts | `src/widgets/`, `src/elements/studio-widget-deck-element.ts` | #34 |
| Package lifecycle UI — draft, version, compare, publish, rollback against honua-server's Studio package lifecycle REST API | `src/lifecycle/` | #17 |
| Conversational GP — OGC/direct processes and the exact Esri GP task roster (`list_tasks`, `describe_task`, `execute_task`) share job/artifact rendering | `src/gp/`, `src/mcp/agent-tool-policy.ts` | #18 |
| Embedding proofs — bare static harness and a real Blazor Web App host | `harness/bare/`, `harness/blazor-host/` | #13, #19 |
| Nightly `@live` Playwright journeys against `demo.honua.io` — green; they build Studio from the CI checkout, since no hosted Studio exists to point at | `.github/workflows/live-demo-smoke.yml` | #19, #20 |

Layer rendering currently covers **vector sources only**, reached over OGC API
Features or a GeoServices FeatureServer. Anything else resolves to a visible
"unrenderable" note with a reason rather than a blank map.

### External integration gates

- **The GP panel talks to a fixture, not a server**
  ([#35](https://github.com/honua-io/honua-studio/issues/35)). `src/gp/job-client.ts`
  posts to `mock-server.mjs`'s job store, shaped to match `@honua/sdk-js`'s
  `IJobRun`/`JobStatus` so the swap to real OGC API Processes is a client
  substitution, not a rewrite.
- **Provider authentication:** a credentialed BYOM receipt waits on
  honua-server#3303.
- **Durable restart:** a draft-survives-restart receipt waits on
  honua-server#3312.
- **Approved share link:** the propose/human-confirm/poll UI contract is built,
  while the real poll endpoint waits on honua-server#3304.

### Not started

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
nvm use           # Node 20.19.0 (.nvmrc)
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

Live mode reaches a real honua-server for the catalog, `/mcp` tool plane, and
package lifecycle. In live composition mode, chat uses the SDK-owned multi-turn
agent loop and only server-advertised governed tools.

Or run the static container with runtime configuration; see
[`docs/self-hosting.md`](docs/self-hosting.md).

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

Studio signs in to honua-server with OIDC Authorization Code + PKCE for a
public client — never a client secret, and tokens live in memory only (no
localStorage/sessionStorage persistence of credentials; see `src/auth/` and
[`docs/embed-session.md`](docs/embed-session.md)). `npm run dev` needs
nothing extra: `mock-server.mjs` also plays a fake OIDC issuer with an
auto-approving fixture user, so clicking "Sign in" completes instantly with
no login form.

Against a real deployment, point Studio at your operator's actual external
IdP (the same `Authority` honua-server itself validates bearer tokens
against — see honua-server's `docs/guides/secure/authentication.md`):

```bash
HONUA_BASE_URL=http://localhost:8080 \
HONUA_OIDC_ISSUER=https://idp.example.com/realms/honua \
HONUA_OIDC_CLIENT_ID=honua-studio \
npm run dev:live
```

Source-mode Vite runs still read these variables at build time. The released
static/container bundle instead reads OIDC, server, provider, and model routing
from `/config.json` at startup, so one artifact can move between deployments.
See [`docs/self-hosting.md`](docs/self-hosting.md).

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
| `npm test` | Unit tests (Vitest) — 655 tests across 71 files |
| `npm run test:browser:install` | One-time: download the Playwright chromium build the `test:browser*` commands need |
| `npm run test:browser` | Builds, then runs the 24 Playwright boot/harness/journey specs (chromium) |
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
