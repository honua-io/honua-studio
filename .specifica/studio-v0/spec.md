# Specifica: Honua Studio v0 — One JS Studio, Two Shells

Type: Workstream
Workstream: Honua Studio
Owner repo: honua-io/honua-studio
Affected repos: honua-io/honua-studio, honua-io/honua-sdk-js, honua-io/honua-console, honua-io/honua-server, honua-io/honua-samples (distribution), honua-io/honua-site (showcase)
Priority: P1
Phase: Beta
Canonical source: `.specifica/studio-v0/spec.md` in honua-io/honua-studio (GitHub issues are projections)
Projected issues: honua-studio#1 (capability), honua-studio#2 (epic), honua-studio#3–#10 (features), honua-sdk-js#780, honua-console#324, honua-server#2999/#3000/#3001; flagship consumer honua-sdk-js#776

## Platform Beliefs (why this workstream exists)

1. **Server admin sucks — it should be an AI job with safety and guardrails.** AI never edits feature data (honua-server ADR-0028). AI mutates only *configuration and composition*, and only through the trust ladder: propose → validate/dry-run → diff preview → scoped-authorization apply → audit trail → one-step revert. Reversibility is the safety model: whether the human or the AI got it wrong, the fix is the same cheap revert.
2. **Map making is an AI job.** Natural language to map app: compose layers, styling, views, tables, charts, and analysis conversationally, with humans directing intent and reviewing diffs.
3. **AI DevOps closes the loop.** The server-computed operate loop plus OpenTelemetry observability feed an AI operator that diagnoses and tunes performance under the same ladder.

Tagline: **Natural language to map app.**

## Context

Prior art is real and load-bearing:

