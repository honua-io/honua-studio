# Honua Studio

**Natural language to map app.**

Honua Studio is an open-source, model-agnostic builder
for geospatial applications: describe the app you want in conversation, and an
agent composes it — layers from the live catalog, styling, views, tables,
charts, analysis — through typed, bounded, auditable commands built on the
[Honua JS SDK](https://github.com/honua-io/honua-sdk-js). No license seats, no
platform lock-in, self-hostable end to end.

- **BYOM** — bring your own model: server-side Studio AI (e.g. Bedrock), any
  hosted API, or a local model. The fixture-conversation mode runs with no
  model at all.
- **Typed, not generated** — every mutation flows through the SDK's
  agent-tools/app-controller contract. No arbitrary code eval; a live activity
  log shows every action, replayable step by step.
- **Durable artifacts** — compositions serialize to the Studio package
  families (`@honua/sdk-js/studio`) and save through
  [honua-server](https://github.com/honua-io/honua-server)'s Studio package
  lifecycle: drafts, immutable versions, comparisons, publish, rollback.
  Sessions eject as generated-app configs that boot standalone.
- **Collaboration through the platform** — asynchronous today via shared
  drafts and version history; live co-editing arrives with
  honua-io/honua-server#2999.
- **Console-compatible** — packages round-trip with
  [Honua Console](https://github.com/honua-io/honua-console)'s `/studio`
  surface; Studio is a platform capability, not a client feature.

## Status

Pre-implementation. The founding specification is
[#1 — agent-composed dynamic UI](https://github.com/honua-io/honua-studio/issues/1);
the first flagship deployment is the statewide Hawaii demo
(honua-io/honua-sdk-js#776).

## Development

Phase 0 scaffold (honua-io/honua-studio#3): a Vite + TypeScript app shell
consuming [`@honua/sdk-js`](https://github.com/honua-io/honua-sdk-js),
Biome for lint/format, Vitest for unit tests, and Playwright for browser
boot smokes.

```bash
nvm use          # Node 20.19.0 (.nvmrc)
npm ci            # install dependencies
npm run dev       # dev server against a mock honua-server fixture — no network
```

Point the dev server at a real server instead:

```bash
HONUA_BASE_URL=http://localhost:8080 npm run dev:live
```

Other commands:

| Command | Purpose |
| --- | --- |
| `npm run build` / `npm run preview` | Production build / preview it locally |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run check` / `npm run check:fix` | Biome lint + format check / autofix |
| `npm test` | Unit tests (Vitest) |
| `npm run test:browser` | Builds, then runs the Playwright boot smokes (chromium) |

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
