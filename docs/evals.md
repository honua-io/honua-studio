# The composition-loop eval corpus

honua-studio#46 asks a question the rest of the test suite cannot: *how well
does a model drive the composition loop?* Playwright journeys prove the app
works when the tool calls are already correct; unit tests prove each module
works in isolation. Neither says anything about whether an instruction like
"add the parcels layer and style it by district" produces the right map.

The corpus (`src/evals/`) is that measurement, and it is built so the same
tasks score a scripted fixture transcript today and a live model turn after
honua-studio#40 lands.

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

## The live-model lane (blocked on honua-studio#40)

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

The seam yields the *wire* event type rather than resolved tool calls, because
that is exactly what both `FixtureChatTransport` and the live SSE transport
emit — so the live lane needs no translation shim. `runTurn` receives the
instruction, the conversation history, and the composition state at the start
of the turn (what a live driver summarizes into its system prompt), and
`reportToolResult` hands each executed tool call's outcome back, which is what
an agent loop must feed the model as the next `{ role: "tool" }` message
before it continues generating. `test/evals/runner.test.ts` exercises that
round trip with a fake agent driver whose second tool call depends on the
first one's result.

What is still missing is the model turn itself: `<honua-studio-chat>` does not
yet declare tools to the proxy or feed results back
([#40](https://github.com/honua-io/honua-studio/issues/40)). Once it does, a
`LiveTurnDriver` wrapping `StudioAgentSession` — creating and deleting a
disposable draft in `beginTask`/`endTask`, per #46's "no shared mutable state
between tasks" — drops into the same runner, scored by the same expectations
against the same corpus. Nothing in `types.ts`, `runner.ts`, `scorer.ts`, or
`corpus.ts` changes. The scheduled credentialed lane and the schema-validated
scorecard artifact (#46 REQ-002) follow from there, and `formatEvalScore` /
`EvalScore` are already the shape a scorecard serializes.