- **Console Studio** (honua-console `/studio`, Blazor): AI-assisted authoring/publishing of queries, analyses, maps, dashboards, reports, forms, apps, workflows. Per console's own docs (docs/studio/package-editor-routes.md), the shared shell binds the Studio lifecycle API; the workflow editor and form builder are live-bound (forms via `/api/v1/admin/forms/packages`); and `/studio/analysis` is live-bound too (honua-console#53, over `/api/v1/analysis/content` + artifacts + jobs). The remaining per-family editors (query/map/dashboard/report/app) still run a local `studio-package-mock/v1` projection. **The expensive editor work is still ahead — this workstream redirects it to JS instead of building it twice.**
- **Server Studio lifecycle** (honua-server `/api/v*/studio`, Postgres-backed): package families (query, analysis, map, dashboard, report, form, app, workflow, GP, ETL); mutable drafts with optimistic generation; validation; preview plans (GP/ETL/workflow advertise job-backed previews); immutable content versions; comparisons (hash/dependencies/validation/provenance); publish requests; reopen; rollback. Admin-authorized in the MVP.
- **SDK contracts** (`@honua/sdk-js/studio`, experimental): browser-safe projections, validation/preview envelopes, publish/share/embed contracts for the package families.
- **Server AI**: `/mcp` implements the open geospatial-mcp standard (validate plans, dry-run, execute, read results under normal authorization); a Bedrock Studio-AI path exists (docs/guides/run-studio-ai-on-bedrock.md).
- **SDK agent/collaboration seams**: agent-tools (typed command surface), app-controller/app-workspace/generated-app, nl-map-control, collaboration client (transport-neutral, fixture transport only — server endpoints tracked in honua-server#2999).
- The Specifica item `ai-spatial-app-builder-and-query-studio` (agent-delivery-spec) covers adjacent ground and must be reconciled during Phase 1.

## Architecture Decisions

- **AD-1 — One implementation, two shells.** Studio is implemented once, entirely in JS/TS on the Honua JS SDK. Every Studio surface is an embeddable **custom element** with typed attributes/events; the standalone shell (this repo) and Honua Console's `/studio` host the identical elements. No shell-private editor logic.
- **AD-2 — Console is relieved, not rewritten.** Console keeps Blazor for Catalog/Operate/Share and hosts the Studio elements at `/studio` (custom elements render in any HTML host; the Blazor-specific hazards — enhanced-nav DOM patching, render modes, router ownership, focus — are exactly what the Phase 0 Blazor test host exists to de-risk). Its unbuilt per-family Blazor editors are cancelled behind a parity-gated retirement schedule (map/query/dashboard first; live-bound workflow/form last). ADR-0001's one-build/one-origin promise is preserved by vendoring pinned Studio assets into the console artifact.
- **AD-3 — Server owns persistence; round-trip by MIGRATION, not construction.** All Studio state serializes to the Studio package families and persists server-side. Reality check (adversarial review): console's live editors speak THREE server surfaces today — the Studio lifecycle API (shell), the forms package API (`/api/v1/admin/forms/packages`, ETag concurrency), and the analysis content/artifacts/jobs API. Round-trip with console therefore requires a server-side persistence unification/bridge for forms and analysis (owned honua-server issue) before those families round-trip; query/map/dashboard/report/app can be lifecycle-native from day one. The lifecycle API also lacks list/enumeration endpoints (get-by-id only) — an owned server issue adds content-item/draft enumeration scoped by ownership, and the sibling Content Publication Registry API is a named dependency of the publish story.
- **AD-4 — BYOM behind a seam; server-mediated by default.** One chat console; model access defaults to a server AI proxy (server holds credentials, applies policy/rate limits, audits; browser never sees model keys). The seam speaks the two lingua francas — Anthropic API and OpenAI-compatible — so OpenRouter, LiteLLM, Ollama, vLLM, LM Studio are *operator choices*, never foundations. Direct-endpoint mode is dev-only and flagged. A no-model fixture-conversation mode exists for CI and staged demos.
- **AD-5 — MCP is the tool plane, served where the state lives.** Data-access/plan/execute tools come from the server's `/mcp` catalog. Composition tools are only honestly MCP if the composition state they mutate is server-resident — see AD-8. External MCP clients (e.g. Claude Desktop) get identical semantics because they hit the same server-side tools; nothing routes tool calls into a browser tab. In-app, the model (behind the server AI proxy) calls the same server tools; the browser renders live state, it does not own it.
- **AD-8 — Composition state is server-draft-backed.** The composition a user and agent build IS a Studio lifecycle draft (or a set of drafts): the intent reducer's output persists to the draft via optimistic generation updates, undo/redo maps to draft revisions, and the browser holds a working view plus ephemeral UI state only. This is what makes AD-5's external-client parity, collaboration (#2999 checkpoints), crash recovery, and AD-3 persistence all cohere. Requires: server-side composition/lifecycle MCP tools (owned honua-server issue) and enumeration endpoints. The pure intent reducer (honua-studio#8) remains the client's projection/merge engine, not the source of truth.
- **AD-6 — Authenticated to honua-server, always.** OIDC sign-in; one session powers catalog, bounded queries, package lifecycle, and the AI proxy. In the console embed, Studio adopts the console session via the embed contract. Requires server authz widening beyond admin (honua-server#3001).
- **AD-7 — Reversibility is the product.** Every mutation (composition, config, GP execution side-effects) is versioned, diffable, and one-step revertible: Studio content versions + rollback; server change-management/admin-API substrate; GitOps path (honua-iac) where deployments manage config as code.

## User Outcomes

- A user describes an app and gets one — composed live, refined incrementally, exported durably ("vibe code map apps").
- Console users get the same Studio inside console with console auth/theming; nothing drifts because nothing is duplicated.
- Operators trust AI mutation because every change walks the visible trust ladder and reverts in one step.
- Self-hosters run the whole stack — front end, server, models — with zero third-party SaaS dependencies.

## Scope (phased)

### Phase 0 — Foundations
- honua-studio#3: scaffold, CI, design tokens (standalone + console theme sets), fixture and live dev modes.
- honua-studio#4: OIDC sign-in; session-driven SDK clients; embed-mode session handoff.
- honua-studio#5: the embeddable web-component contract + standalone shell + embed harnesses. **Load-bearing; blocks console embed.** Harnesses MUST include a minimal Blazor Web App test host (enhanced navigation on, interactive render modes) — a bare static page cannot reproduce the actual embed hazards (SSR DOM patching, render-mode re-instantiation, router URL ownership, focus across shadow DOM). The ADR-0001 amendment (Studio-as-JS hosted by console; framework-direction clause superseded for /studio) is written NOW, in Phase 0, as the decision record it is — not retroactively in Phase 3.
- honua-sdk-js#780: graduate `@honua/sdk-js/studio` from type projections to a full typed lifecycle client (all endpoints, optimistic generation, RFC 7807 problems).

### Phase 1 — Compose
- honua-studio#6: chat console, streaming, tool-call cards, replayable activity log, deterministic fixture-conversation mode.
- honua-studio#7: MCP tool plane — `/mcp` client + composition tools published over MCP; external-client parity.
- honua-studio#8: composition engine v0 — intent-state reducer (pure data), typed orchestration via app-controller, previewed diffs, undo/redo, pinning, incremental refinement.
- honua-server#3000: provider-agnostic Studio AI proxy adapters (Anthropic + OpenAI-compatible beside Bedrock), capability discovery, audit.
- Reconcile with the `ai-spatial-app-builder-and-query-studio` Specifica item; fold or supersede with cross-references.

### Phase 2 — Lifecycle and parity
- honua-studio#9: package lifecycle UI — drafts, versions, comparisons, publish, reopen, rollback; console round-trip fixtures both directions.
- honua-studio#10: conversational GP authoring → validate → job-backed preview plan → async batch execution → outputs registered as catalog layers; cancel/resume; versioned, re-runnable packages. Honesty note: today the server's GP support level is 'limited' with envelope-only validation and preview plans that are planning-only responses — REQ-006's gate is only as deep as server validation goes; the owned honua-server issue for real job-backed GP preview execution and deeper GP validation is a dependency.
- Per-family JS editors, EACH AS ITS OWN FILED ISSUE before Phase 2 planning (adversarial finding: the bulk of the workstream was unticketed): map, query, dashboard first (console's are mock-only); report/app next; analysis, workflow, and form LAST — all three are live-bound in console today (analysis via honua-console#53) and their retirement additionally depends on the persistence unification in AD-3.
- honua-server#3001: Studio lifecycle authorization widened beyond admin (ownership, publish/rollback policy gates, RFC 7807 surfaces), flag-gated.

### Phase 3 — Console embed and retirement (honua-console#324)
- Embed shell behind a feature flag; session handoff; console tokens; vendored pinned Studio assets (single deployable artifact).
- Parity ledger (epic #2 REQ-004) gates each Blazor editor deletion; round-trip fixtures per family required.
- ADR successor/amendment to ADR-0001 documenting Studio-as-JS-hosted-by-console.

### Phase 4 — Flagship and depth
- Hawaii flagship hosts Studio (honua-sdk-js#776 REQ-024): the demo is a live vibe-coding session against already-provisioned statewide data, including the Esri-service import beat, the reversibility/trust-ladder beat, and the AI-DevOps observability beat.
- Live co-editing client when honua-server#2999 lands (WebSocket transport for the existing collaboration contract; checkpoint-to-version semantics).
- BYOM evidence matrix (same journey across two providers + no-model mode), accessibility, performance budgets.

## Non-Goals

- Rewriting console's Catalog/Operate/Share surfaces.
- Any AI feature-data mutation (ADR-0028) — the data plane is read-only for agents everywhere in this workstream.
- Building on a hosted model aggregator (OpenRouter et al. remain endpoint choices).
- Long-term maintenance of two Studio implementations — the console flag period is bounded by the parity ledger.
- Offline/PWA operation of Studio v0.

## Requirements (workstream level)

- REQ-001: Every Studio surface is an embeddable custom element; standalone shell and console embed compose identical elements (AD-1); a bare embed harness proves third-party hosting.
- REQ-002: All persistence flows through the server Studio lifecycle; packages round-trip with console losslessly on fixtures (AD-3).
- REQ-003: Default model path is the server AI proxy; no model credentials reach the browser in default mode; two-provider + no-model journeys pass (AD-4).
- REQ-004: All agent tooling is MCP over the authenticated session; an external MCP client reproduces a composition journey with identical read-only guarantees (AD-5).
- REQ-005: The composition engine enforces typed bounded orchestration with preview/undo/pin; fixture conversations snapshot-test the resulting app state; no arbitrary code evaluation (honua-studio#1).
- REQ-006: GP authoring executes only after validation and a confirmed job-backed preview plan; outputs are additive datasets; jobs cancel and resume (honua-studio#10).
- REQ-007: A parity ledger tracks console-Blazor-editor capabilities vs JS editors and gates each retirement (honua-console#324).
- REQ-008: Every mutation surface exposes diff + one-step revert; the trust ladder is visible in the UI (AD-7).
- REQ-009: Publish, share, embed, and any action that widens exposure are HUMAN-CONFIRMED gates the agent can propose but never invoke; revert does not un-expose content, so exposure is never agent-initiated. (Adversarial finding: preview+undo is not an apply gate; publish must be.)
- REQ-010: The agent-reachable tool surface is enumerated in one auditable registry; each tool is classified read-only or config-plane, and a CI tool-surface audit fails on any unclassified or data-mutating tool (replaces the unfalsifiable "no path exists" phrasing; the acceptance criterion below is verified by this audit).
- REQ-011: The console embed's auth handoff is an explicitly designed contract with honua-console ownership: console today fails closed behind a per-operator BFF for mutations, and embedding browser-direct SDK calls changes that threat model — the design (BFF-mediated vs scoped browser bearer) is a Phase 0/1 deliverable, not an implementation detail. Phases 0–1 run admin-only by declaration (server authz widening lands Phase 2, honua-server#3001, which must also cover MCP operator grants for non-admin users).
- NFR-001: Deterministic CI: all agent journeys run model-free via fixture conversations; live-model runs are a separate non-gating evidence lane.
- NFR-002: Interaction latency budgets for the perceive→compose→render loop and for embed boot inside console — numeric budgets are set in honua-studio#3 before Phase 1 starts and enforced in CI on qualification hardware (unquantified budgets are unenforceable).
- NFR-003: Accessibility (AA contrast, keyboard-first including the command palette) and dark/light theming in both shells.

## Acceptance Criteria

- [ ] The same composition + lifecycle journeys pass in the standalone shell, the bare embed harness, and the console embed.
- [ ] A console-authored package opens and re-saves losslessly in Studio, and vice versa, for every family Studio edits.
- [ ] Two-provider BYOM journey passes with config-only changes; no-model fixture journey is byte-stable.
- [ ] An external MCP client drives a composition with the same tools and guarantees.
- [ ] A GP package authored in conversation dry-runs, batch-executes, and lands its outputs as usable layers.
- [ ] Console retires map/query/dashboard Blazor editors behind passed parity gates; ADR merged.
- [ ] The Hawaii flagship presentation (honua-sdk-js#776) performs the live vibe-coding session end to end, including one live revert of an AI-proposed change.
- [ ] The CI tool-surface audit (REQ-010) passes: every agent-reachable tool enumerated and classified read-only or config-plane; publish/share/embed are human-gated (REQ-009).

## Dependencies

- honua-server: #2999 (live co-editing endpoints), #3000 (AI proxy adapters — note: the Bedrock prior art is one-shot document generation, so this is effectively greenfield on Phase 1's critical path), #3001 (authz widening INCLUDING MCP operator grants for end users); NEW issues from adversarial review: server-side composition/lifecycle MCP tools (AD-8), lifecycle enumeration endpoints, forms/analysis persistence unification; existing Studio lifecycle API (#1180), Content Publication Registry API, and `/mcp` surface (MCP protocol + honua-io's published geospatial-mcp schemas).
- honua-sdk-js: #780 (lifecycle client); agent-tools/app-controller stability; web-components registry discipline.
- honua-console: #324 (embed + retirement); console session/token handoff design.
- agent-delivery-spec: reconcile `ai-spatial-app-builder-and-query-studio`.

## Risks and Mitigations

- **R-1 Embed friction (Blazor ↔ custom elements: routing, focus, session).** Mitigate with the bare embed harness in Phase 0 (#5) so integration risk is discovered before console work starts; keep the element contract minimal.
- **R-2 Package-family round-trip is harder than it looks** (console mock lifecycle may have divergent shapes). Mitigate: round-trip fixtures begin in Phase 2 against *server-produced* packages, not console-mock output; console's converging editors adopt the same server truth.
- **R-3 Server authz widening is a prerequisite for any non-admin user.** Sequence #3001 early in Phase 2; flag-gated to protect existing admin flows.
- **R-4 Model variance breaks demos/CI.** Fixture-conversation mode is the gate; live models are evidence-only (NFR-001).
- **R-5 Scope gravity from the Hawaii epic.** The flagship consumes Studio; it must not drive Studio's internal scope. Phase boundaries and the epic's own REQ list are the firewall.
- **R-6 Two-shell drift.** Prevented structurally: shared element contract, shared journey suites parameterized over hosts (REQ-001, epic #2 validation).

## Validation

- Shared browser journey suites parameterized over standalone shell, embed harness, and console host.
- Snapshot suites over activity logs and composition state; reducer property tests.
- Round-trip fixture suites per package family; lifecycle conformance against the server API doc's endpoint table.
- MCP contract tests against the geospatial-mcp standard; external-client parity test.
- BYOM matrix evidence; audit-log assertions on the AI proxy.
- Parity-ledger CI check in console; artifact-size and embed boot-time budgets.
