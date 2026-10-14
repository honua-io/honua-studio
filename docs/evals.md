# The composition-loop eval corpus

honua-studio#46 asks a question the rest of the test suite cannot: *how well
does a model drive the composition loop?* Playwright journeys prove the app
works when the tool calls are already correct; unit tests prove each module
works in isolation. Neither says anything about whether an instruction like
"add the parcels layer and style it by district" produces the right map.

The corpus (`src/evals/`) measures those scenarios through deterministic fixture
tasks and a separately versioned exact live contract. Both use the same typed
structural scorer; the live contract declares requested identities before execution.

```bash
npm test                      # the corpus runs in the default PR-safe suite
npx vitest run test/evals     # just the corpus and its scorer
```

## What an eval task is

An `EvalTask` (`src/evals/types.ts`) is an NL instruction — or a short
conversation — plus a **typed expected composition state**. Nothing about the
scoring is textual: the assistant's prose is recorded in the transcript and
never compared, and there is no whole-state snapshot anywhere. Every
assertion addresses a named field of the composition/activity-log contract, so
a failure reads:

```
task "compose-districts-map" via driver "fixture": 11/12 checks passed
  FAIL state.layers[hi-parcels].styleRef.styleId: expected "district", got "zoning"
```

A task has:

| Field | What it is |
| --- | --- |
| `id`, `title`, `capabilities`, `rationale` | Identity, and what part of the composition surface the task covers. |
| `setup` | Typed `CompositionCommand`s applied before the first turn (a pinned layer, an already-composed map). Not scored, not logged. |
| `turns` | Either an `instruction` turn (the NL ask, plus — for the fixture lane — the scripted assistant reply) or a `user-action` turn (`undo`/`redo`, which no tool call can express). |
| `fixtureConversation` | Optional: replay a real `src/chat/fixtures/*.json` conversation instead of scripting the replies inline. |
| `expected` | The typed expectations — see below. |
| `knownBad` | Deliberately miscomposed transcripts the scorer MUST fail on. |

### Expectations

`expected.state` asserts over `CompositionState`. Every collection —
`layers`, `widgets`, `controls`, `interactions`, `annotations` — takes the
same three-part shape:

- `present` — entries that must exist, matched by `id`. Each field the
  expectation names is checked; fields it omits are not, which is what keeps
  the corpus fair to a live model that phrases a title differently.
- `absent` — ids that must NOT exist.
- `ids` — the exact, **ordered** id list of the whole collection (order is
  meaningful data: layer stacking, widget order).

`pins` are asserted by their stable target keys (`layer:flood-risk`), and
`view` comparisons carry a tolerance — `tolerance` for zoom/pitch/bearing,
`centerTolerance` (degrees) for `center`/`bbox` — because "zoom to Honolulu"
has no single right camera and an eval that demands bitwise equality of a
camera position measures luck.

`expected.activityLog` asserts over the replayable audit trail: `counts` per
entry type, `absentTypes` (proving something never happened — e.g. no
`lifecycle_action` for a publish request), `sequence` (an ordered subsequence
of entry types), and `present` entries matched by type plus a subset of their
`detail`. Scoring the log, not just the end state, is how the corpus tells
"composed the right map" from "composed the right map by way of four rejected
commands".

## The tasks

| Task | Covers |
| --- | --- |
| `compose-districts-map` | Add a layer, style it, then chart it — replayed from `src/chat/fixtures/compose-districts-map.json`. |
| `zoom-to-honolulu` | Viewport change, scored with tolerance. |
| `add-then-remove-widgets` | Widget add across two vocabularies, then removal of the right one. |
| `bind-year-built-filter` | A control plus an ADR-0030 interaction binding, scored arm by arm (`on.ref`, `on.event`, `do.ref`, `do.verb`, `args`). |
| `hide-parcels-keeps-layer` | Visibility — hidden, not removed. |
| `pin-protects-flood-risk` | Pinning: the unpinned layer is restyled, the pinned one is refused, and the refusal is logged. |
| `undo-restores-previous-state` | Undo as a user action, reverting exactly one revision. |
| `publish-stays-behind-human-gate` | Asked to publish, the assistant proposes: no composition mutation, no lifecycle action, no invented tool. |

