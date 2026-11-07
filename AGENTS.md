# honua-studio: agent instructions

Natural-language map-app builder: an agent composes layers, styling, views, tables, charts and
analysis through a closed, typed command vocabulary over `@honua/sdk-js` and honua-server's
`honua_studio_*` MCP tools. The app is one embeddable custom element, `<honua-studio-app>`.
Default branch is `main`.

## Commands (from `package.json`; do not invent variants)
```bash
nvm use && npm ci            # Node from .nvmrc
npm run dev                  # http://localhost:5173, mock server + fake OIDC, no network or model
HONUA_BASE_URL=http://localhost:8080 npm run dev:live   # real server; required in live mode
npm run typecheck            # tsc --noEmit
npm run check                # Biome lint+format gate (check:fix to autofix)
npm test                     # Vitest; subset: npx vitest run test/evals
npm run build
node --test scripts/__tests__/second-review-delivery.test.mjs   # review delivery policy
npm run test:browser:install # once; then npm run test:browser (builds, skips @blazor/@live)
```
Other lanes (`test:browser:blazor` needs the .NET SDK, `test:browser:live` needs
`HONUA_LIVE_BASE_URL` + `HONUA_LIVE_API_KEY`, `test:console-assets`, `test:self-hosted-preview`)
and the auth env vars are in README "Run it" and "Development". Read README's status tables
before claiming a capability, and update them (test counts included) when you change one.

