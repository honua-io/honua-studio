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