## How a task is scored

`runEvalTask` plays the task through the *real* loop and `scoreEvalRun`
compares the result:

```
instruction ──> driver ──> StudioAiChatEvent stream
                              │  toolCallStop
                              ▼
                    ToolCallOrchestrator ──> tool-bridge ──> reducer
                              │                                │
                              ▼                                ▼
                        ActivityLog                    CompositionState
                              └──────────► scoreEvalRun ◄──────┘
```

The runner owns no composition logic: it mirrors `<honua-studio-chat>`'s own
turn loop (same activity-log entry types, in the same order) and hands every
tool call to the app's `ToolCallOrchestrator`. So a corpus failure is a
failure of the composition loop or of the model turn — never of a parallel
implementation written for the harness. It is pure Node, so the corpus runs in
the default Vitest suite with no browser.

### The one check a task cannot opt out of

Every instruction turn must reach a successful terminal event — a
`messageStop`, with no `error` event anywhere in the stream — and
`scoreEvalRun` scores that unconditionally, at `turns[<n>].completed`,
whatever the task declared. A live turn can apply exactly the right tool
calls and then die on a provider error or a truncated stream; the composition
left behind would satisfy a state-only expectation while the user is looking
at a broken turn. Scoring that as a pass would overstate model quality in
precisely the case the corpus exists to catch.

The runner also keeps the conversation transcript causally ordered: a turn's
assistant message is appended to `history` *before* the `{ role: "tool" }`
results it produced (`user -> assistant -> tool -> …`), and text the model
emits after its tool results becomes a second assistant message. A later turn
is therefore generated from a history a live provider will accept.

## Adding a task

1. Add an `EvalTask` to `src/evals/corpus.ts` and list it in `EVAL_CORPUS`.
2. Write the instruction as a user would say it — not as a tool call in prose.
3. Script the fixture reply's `toolCalls` using whichever vocabulary you want
   covered: this engine's camelCase commands, the snake_case chat-fixture
   names, or honua-server's `honua_studio_*` names. All three resolve through
   `src/mcp/tool-bridge.ts`.
4. State the expectations, naming only what the task actually cares about.
5. Add at least one `knownBad` variant with the check `path`s it must break.
   `test/evals/corpus.test.ts` enforces both halves: the good transcript must
   score clean, and each bad one must fail at exactly the paths it names.

## The known-good / known-bad gate (REQ-003)

Fixture-conversation mode is the PR-safe floor *and* the gate for the corpus
itself. `test/evals/corpus.test.ts` runs, in the default suite:

- every task against its known-good transcript — zero failing checks;
- every `knownBad` variant — the run MUST fail, and the failing check paths
  must include the ones the variant declares.

That second half is the induced-regression test #46's Validation section asks
for: a scorer that cannot catch a wrong composition measures nothing.

## The live-model driver

Everything above is lane-agnostic except one interface, `EvalTurnDriver`
(`src/evals/driver.ts`):

```ts
export interface EvalTurnDriver {
  readonly id: string;                 // recorded on every score: "fixture", "live:claude-sonnet-4-5", …
  readonly kind: "fixture" | "live";
  beginTask?(task: EvalTask): void | Promise<void>;   // live: create the disposable draft
  endTask?(task: EvalTask): void | Promise<void>;     // live: delete it
  reportToolResult?(result: EvalToolResult): void | Promise<void>;
  runTurn(context: EvalTurnContext): AsyncIterable<StudioAiChatEvent>;
}
```

`LiveTurnDriver` wraps `StudioAgentSession`: tools are discovered from the
real server, and model-selected calls enter the shared runner only after the
SDK verifies the signed transcript. Each call executes once through Studio's
real orchestrator. The resulting server draft is returned to the SDK and then
to the model. Raw provider events are retained as evidence, never forwarded to
the bridge before verification. Tests require a valid signature to mutate a
draft exactly once and a tampered signature to leave it untouched.

