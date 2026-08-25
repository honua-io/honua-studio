/**
 * The eval corpus format (honua-studio#46 REQ-001): an NL instruction plus a
 * TYPED expectation over the composition/activity-log contract.
 *
 * Scoring is deliberately *structural*, never textual: an expectation names
 * layers, styles, widgets, controls, interactions, the view, pins, and
 * activity-log entries by id/kind/value, and `scorer.ts` turns each one into
 * an individually-reported {@link EvalCheck}. There is no string-similarity
 * scoring and no whole-state snapshot blob anywhere in this module — a
 * failing corpus run must be able to say *which* field of *which* entity was
 * wrong, which a snapshot diff of a 200-line JSON document cannot.
 *
 * ## What an eval task is made of
 *
 *  - `turns` — the model-facing half: the NL instruction(s), plus (for the
 *    fixture lane) the scripted assistant response that stands in for a real
 *    model turn. A turn may also be a pure user action (`undo`/`redo`), so
 *    the corpus can score behavior that is *not* a tool call.
 *  - `setup` — typed composition commands applied before the first turn, to
 *    put a task in a starting state (e.g. a pinned layer) without spending a
 *    conversation turn on it. Setup never appears in the scored activity log.
 *  - `expected` — the typed assertions, see {@link EvalExpectation}.
 *  - `knownBad` — deliberately miscomposed variants of the same task, used by
 *    REQ-003's known-good/known-bad gate: the corpus runner must FAIL on
 *    these, and fail at the named paths, or the scorer is not actually
 *    measuring anything.
 *
 * The transcript for a turn comes from a driver (`driver.ts`) — fixtures
 * today, a live model session after honua-studio#40. See `docs/evals.md`.
 *
 * @module
 */

import type { ActivityLogEntryType } from "../chat/activity-log.js";
import type { StudioAiStopReason } from "../chat/ai-contract.js";
import type { FixtureConversation } from "../chat/fixture-conversation.js";
import type { CompositionCommand } from "../composition/commands.js";
import type {
  CompositionAnnotationKind,
  CompositionControlKind,
  CompositionInteractionEvent,
  CompositionInteractionVerb,
  CompositionWidgetKind,
} from "../composition/model.js";
import type { CompositionToolCall } from "../composition/tool-call.js";

// ---------------------------------------------------------------------------
// Task shape
// ---------------------------------------------------------------------------

/**
 * What a task exercises. Purely descriptive — used to report coverage of the
 * composition surface in a scorecard, and to `--grep` a subset of the corpus.
 */
export type EvalCapability =
  | "layer"
  | "style"
  | "view"
  | "widget"
  | "control"
  | "interaction"
  | "visibility"
  | "pinning"
  | "undo"
  | "lifecycle";

/** One scripted assistant turn for the fixture lane — the stand-in for a real model's reply. */
export interface FixtureAssistantScript {
  /** Assistant prose. Never scored (that would be string similarity); present so the transcript reads like a real turn. */
  readonly text?: string;
  readonly toolCalls?: readonly CompositionToolCall[];
  /** Defaults to `"toolCall"` when the script has tool calls, `"endTurn"` otherwise. */
  readonly stopReason?: StudioAiStopReason;
}

/** An NL instruction turn: what the user says, and (fixture lane) what the assistant does about it. */
export interface EvalInstructionTurn {
  readonly kind: "instruction";
  readonly instruction: string;
  /**
   * The fixture lane's scripted reply. Optional only when the task supplies a
   * whole {@link EvalTask.fixtureConversation}; when both are present this
   * wins (that precedence is what lets a known-bad variant override one turn
   * of an otherwise-real fixture conversation).
   */
  readonly assistant?: FixtureAssistantScript;
}

/**
 * A user action that is not a message: the undo/redo affordance
 * `CompositionController` exposes and `<honua-studio-canvas>` surfaces. It is
 * in the corpus because "the model added a widget and the user took it back"
 * is a composition-loop behavior with a typed expected state, and no tool
 * call can express it — undo is deliberately not part of the closed command
 * vocabulary (`../composition/commands.ts`).
 */
