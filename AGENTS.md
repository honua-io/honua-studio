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

## Qualification evidence
Read README status tables and the Releases page for current evidence; fixture and packaging
checks do not establish deployed qualification. Native `/api/v1/studio` host sessions require
Console's captured `fetchRequest`; legacy `/api/studio` sessions retain the BFF CSRF contract.
Focused coverage is in `test/auth/native-host-session.test.ts`.

`live-compose-qualify.yml` (reused by `live-demo-smoke.yml`) and
`scripts/qualify-live-compose.mjs` qualify the quickstart pinned in `scripts/live-compose-images.json`.
Candidate journeys are opt-in and must match the pinned server revision; the demo canary is separate.
Keep the three-model-call budget, 1,024-token request/provider limits, disabled provider retries,
and completed token-usage evidence. Paid runs require founder authorization; do not raise budgets
or weaken assertions to obtain green. Use a configured Opus 5.5 or Sol provider.
Publication requires real OIDC human approval in a fresh context and rendering of the exact
approved public version in an empty context. API-key approval, skipped MCP checks and fixture
receipts cannot substitute for those assertions. Load org skill `honua-launch-stack-qualify`
for Launch Stack deployment; Studio-specific qualification mechanics remain in README and these workflows.

## Invariants
- No arbitrary code eval. Every mutation goes through the reducer (`src/composition/`) or a
  server tool, and lands in the replayable activity log.
- Widgets dispatch through `commandDispatch` to the orchestrator, never `controller.apply`.
- Publish/rollback sit behind a human gate: nothing under `src/composition/**` may reach a
  client carrying those methods. `src/lifecycle/composition-draft-store.ts` is the single
  wire-conversion seam.
- Never persist credentials (no `localStorage`/`sessionStorage` tokens) and keep API keys out
  of client code; live keys reach the server only through the Vite proxy.
- Catalog rendering supports OGC API Features, GeoServices FeatureServer and public PMTiles
  vector/raster archives. Other sources show a visible "unrenderable" note; COG is #254, 3D is #37-#39.

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
  footer deviates from its grammar. Read `docs/pull-requests.md` for the footer and
  current lane rulings plus org skill `honua-pr-flow` for final-head review and publication.
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

<!-- fleet:begin v3 sha256=4faeba041ae102508d105847af58b407641cbfdf1ae506488819a2ccdbe73e29 -->
## Fleet rules (all Honua repos)

Generated from the org fleet-rules source; do not edit this block. Start with org skill `honua-system-map`.

1. Author commits as the repository owner's configured git identity. No AI attribution in commits or PR bodies.
2. Use a separate worktree per task, off the default branch, on durable disk. Include current trunk before opening a PR. No shared-checkout edits or git stash; preserve work with commits.
3. Run .NET builds and tests only through the approved remote build-host shims. Never fall back to a local build. See org skill `honua-build-host`.
4. Commit and push completed work; keep existing branches, commits and worktrees until their retention rules permit cleanup.
5. Claim work before starting, reread the issue and current lane rulings, and release the claim after completion. See org skill `honua-dev-loop`.
6. Use a PR slot and bundle at least three issues, a plan row, or a permitted single-work reason. Current caps and exceptions come from current lane rulings.
7. Target the default branch with the repository's PR template and conventional title. Never force-push or use an admin merge.
8. Run pre-PR checks, obtain one independent review of the final head, and resolve every review thread. Merge on green required checks; arm auto-merge where enforced checks support it. See org skill `honua-pr-flow`.
9. Read failed required-check logs and fix in one push. For red trunk, fix forward or revert within the repository's current ruling deadline; see org skills `honua-red-pr` and `honua-trunk-red`.
10. Never commit secrets, deployment identifiers, private repository names or infrastructure details. Security findings belong in the private tracker. Archived repos get no issues or PRs; public instructions name org skills only.
<!-- fleet:end -->