Set `HONUA_CORPUS_MODEL`, `HONUA_CORPUS_PROVIDER`, and
`HONUA_CORPUS_SIGNING_MANIFEST` for this mode. The manifest file must contain
trusted signing keys or the authenticated AI capabilities response. The runner
creates and deletes a separate draft per scenario. If bearer authentication is
required, `HONUA_CORPUS_AUTH_MODULE` names a local module exporting async
`getAccessToken()`; it is called for every HTTP request and its output is never
recorded. An API key is optional when that provider is configured.

Model mode records actual signed events and model/tool messages beside exact
local scores and independently fetched server-state scores. Its contract is
`honua.studio.live-exact-contract.v1`: instructions explicitly request stable
component IDs, exact configured source/style identities, and executable control
configuration before any turn runs. Activity expectations name the real native
MCP tools. No expectation is learned from model outputs, and no recorded name,
ID, event, or signature is normalized for scoring.

The four adapted scenarios are district composition/charting, adding/removing
widgets, year-built filtering, and pin protection. The pin scenario explicitly
requests attempted styling while retaining pins: exactly one native call must
target `flood-risk` and be rejected for its pin. A generic failure is insufficient.
The slider requires executable `args.field`, not the obsolete fixture-only
`args.attribute`. Existing deterministic tasks and `scorer.ts` remain unchanged.
Their scores against each new live run are retained separately in
`fixtureComparison`; these are comparisons, not a rerun of the historical task.
Historical 4/8 receipts remain immutable and are not directly comparable to the
new explicitly constrained instructions.

Model mode requires trusted source descriptors for `hi-parcels`, `hi-districts`,
`src-flood-risk`, and `src-dev-pressure`. Before model execution, same-origin
MCP descriptions bind opaque service identities to advertised service-name paths;
FeatureServer metadata must match those locators and the required parcel field
types. Both canonical `locator` descriptors and historical top-level descriptors
are supported. Canonical catalogs may omit fields; when configured fields are
supplied they must match metadata exactly. The
sample fixture's `hi-parcels/0` identity is not substituted for a live alias.
Both style-requirement entries (`compose-districts-map` and
`pin-protects-flood-risk`) must include an explicit `styleId` as well as their
existing source, server, classification/palette, and description requirements.
The real style provider must resolve those configured definitions before a turn.
The browser observer independently verifies their hashes, source bindings,
rendered properties, and actual rendered features; invented style IDs cannot pass.

Live runs also retain `liveSemanticScore` (`honua.studio.live-semantic-score.v1`).
Every turn has an independent server readback: the legend must be observed before
removal, and undo must restore the server composition. Unique roles, component
configuration, unrelated state, pins, annotations, and lifecycle boundaries remain
checked. Local-only changes, absent readbacks, incomplete/provider-error turns,
lifecycle writes, and unconfirmed cleanup fail independently. A scenario passes
only when exact local and remote scores, live semantics including style evidence,
and owned-draft cleanup all pass. Missing prerequisites never count as success.

The scheduled credentialed lane and formally validated scorecard aggregation in
#46 remain follow-up work. This diagnostic is not release or NativeAOT qualification.

The diagnostic's `VerifiedRoundTransport` additionally verifies action-free
terminal text using the same trusted SDK verifier, exact request, and complete
event sequence. SDK 0.2.2 itself verifies action rounds before dispatch; the
wrapper leaves those replay nonces for the SDK to consume once. Incomplete or
malformed tool rounds cannot fall through as successful text. Tampered text,
missing provenance, truncation, and replay are negative controls; provider
errors still fail completion even when an earlier mutation succeeded. This
extra text verification is a diagnostic requirement, not a claim that the
published SDK verifies text-only rounds by itself.

## Scripted corpus against an owned server

`npm run evals:server` runs the eight existing tasks through Studio's MCP
orchestrator against an **owned disposable loopback honua-server**. Set
`HONUA_CORPUS_BASE_URL` to the server origin and `HONUA_CORPUS_API_KEY` to its
admin key. `HONUA_CORPUS_OUTPUT` optionally selects the output directory
(default `.tmp/server-corpus`). This command fails when configuration is absent,
when any scenario fails, or when cleanup cannot be proved.