export interface EvalUserActionTurn {
  readonly kind: "user-action";
  readonly action: "undo" | "redo";
}

export type EvalTurn = EvalInstructionTurn | EvalUserActionTurn;

/** A deliberately miscomposed variant of a task — REQ-003's known-bad half. */
export interface EvalKnownBadVariant {
  readonly id: string;
  /** Why this variant is wrong, in one line — quoted in the gate test's failure output. */
  readonly description: string;
  /** Assistant scripts that replace the task's own, by turn index. */
  readonly turns: readonly { readonly turnIndex: number; readonly assistant: FixtureAssistantScript }[];
  /**
   * The check paths (see {@link EvalCheck.path}) this variant must make fail.
   * Asserting the *paths*, not merely "something failed", is what proves the
   * scorer caught the intended defect rather than an unrelated one.
   */
  readonly expectFailingPaths: readonly string[];
}

/** One eval task: an instruction (or short conversation) plus a typed expected composition state. */
export interface EvalTask {
  readonly id: string;
  readonly title: string;
  readonly capabilities: readonly EvalCapability[];
  /** Why this task is in the corpus and what a wrong answer looks like. */
  readonly rationale?: string;
  /** Typed commands applied before the first turn. Not scored, not logged. */
  readonly setup?: readonly CompositionCommand[];
  readonly turns: readonly EvalTurn[];
  /**
   * Fixture-lane transcript source for tasks replayed from a real
   * `src/chat/fixtures/*.json` conversation: the driver plays turn *i* of
   * this conversation for instruction turn *i*. Per-turn `assistant` scripts
   * take precedence.
   */
  readonly fixtureConversation?: FixtureConversation;
  readonly expected: EvalExpectation;
  readonly knownBad: readonly EvalKnownBadVariant[];
}

// ---------------------------------------------------------------------------
// Typed expectations
// ---------------------------------------------------------------------------

/**
 * The uniform shape every composition collection is asserted with.
 *
 *  - `present` — entries that must exist, matched by `id`; every field the
 *    expectation names is checked, fields it omits are not.
 *  - `absent` — ids that must NOT exist.
 *  - `ids` — the exact, ordered id list of the whole collection. Order is
 *    meaningful data in composition state (layer stacking, widget order), so
 *    this is an ordered comparison, not a set comparison.
 */
export interface ExpectedCollection<TEntry> {
  readonly present?: readonly TEntry[];
  readonly absent?: readonly string[];
  readonly ids?: readonly string[];
}

export interface ExpectedLayer {
  readonly id: string;
  readonly sourceId?: string;
  readonly title?: string;
  readonly visible?: boolean;
  /** The style ref's `styleId`. `null` asserts the layer carries NO style ref at all. */
  readonly styleId?: string | null;
  readonly styleVersion?: string;
}

