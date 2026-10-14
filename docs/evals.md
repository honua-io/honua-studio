# The composition-loop eval corpus

honua-studio#46 asks a question the rest of the test suite cannot: *how well
does a model drive the composition loop?* Playwright journeys prove the app
works when the tool calls are already correct; unit tests prove each module
works in isolation. Neither says anything about whether an instruction like
"add the parcels layer and style it by district" produces the right map.

The corpus (`src/evals/`) is that measurement, and it is built so the same
tasks score both scripted fixture transcripts and verified live model turns.

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

Model mode records the actual signed events and model/tool messages beside the
same typed scores and independently fetched server state. It retains the
corpus's strict activity assertions; different valid model plans can therefore
fail a fixture-specific count or tool-name assertion even when state matches.
Inspect the named failures rather than treating every failed check as a model
capability failure. The scheduled credentialed lane and formally validated
scorecard artifact in #46 remain follow-up work.

Live runs also report `liveSemanticScore` (`honua.studio.live-semantic-score.v1`)
beside the unchanged strict scores. This separate profile covers the existing
eight tasks. New component IDs may differ from fixture IDs, but each required
role must match exactly one component by kind, source, and required config;
duplicate roles, wrong sources, wrong chart fields, and extra components fail.
Interaction references must resolve to the observed slider ID and the actual
seeded parcels layer, with the requested field and event value. Existing layer
identities, unrelated state, pins, and annotations remain protected.

Every turn has an independent server readback. Thus adding then removing a
legend requires observing the legend before its removal, and undo requires
observing the chart before the server returns to its initial composition.
Local-only changes, absent readbacks, unsuccessful turns, lifecycle writes,
and unconfirmed cleanup fail independently of the final component match.
Negative controls cover each boundary; valid renamed IDs are a positive
control while their original strict score remains a failure.

The two styling scenarios currently report `prerequisite-unmet` when all their
other checks pass: this runner has no authoritative style-definition provider.
An invented `district` or `presentation` reference does not prove the requested
attribute or palette. Missing style evidence never counts as a pass. The HTML
report displays strict and semantic results separately; the CLI exits nonzero
on a strict failure, semantic failure, or unmet prerequisite. Historical raw
receipts and scores are not rewritten.

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