The server origin supplies `/mcp`; REST cleanup and AI requests use
`/api/v1/studio/...` on the actual server. `HONUA_CORPUS_API_BASE_URL` can override
the default `${HONUA_CORPUS_BASE_URL}/api` for a same-origin proxy deployment.
The fixture Vite proxy's prefix rewrite is not the direct server route contract.

The runner creates a separate draft per task, seeds its setup through
`honua_studio_create_draft`, independently reads it back, executes the scripted
intents through the real tool bridge, and scores both the local projection and a
fresh `honua_studio_get_draft` result. It deletes each owned draft and requires a
404 readback. It never publishes. Pins and annotations remain explicitly local;
server readback cannot inherit missing controls or interactions from the local
projection. The fixture's one local dispatch expectation becomes a server
expectation in this lane. Other expected state and activity assertions remain
unchanged. Local-only undo is therefore a failure if the server draft does not
follow it.

`scorecard.json` records each typed score, request/response transcript, setup and
final draft, cleanup, and source identity. `scorecard.html` summarizes the same
results. Authentication headers are not recorded. A passing run proves scripted
MCP/tooling behavior, **not live-model quality, rendered map fidelity, or release
qualification**. The scheduled scorecard required by #46 remains follow-up work.

The SDK 0.2.2 live agent rejects model-selected tool calls without verified signed
transcripts. Hosts can call
`app.configureAgentTranscriptVerification(binding, trustedSigningManifest)` to
configure the SDK verifier, or inject their own verifier via `agentCertification`.
The manifest must come from the host's authenticated, trusted server identity.
The preview mock signs with an ephemeral fixture-only Ed25519 key; it is never a
production trust source or proof of a hosted model.


The owned browser observer also inspects actual chart/table cards on each observed
data-widget turn. It records SVG mark values, chart summaries, grid row counts and
cell values; missing, loading, empty or failed data cards do not qualify as
rendered data in this nonempty synthetic corpus. Visible card failures now fail
the supplemental browser-observation check even if console errors are empty.
These observations supplement authoritative state checks; they do not rewrite
historical scorecards or change the strict fixture scorer. The observer binds each data widget to its exact successful query in the current
browser run and compares rendered chart values, table headers and cells to values
derived from that FeatureCollection through the frozen production rendering
contracts. It refuses ambiguous changed responses, records source-module hashes,
and captures visibly sized SVG/table elements after scrolling into view. This
proves consistency with actual returned data; desired-source/field semantics are
still checked separately, and a shared aggregation implementation is not an
independent oracle for defects in that implementation.

### Runtime contract corrections in live semantics

The supplemental live scorer uses the production chart parser, so supported aliases
such as `categoryField` retain their actual grouping meaning. It still checks the
source, bar encoding, count measure and component multiplicity. Numeric filter
controls may use Studio's intrinsic own-source filtering without a redundant
interaction. If an explicit interaction is authored, its field, event value,
operator and target must match executable SDK grammar; `attribute` alone clears
rather than installs the SDK target filter. Unit regressions exercise the installed
SDK compiler and actual Studio interaction runtime, including own-source gestures.

These corrections affect newly produced live semantic scores. They do not rewrite
historical receipts or change the strict fixture scorer/corpus. Structural readback
checks and runtime unit regressions are not claims that an earlier live browser run
operated a slider. Browser gesture evidence must be recorded separately when claimed.

Style prerequisites are scoped to the live task that uses them: the district
composition requires only its district style, and pin protection requires only
its council style. A missing or unreadable style fails that styling task; the
other six tasks neither require nor fetch those unrelated style definitions.

Source-catalog admission is intentionally corpus-wide: every model turn receives
exactly the same four predeclared, unique source aliases; extra or unexpected
entries are refused before any network/model call. All four advertised identities
and their metadata must be verified before any turn. A source preflight failure
is a diagnostic setup failure, not evidence of model capability. Style context,
in contrast, contains only the verified definition required by the current task.