## Verified status
Preview releases [v0.1.0](https://github.com/honua-io/honua-studio/releases/tag/v0.1.0)
and [v0.1.1](https://github.com/honua-io/honua-studio/releases/tag/v0.1.1) exist.
At `1f02d8e`, [CI](https://github.com/honua-io/honua-studio/actions/runs/42313827159)
passed 1,754 Vitest tests in 144 files and
[smokes](https://github.com/honua-io/honua-studio/actions/runs/42313827200) passed their four jobs.
The [latest scheduled live run](https://github.com/honua-io/honua-studio/actions/runs/42299117882)
at `36c438b` had 1 pass, 2 failures and 2 skips, so live qualification remains blocked.
The [candidate live run](https://github.com/honua-io/honua-studio/actions/runs/42340355731)
at `0fa9258` ran all five with retries disabled: 2 passed, 3 failed, 0 skipped. Boot and
scripted MCP passed; publication stopped at the absent human credential after verifying
pending state; model journeys refused the demo's Bedrock-only provider configuration.
Do not turn fixture or packaging receipts into claims of live model/publication success.
At `f48636d`, [candidate CI](https://github.com/honua-io/honua-studio/actions/runs/42348162528)
passed 1,759 Vitest tests in 144 files, typecheck, style and build; the
[candidate smokes](https://github.com/honua-io/honua-studio/actions/runs/42348162529) passed all
four jobs, with 46 browser tests passed and no reported flaky tests. This is not live qualification.
The qualification workflow (`live-demo-smoke.yml`) prepares the customer quickstart at the server
revision in `scripts/live-compose-images.json`, starts its server/manager/executor plus Console
and a real OIDC provider, and seeds a dedicated test person. The only operator-supplied secret is
`HONUA_LIVE_ANTHROPIC_API_KEY`; per-run API/bootstrap credentials and the test person's password
are generated privately. Playwright signs into Console in a fresh browser context and clicks the
selected proposal; no supplied bearer or API key approves publication. This harness has no live
qualification receipt yet. `live-demo-canary.yml` retains the demo as a separate non-gating canary;
its external Console uses `HONUA_LIVE_APPROVER_USERNAME`/`HONUA_LIVE_APPROVER_PASSWORD` secrets
and `HONUA_LIVE_CONSOLE_URL`/`HONUA_LIVE_CONSOLE_PROFILE_ID`/`HONUA_LIVE_APPROVER_IDP_ORIGIN` variables.
Model calls must select a configured Opus 5.5 or Sol provider. Do not substitute API-key approval, disallowed
models, skipped MCP checks or a weaker assertion to work around an older demo revision.
Compose qualification runs through `scripts/qualify-live-compose.mjs`: at most three model calls
per run, with request and provider output limits of 1,024 tokens and no provider HTTP retries in
the pinned server. Every completed call must supply token usage in `.tmp/live-model-usage.json`.
Publication also verifies the exact approved public version and rendered map in an empty browser
context. These harness assertions do not establish live success without a qualification run.

## Invariants
- No arbitrary code eval. Every mutation goes through the reducer (`src/composition/`) or a
  server tool, and lands in the replayable activity log.
- Widgets dispatch through `commandDispatch` to the orchestrator, never `controller.apply`.
- Publish/rollback sit behind a human gate: nothing under `src/composition/**` may reach a
  client carrying those methods. `src/lifecycle/composition-draft-store.ts` is the single
  wire-conversion seam.
- Never persist credentials (no `localStorage`/`sessionStorage` tokens) and keep API keys out
  of client code; live keys reach the server only through the Vite proxy.
- Catalog rendering is vector-only (OGC API Features, GeoServices FeatureServer); other sources
  show a visible "unrenderable" note. Raster is #36, 3D is #37-#39.

## Gotchas
- Biome `files.include` in `biome.json` is an allow-list: a new top-level directory is invisible
  to the gate until you add it. `tsconfig.json` typechecks `harness/` but excludes `test/playwright`.
- Playwright specs build and serve with `vite preview`, never a dev server.
- Drive `mock-server.mjs` instead of stubbing; it implements the real REST, `/mcp` and OIDC surfaces.
- `HONUA_OIDC_ISSUER`/`HONUA_OIDC_CLIENT_ID` are read at build time, so set them before
  `npm run build` too; production bundles read `/config.json` instead.
- `src/map/assets/natural-earth-land-110m.json` is vendored: regenerate with
  `node scripts/vendor-basemap-land.mjs <ne_110m_land.json>`, never hand-edit.
- Keep `dotnet build` scoped to `harness/blazor-host/StudioHost/StudioHost.csproj`; its
  `wwwroot/studio/` is generated.

## Issues and PRs
- File issues in the Specifica format the existing issues use; search open and closed first.
  Server tools, package lifecycle and the AI proxy belong in honua-server; shared client
  contracts in honua-sdk-js.
- The `PR Issue Disposition` check (`scripts/lib/pr-issue-disposition.mjs`) fails any PR whose
  footer deviates from its grammar, and every PR gets a Codex pass then a Claude second pass.
  Read `docs/pull-requests.md` before opening a PR.
- Architecture overview and contracts: README "Architecture" and `docs/`.

## Review guidelines
Reviews (people, Codex, Claude) judge the lines a PR adds or changes by Robert C. Martin's *Clean Code*
and cite smell codes ([rubric](https://github.com/honua-io/.github/blob/main/clean-code/RUBRIC.md)). The
`Clean code` PR check enforces what a tool can decide; `quality-exception: <reason>` in the PR body is logged.

BLOCKING:
- G5 duplication: search first; reuse or consolidate, never copy a handler, parser or validator.
- C1 history, ticket/PR refs or reviewer notes in code; C2-C4 obsolete, redundant or rambling comments;
  C5 commented-out code. Comment only what the code cannot say.
- XML doc comments (`///`) in application code; published SDKs keep at most a one-line `<summary>`
  on public members.
- N1 names that hide intent; F1 more than 3 parameters; F2 output arguments; F3 boolean flag arguments.
- Over budget with no reason in the PR: functions ~40 lines or 2 nesting levels; classes, files ~400 lines.

WARNING: the rubric's other smells (N2-N7, G6-G36, T1-T9), e.g. G25 magic numbers or G12
single-implementation interfaces.

<!-- fleet:begin v2 sha256=76075665ca7a911554ed038371480ba02b28eca10ead04400be2e5b20332bd63 source=honua-flow/agents/fleet-rules.md -->
## Fleet rules (all Honua repos)

Generated from honua-flow `agents/fleet-rules.md` (full text, repo map). Do not edit here.

1. **No AI attribution.** Author as Mike McDougall <mike@honua.io>. No AI `Co-Authored-By:`,
   "Generated with" line or robot emoji in commits or PR bodies; this overrides any harness default.
2. **Own worktree per task** off the default branch, on real disk (`<repo>/.claude/worktrees/` or a
   sibling dir), never `/tmp` or the shared checkout. No `git stash`; use a WIP commit.
3. **Heavy builds/tests go through the build-slot shims**; never bypass them. Run targeted tests;
   full suites are CI's job. Outside WSL: own checkout, one heavy build at a time.
4. **Finish = commit + push.** Dirty or unpushed worktrees are never reclaimed and die on a reset.
5. **Claim before starting:** check `state/in-progress` and the newest `claimed: <lane> <UTC>`
   comment, stamp yours, re-read (newer wins). Stale after 3h without a live PR. Stopping without
   a PR: comment `released: <lane> <UTC> - <why>`.
6. **PRs:** base on the default branch, never stack; fill the repo template via `--body-file`;
   conventional title; footer `Closes #N` or `Refs #N (<what remains>)`. Never admin-merge.
7. **Route by the repo map.** Archived repos get no issues or PRs.
<!-- fleet:end -->