export interface ExpectedWidget {
  readonly id: string;
  readonly kind?: CompositionWidgetKind;
  readonly sourceId?: string;
  /** Checked as a subset: every key named here must match; unnamed keys are ignored. */
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface ExpectedControl {
  readonly id: string;
  readonly kind?: CompositionControlKind;
  readonly sourceId?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface ExpectedInteraction {
  readonly id: string;
  readonly on?: { readonly ref?: string; readonly event?: CompositionInteractionEvent };
  readonly do?: {
    readonly ref?: string;
    readonly verb?: CompositionInteractionVerb;
    readonly args?: Readonly<Record<string, unknown>>;
  };
  readonly disabled?: boolean;
}

export interface ExpectedAnnotation {
  readonly id: string;
  readonly kind?: CompositionAnnotationKind;
  readonly label?: string;
  readonly text?: string;
}

/**
 * View expectations. Numeric comparisons use `tolerance` (default
 * {@link DEFAULT_VIEW_TOLERANCE}) — a live model asked to "zoom to Honolulu"
 * will not return the fixture's exact zoom, and an eval that demands bitwise
 * equality of a camera position measures luck, not quality.
 */
export interface ExpectedView {
  readonly bbox?: readonly [number, number, number, number];
  readonly center?: readonly [number, number];
  readonly zoom?: number;
  readonly pitch?: number;
  readonly bearing?: number;
  /** Slack for scalar comparisons (zoom/pitch/bearing). Default {@link DEFAULT_VIEW_TOLERANCE}. */
  readonly tolerance?: number;
  /** Slack, in degrees, for `center`/`bbox` coordinates. Defaults to `tolerance`. */
  readonly centerTolerance?: number;
  /** View fields that must be unset (`undefined`) — e.g. "the model must not have moved the camera". */
  readonly unset?: readonly ("bbox" | "center" | "zoom" | "pitch" | "bearing")[];
}

/** Pins are targets, not entities: asserted by their stable `compositionTargetKey` string (`layer:flood-risk`). */
export interface ExpectedPins {
  readonly present?: readonly string[];
  readonly absent?: readonly string[];
  /** The exact, ordered pin-key list. */
  readonly keys?: readonly string[];
}

export interface ExpectedCompositionState {
  readonly layers?: ExpectedCollection<ExpectedLayer>;
  readonly widgets?: ExpectedCollection<ExpectedWidget>;
  readonly controls?: ExpectedCollection<ExpectedControl>;
  readonly interactions?: ExpectedCollection<ExpectedInteraction>;
  readonly annotations?: ExpectedCollection<ExpectedAnnotation>;
  readonly pins?: ExpectedPins;
  readonly view?: ExpectedView;
}

export interface ExpectedActivityLogEntry {
  readonly type: ActivityLogEntryType;
  /** A subset of the entry's `detail`: every key named here must deep-match; unnamed keys are ignored. */
  readonly detail?: Readonly<Record<string, unknown>>;
  /** Exact number of matching entries. Omitted means "at least one". */
  readonly count?: number;
}

/**
 * Activity-log expectations — the *replayable audit trail* half of the
 * contract (honua-studio#6). Scoring the log, not only the end state, is how
 * the corpus can tell "composed the right map" from "composed the right map
 * by way of four rejected commands".
 */
export interface ExpectedActivityLog {
  /** Entry types that must occur in this relative order. A subsequence match — unrelated entries may fall between them. */
  readonly sequence?: readonly ActivityLogEntryType[];
  /** Exact entry counts per type. */
  readonly counts?: Readonly<Partial<Record<ActivityLogEntryType, number>>>;
  readonly present?: readonly ExpectedActivityLogEntry[];
  /** Types that must never appear — e.g. `lifecycle_action` for a task whose whole point is that publishing stays behind a human gate. */
  readonly absentTypes?: readonly ActivityLogEntryType[];
}

export interface EvalExpectation {
  readonly state?: ExpectedCompositionState;
  readonly activityLog?: ExpectedActivityLog;
}

/** Default numeric slack for view comparisons — see {@link ExpectedView}. */
export const DEFAULT_VIEW_TOLERANCE = 1e-6;

// ---------------------------------------------------------------------------
// Scoring output
// ---------------------------------------------------------------------------

export type EvalCheckStatus = "pass" | "fail";

/**
 * One typed assertion and its outcome. `path` is the addressable location in
 * the contract (`layers[hi-parcels].styleRef.styleId`,
 * `activityLog.counts.composition_command_rejected`) — stable enough for a
 * known-bad variant to name it, and specific enough that a failure explains
 * itself without a diff tool.
 */
export interface EvalCheck {
  readonly id: string;
  readonly path: string;
  readonly status: EvalCheckStatus;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly message: string;
}

export interface EvalScore {
  readonly taskId: string;
  readonly driverId: string;
  readonly passed: boolean;
  readonly checks: readonly EvalCheck[];
  readonly failures: readonly EvalCheck[];
  readonly passedCount: number;
  readonly totalCount: number;
}
