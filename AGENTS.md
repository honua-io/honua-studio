# Honua Studio Agent Instructions

## Overview

Honua Studio is an open-source, model-agnostic **natural language to map app** builder: describe an app in
conversation and an agent composes it — layers, styling, views, tables, charts, analysis — through a closed, typed
command vocabulary over [`@honua/sdk-js`](https://github.com/honua-io/honua-sdk-js) and honua-server's
`honua_studio_*` MCP tools. No arbitrary code eval: every mutation goes through the reducer or a server tool and
lands in a replayable activity log. The app is exactly one embeddable custom element, `<honua-studio-app>`.

Status is **v0.1 preview — bring your own model, run from source**: no released build, container, bundle, or hosted
instance (#41). Two facts shape most tasks here. **Fixture-conversation mode is the only mode in which a turn
composes the map end to end** — the SSE transport streams a real model's tool-call events, but the request never
declares tool definitions and results are never fed back, so the agent loop does not close yet (#40). And **layer
rendering is vector-only** (OGC API Features or a GeoServices FeatureServer); anything else resolves to a visible
"unrenderable" note with a reason — raster is #36, 3D is #37–#39. `README.md` is the truth-checked status surface
(#44): read its tables before claiming a capability, and update them (test counts included) when you change one.

## Tech Stack

- **Language:** TypeScript 5.9 (`strict`, `verbatimModuleSyntax`, `isolatedModules`, `moduleResolution: Bundler`, target `ES2022`, `noEmit`), ESM only.
- **Node:** `>=20.19.0`; `.nvmrc` and CI pin `20.19.0`.
- **Bundler/dev server:** Vite 8 — multi-page build (the shell plus `harness/bare/`).
- **Tests:** Vitest 4 (`environment: node`, `test/**/*.test.ts`) + Playwright 1.58 (chromium only, `test/playwright/*.spec.mjs`).
- **Lint/format:** Biome 1.9.4 (`biome.json`), 2-space indent, 120 cols.
- **Map runtime:** `maplibre-gl` 5.24.0; SDK pin `@honua/sdk-js` 0.1.7-beta.0.
- **Blazor embed harness:** .NET 10 SDK (`harness/blazor-host/`), needed only for the `@blazor` lane.

## Setup

```bash
nvm use            # Node 20.19.0 (.nvmrc)
npm ci             # lockfile present; use npm ci
npm run dev        # http://localhost:5173 — mock fixture, no network, no model
```

`npm run dev` is the zero-setup path: `scripts/dev-mock.mjs` starts `mock-server.mjs` (honua-server *and* a fake
auto-approving OIDC issuer) and points Vite's proxy at it, so "Sign in" completes instantly and the fixture
conversation drives the canvas without a model. Against a real server use
`HONUA_BASE_URL=http://localhost:8080 npm run dev:live` (required in live mode — Vite throws without it); real-IdP
sign-in also needs `HONUA_OIDC_ISSUER` and `HONUA_OIDC_CLIENT_ID`, **baked into the bundle at build time**, so set
them before `npm run build` too. See README "Authentication" and [`docs/embed-session.md`](docs/embed-session.md).

## Commands

From the repo root; copied from `package.json` / CI. Do not invent variants.

- **Dev:** `npm run dev` (fixture) / `npm run dev:live`; fixture server alone: `npm run mock-server`
- **Build / preview:** `npm run build`, `npm run preview`
- **Typecheck:** `npm run typecheck` (`tsc --noEmit`)
- **Lint+format gate:** `npm run check` (Biome); autofix `npm run check:fix`; format only `npm run format` / `npm run format:fix`
- **Unit tests:** `npm test` (`vitest run`); watch `npm run test:watch`; a subset with `npx vitest run test/evals`
- **Browser:** `npm run test:browser:install` once (Playwright chromium), then `npm run test:browser` — builds first, runs every spec except `@blazor`/`@live`
- **Blazor host lane:** `npm run test:browser:blazor`, wrapping `npm run build:blazor-host` (= `build:blazor-assets` plus a scoped `dotnet build` of `harness/blazor-host/StudioHost`); needs the .NET SDK, see that dir's README
- **Live lane:** `npm run test:browser:live` — `@live` journeys against a real deployment; skips unless `HONUA_LIVE_BASE_URL` and `HONUA_LIVE_API_KEY` are set (the key is injected server-side by the proxy as `X-API-Key`, never bundled)

CI (`.github/workflows/ci.yml`, PR + push to `main`) runs `typecheck`, `check`, `unit` (`npm test`), `build`,
`browser-smoke`, and `blazor-host-smoke` (builds the host, then `npx playwright test --grep @blazor`).
`pr-issue-disposition.yml` runs the `PR Issue Disposition` check on every PR (see "Pull Requests").
`live-demo-smoke.yml` runs `test:browser:live` nightly against `demo.honua.io`; `security.yml` runs the org's
reusable Trivy + Scorecard workflows.

## Architecture

`src/main.ts` mounts `<honua-studio-app>`; every surface is a custom element (`src/elements/`). The composition
path: chat SSE or fixture transport (`src/chat/`) → `ToolCallOrchestrator` (`src/mcp/orchestrator.ts`) →
`src/mcp/tool-bridge.ts`, which decides local reducer (`src/composition/reducer.ts`) vs. server tool over
honua-server's `/mcp` (`src/mcp/client.ts`) → the MapLibre canvas (`src/map/composition-map-view.ts`) and the widget
deck (`src/widgets/`). Command vocabulary lives in `src/composition/commands.ts` (history/undo/pinning in
`controller.ts` + `history.ts`); `STUDIO_MCP_TOOL_NAMES` (`src/mcp/studio-tools.ts`) holds typed wrappers for 13 of
the 17 tools honua-server publishes. Persistence is honua-server's Studio package lifecycle via `src/lifecycle/`,
whose `composition-draft-store.ts` is the single wire-conversion seam; publish/rollback sit behind a human gate, so
nothing under `src/composition/**` may reach a client carrying those methods. Auth (`src/auth/`) is OIDC
Authorization Code + PKCE, public client, tokens in memory only; embedded hosts hand off a session instead.

Contracts, in `docs/`: [`element-contract.md`](docs/element-contract.md), [`embed-session.md`](docs/embed-session.md),
[`ai-chat-wire-contract.md`](docs/ai-chat-wire-contract.md), [`evals.md`](docs/evals.md); the v0.1 specification is
`.specifica/studio-v0/spec.md`.

## Directory Layout

```
src/            # app source: auth chat client composition controls elements evals gp interactions
                # lifecycle map mcp pages router styles theme widgets; main.ts is the bootstrap
test/           # vitest specs mirroring src/ + test/playwright/*.spec.mjs
harness/        # bare/ static embed harness, blazor-host/ .NET test host, blazor-host-src/ its mount module
scripts/        # dev-mock.mjs (npm run dev), vendor-basemap-land.mjs,
                # check-pr-issue-disposition.mjs + lib/ (the PR Issue Disposition check, + .d.mts types)
mock-server.mjs # fixture honua-server + fake OIDC issuer (+ .d.mts types)
docs/  vite.config.ts  vite.blazor-assets.config.ts  vitest.config.ts
playwright.config.mjs  biome.json  tsconfig.json  .nvmrc
```

## Conventions & Gotchas

- `npm run check` (Biome) is the CI style gate — run it, or `check:fix`, before calling work done. `noExplicitAny` is `warn` in `src/`, off in `test/`; `noNonNullAssertion` and `useNodejsImportProtocol` are off.
- Biome's `files.include` is an explicit allow-list (`src`, `test`, `harness`, `scripts/**/*.mjs`/`*.mts`, root `*.mjs`/`*.mts`/`*.ts`/`*.json`); a new top-level directory is invisible to the gate until you add it.
- `tsconfig.json` excludes `test/playwright` (those specs are `.mjs`) but includes `harness/bare` and `harness/blazor-host-src`, so harness code must typecheck.
- Playwright specs build the app and serve it with `vite preview` — never a dev server. `@blazor` and `@live` are excluded from the default browser run.
- Drive `mock-server.mjs` rather than stubbing: it implements the real REST, `/mcp` and OIDC surfaces, which is what makes fixture-mode tests meaningful.
- Four commands (`addControl`/`removeControl`, `bindInteraction`/`removeInteraction`) still apply locally instead of calling their server tool (#43). The seam is `commandDispatch` → orchestrator, never `controller.apply` from a widget.
- Never persist credentials — no `localStorage`/`sessionStorage` tokens — and keep API keys out of client code; live keys reach the server only via the Vite proxy.
- `src/map/assets/natural-earth-land-110m.json` is a vendored build input: regenerate it with `node scripts/vendor-basemap-land.mjs <ne_110m_land.json>`, never hand-edit.
- `harness/blazor-host/StudioHost/wwwroot/studio/` is generated and gitignored; keep `dotnet build` scoped to `StudioHost.csproj`, never the whole tree.

## GitHub Issues

- File with `gh issue create` in the owning repo, in the Specifica format the existing issues use (Specifica / Context / User Workflow / Requirements REQ-*+NFR-* / Acceptance Criteria / Data, Caching, and Realtime Notes / Validation). Search open and closed issues first to avoid duplicates.
- Studio client work belongs here; server tools, package lifecycle and the AI proxy belong in `honua-io/honua-server`; shared client contracts in `honua-io/honua-sdk-js`.
- Existing labels: `slice/studio` (also `slice/gp`, `slice/raster`, `slice/3d`, `slice/chrome`), `release/2026.1` / `release/2026.2` / `release/later`, `priority/P*`, `size/*`, `state/ready` / `state/blocked` / `state/needs-grooming`.

## Pull Requests

- Branch off `main`. Commit messages and PR titles are Conventional Commits with a scope (`feat(tool-bridge): …`, `docs(readme): …`); PRs squash-merge, so the title becomes the commit subject.
- End the body with the issue disposition — `Closes #N` when every acceptance criterion is met, `Refs #N (what remains)` when it genuinely is not. The `PR Issue Disposition` check (`.github/workflows/pr-issue-disposition.yml` → `scripts/check-pr-issue-disposition.mjs`) enforces the grammar and **fails the PR** on any deviation, so get the footer right when you open the PR rather than after a red check. The block must be the final nonblank lines, one disposition per issue, at most 20, no issue twice; a `Refs` explanation is 1–160 trimmed characters with no parentheses and must carry a progress marker (`S<number>`, `slice`, `partial`, `remain`/`remains`/`remaining`, `follow-up`, `blocked`, `handoff`). No `Refs #N` and no closing keyword tied to an issue (`close`/`fix`/`resolve` + `#N`) may appear above the block — write "this PR is not sufficient on its own", never "this does not close #123". The check also resolves every declared issue against `honua-io/honua-studio`, so a syntactically perfect footer still fails when it names a closed issue, a pull request, or an issue in another repository.
- Syntax-check a body before pushing instead of guessing at the grammar (this covers the footer grammar only — the API-resolution rules above are checked in CI):
  ```bash
  node --input-type=module -e '
  import { parsePullRequestDisposition } from "./scripts/lib/pr-issue-disposition.mjs";
  import { readFileSync } from "node:fs";
  console.log(parsePullRequestDisposition(readFileSync("/tmp/body.md", "utf8")));'
  ```
- Say what changed, what you tested and which acceptance criteria are met; state honestly what you could not run locally (`npm run test:browser` needs browser system deps this box may lack) and leave it to CI.
- Open PRs non-draft with `gh pr create`; all six CI jobs plus the `PR Issue Disposition` check must be green.

## Shared dev-environment rules (multi-agent WSL)

This machine runs many agents concurrently (**Codex + Claude**, often via agentflow with multiple tabs/agents). To prevent host lockups and lost work, every agent MUST follow these:

1. **Heavy builds/tests are throttled by a shared lock.** `dotnet` and `npm` are PATH-shimmed, so their build/test/publish/pack and ci/install/test/run-build/run-test subcommands automatically run under a global semaphore (default 1 concurrent, `HONUA_BUILD_SLOTS`). For other heavy tools, call the wrapper explicitly: `with-build-lock pytest ...`, `with-build-lock cargo build`, `with-build-lock make build`. The lock is shared across ALL of this user's processes (every Codex/Claude tab, agentflow children). Do not bypass it for compiles or test suites. Long-running servers (`dotnet run`, `npm run dev`) are intentionally NOT locked — never wrap those.

2. **Commit and push when you finish a task** so your worktree can be reclaimed. An hourly job (`honua-clean`) removes a worktree ONLY when it is clean AND fully pushed (merged, remote-gone, or idle >=2d). Dirty or unpushed worktrees are NEVER touched — but uncommitted/unpushed work blocks reclamation and is at risk if the instance is reset. Build artifacts (bin/obj and untracked node_modules) are reclaimed automatically and safely.

3. **Commit hygiene — no agent attribution.** Author every commit as the repo owner only (git identity: Mike McDougall <mike@honua.io>). Do **NOT** add any agent/tool attribution to commits: no `Co-Authored-By: Claude ...`, no `Co-Authored-By: Codex ...` (or other bot co-authors), and no "Generated with Claude Code" / "Generated with Codex" / "🤖" lines in the message or PR body. Write a plain, descriptive commit message and stop.
