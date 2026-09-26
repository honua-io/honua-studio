/**
 * The scorer (honua-studio#46 REQ-001): turns an {@link EvalExpectation} plus
 * an {@link EvalRunResult} into a list of individually-reported
 * {@link EvalCheck}s.
 *
 * Two rules shape everything here.
 *
 *  1. **Typed, structural comparisons only.** Every check addresses a named
 *     field of the composition/activity-log contract — a layer's
 *     `styleRef.styleId`, a widget's `kind`, the view's `zoom`, the count of
 *     `composition_command_rejected` entries. There is no string-similarity
 *     scoring of assistant prose anywhere: assistant text is recorded in the
 *     transcript and never compared.
 *  2. **A failure must explain itself.** No check is a whole-state snapshot
 *     comparison; each carries its own `path`, `expected`, and `actual`, so
 *     the report says "state.layers[hi-parcels].styleRef.styleId: expected
 *     \"district\", got \"zoning\"" rather than handing back two JSON blobs
 *     and a diff. This is also what lets a known-bad variant assert *which*
 *     check it broke ({@link EvalKnownBadVariant.expectFailingPaths}).
 *
 * Expectations are partial by design: a field an expectation does not name is
 * not checked. What a task wants to pin down, it says; what it leaves open
 * (a title the model may phrase freely, a config key it may or may not set)
 * stays open, which is what keeps the same corpus usable against a live model
 * after honua-studio#40.
 *
 * The one exception is {@link scoreTurnCompletion}: every instruction turn
 * must reach a successful terminal event, scored unconditionally, because a
 * turn that errored mid-stream is a failed turn no matter how good the
 * composition it left behind looks.
 *
 * @module
 */

import type { ActivityLogEntry, ActivityLogEntryType } from "../chat/activity-log.js";
import type {
  CompositionAnnotation,
  CompositionControl,
  CompositionInteraction,
  CompositionLayer,
  CompositionState,
  CompositionView,
  CompositionWidget,
} from "../composition/model.js";
import { canonicalCompositionJson, compositionTargetKey } from "../composition/model.js";
import type { EvalRunResult } from "./runner.js";
import {
  DEFAULT_VIEW_TOLERANCE,
  type EvalCheck,
  type EvalScore,
  type ExpectedActivityLog,
  type ExpectedAnnotation,
  type ExpectedCollection,
  type ExpectedCompositionState,
  type ExpectedControl,
  type ExpectedInteraction,
  type ExpectedLayer,
  type ExpectedView,
  type ExpectedWidget,
} from "./types.js";

/** Scores one completed run against its task's typed expectations. Pure — no I/O, no throwing. */
export function scoreEvalRun(run: EvalRunResult): EvalScore {
  const checks: EvalCheck[] = [];
  const { expected } = run.task;

  // Unconditional, whatever the task declares: a turn that errored or stopped
  // yielding did not answer the instruction, however good the composition it
  // happened to leave behind looks.
  scoreTurnCompletion(run, checks);

  if (expected.state) scoreCompositionState(run.state, expected.state, checks);
  if (expected.activityLog) scoreActivityLog(run.entries, expected.activityLog, checks);
  if (!expected.state && !expected.activityLog) {
    // An unscoreable task is an authoring bug, not a passing run.
    checks.push({
      id: "expectation.declared",
      path: "expected",
      status: "fail",
      expected: "at least one typed expectation",
      actual: expected,
      message: `task "${run.task.id}" declares no typed expectations — nothing was scored.`,
    });
  }

  const failures = checks.filter((check) => check.status === "fail");
  return {
    taskId: run.task.id,
    driverId: run.driverId,
    passed: failures.length === 0,
    checks,
    failures,
    passedCount: checks.length - failures.length,
    totalCount: checks.length,
  };
}

/** A one-line-per-failure report — what a test's assertion message and a scorecard artifact both print. */
export function formatEvalScore(score: EvalScore): string {
  const header = `task "${score.taskId}" via driver "${score.driverId}": ${score.passedCount}/${score.totalCount} checks passed`;
  if (score.passed) return header;
  const lines = score.failures.map((check) => `  FAIL ${check.path}: ${check.message}`);
  return [header, ...lines].join("\n");
}

/** Every failing check's path — the shape {@link EvalKnownBadVariant.expectFailingPaths} is compared against. */
export function failingPaths(score: EvalScore): readonly string[] {
  return score.failures.map((check) => check.path);
}

// ---------------------------------------------------------------------------
// Turn completion — always scored
// ---------------------------------------------------------------------------

/**
 * Every instruction turn must reach a successful terminal event: a
 * `messageStop`, with no `error` event anywhere in the stream.
 *
 * This check is deliberately NOT expressible as a task expectation and not
 * skippable by one. A live turn can apply exactly the right tool calls and
 * then fail — a provider error, a truncated stream, a cancelled request — and
 * the composition left behind would satisfy a state-only expectation while the
 * user is looking at a broken turn. Scoring that as a pass would overstate
 * model quality in precisely the case the corpus exists to catch.
 */
function scoreTurnCompletion(run: EvalRunResult, checks: EvalCheck[]): void {
  for (const turn of run.turns) {
    if (turn.kind !== "instruction") continue;
    const path = `turns[${turn.turnIndex}].completed`;
    if (turn.completed) {
      checks.push({
        id: "turn.completed",
        path,
        status: "pass",
        expected: true,
        actual: true,
        message: `assistant turn completed (stopReason: ${turn.stopReason ?? "unset"})`,
      });
      continue;
    }
    const actual = turn.errorMessage !== undefined ? `error: ${turn.errorMessage}` : "no terminal event";
    checks.push({
      id: "turn.completed",
      path,
      status: "fail",
      expected: "assistant turn completed (messageStop, no error)",
      actual,
      message:
        turn.errorMessage !== undefined
          ? `the assistant turn ended in an error event: ${turn.errorMessage}`
          : "the assistant turn never reached messageStop — the stream ended without a terminal event",
    });
  }
}

// ---------------------------------------------------------------------------
// Composition state
// ---------------------------------------------------------------------------

function scoreCompositionState(state: CompositionState, expected: ExpectedCompositionState, checks: EvalCheck[]): void {
  scoreCollection<CompositionLayer, ExpectedLayer>("state.layers", state.layers, expected.layers, compareLayer, checks);
  scoreCollection<CompositionWidget, ExpectedWidget>(
    "state.widgets",
    state.widgets,
    expected.widgets,
    compareWidget,
    checks,
  );
  scoreCollection<CompositionControl, ExpectedControl>(
    "state.controls",
    state.controls,
    expected.controls,
    compareControl,
    checks,
  );
  scoreCollection<CompositionInteraction, ExpectedInteraction>(
    "state.interactions",
    state.interactions,
    expected.interactions,
    compareInteraction,
    checks,
  );
  scoreCollection<CompositionAnnotation, ExpectedAnnotation>(
    "state.annotations",
    state.annotations,
    expected.annotations,
    compareAnnotation,
    checks,
  );

  if (expected.pins) {
    const keys = state.pins.map((pin) => compositionTargetKey(pin));
    if (expected.pins.keys) {
      checks.push(equality("state.pins.keys", "state.pins.keys", expected.pins.keys, keys));
    }
    for (const key of expected.pins.present ?? []) {
      checks.push(membership("state.pins.present", `state.pins[${key}]`, true, keys.includes(key), keys));
    }
    for (const key of expected.pins.absent ?? []) {
      checks.push(membership("state.pins.absent", `state.pins[${key}]`, false, keys.includes(key), keys));
    }
  }

  if (expected.view) scoreView(state.view, expected.view, checks);
}

function scoreCollection<TActual extends { readonly id: string }, TExpected extends { readonly id: string }>(
  label: string,
  actual: readonly TActual[],
  expectation: ExpectedCollection<TExpected> | undefined,
  compare: (expected: TExpected, entry: TActual, path: string, checks: EvalCheck[]) => void,
  checks: EvalCheck[],
): void {
  if (!expectation) return;
  const ids = actual.map((entry) => entry.id);

  if (expectation.ids) {
    // Ordered, not a set comparison: order is meaningful data in composition
    // state (layer stacking, widget order).
    checks.push(equality(`${label}.ids`, `${label}.ids`, expectation.ids, ids));
  }

  for (const expected of expectation.present ?? []) {
    const path = `${label}[${expected.id}]`;
    const entry = actual.find((candidate) => candidate.id === expected.id);
    if (!entry) {
      checks.push({
        id: `${label}.present`,
        path,
        status: "fail",
        expected: expected.id,
        actual: ids,
        message: `no entry with id "${expected.id}" — composed ids: ${json(ids)}`,
      });
      continue;
    }
    checks.push({
      id: `${label}.present`,
      path,
      status: "pass",
      expected: expected.id,
      actual: expected.id,
      message: "present",
    });
    compare(expected, entry, path, checks);
  }

  for (const id of expectation.absent ?? []) {
    checks.push(membership(`${label}.absent`, `${label}[${id}]`, false, ids.includes(id), ids));
  }
}

function compareLayer(expected: ExpectedLayer, layer: CompositionLayer, path: string, checks: EvalCheck[]): void {
  if (expected.sourceId !== undefined)
    checks.push(equality("layer.sourceId", `${path}.sourceId`, expected.sourceId, layer.sourceId));
  if (expected.title !== undefined) checks.push(equality("layer.title", `${path}.title`, expected.title, layer.title));
  if (expected.visible !== undefined)
    checks.push(equality("layer.visible", `${path}.visible`, expected.visible, layer.visible));
  if (expected.styleId !== undefined) {
    const actual = layer.styleRef?.styleId;
    checks.push(
      equality(
        "layer.styleId",
        `${path}.styleRef.styleId`,
        expected.styleId === null ? undefined : expected.styleId,
        actual,
      ),
    );
  }
  if (expected.styleVersion !== undefined) {
    checks.push(
      equality("layer.styleVersion", `${path}.styleRef.version`, expected.styleVersion, layer.styleRef?.version),
    );
  }
}

function compareWidget(expected: ExpectedWidget, widget: CompositionWidget, path: string, checks: EvalCheck[]): void {
  if (expected.kind !== undefined) checks.push(equality("widget.kind", `${path}.kind`, expected.kind, widget.kind));
  if (expected.sourceId !== undefined) {
    checks.push(equality("widget.sourceId", `${path}.sourceId`, expected.sourceId, widget.sourceId));
  }
  compareConfigSubset("widget.config", expected.config, widget.config, `${path}.config`, checks);
}

function compareControl(
  expected: ExpectedControl,
  control: CompositionControl,
  path: string,
  checks: EvalCheck[],
): void {
  if (expected.kind !== undefined) checks.push(equality("control.kind", `${path}.kind`, expected.kind, control.kind));
  if (expected.sourceId !== undefined) {
    checks.push(equality("control.sourceId", `${path}.sourceId`, expected.sourceId, control.sourceId));
  }
  compareConfigSubset("control.config", expected.config, control.config, `${path}.config`, checks);
}

function compareInteraction(
  expected: ExpectedInteraction,
  interaction: CompositionInteraction,
  path: string,
  checks: EvalCheck[],
): void {
  if (expected.on?.ref !== undefined) {
    checks.push(equality("interaction.on.ref", `${path}.on.ref`, expected.on.ref, interaction.on.ref));
  }
  if (expected.on?.event !== undefined) {
    checks.push(equality("interaction.on.event", `${path}.on.event`, expected.on.event, interaction.on.event));
  }
  if (expected.do?.ref !== undefined) {
    checks.push(equality("interaction.do.ref", `${path}.do.ref`, expected.do.ref, interaction.do.ref));
  }
  if (expected.do?.verb !== undefined) {
    checks.push(equality("interaction.do.verb", `${path}.do.verb`, expected.do.verb, interaction.do.verb));
  }
  compareConfigSubset("interaction.do.args", expected.do?.args, interaction.do.args, `${path}.do.args`, checks);
  if (expected.disabled !== undefined) {
    checks.push(equality("interaction.disabled", `${path}.disabled`, expected.disabled, interaction.disabled));
  }
}

function compareAnnotation(
  expected: ExpectedAnnotation,
  annotation: CompositionAnnotation,
  path: string,
  checks: EvalCheck[],
): void {
  if (expected.kind !== undefined)
    checks.push(equality("annotation.kind", `${path}.kind`, expected.kind, annotation.kind));
  if (expected.label !== undefined) {
    checks.push(equality("annotation.label", `${path}.label`, expected.label, annotation.label));
  }
  if (expected.text !== undefined)
    checks.push(equality("annotation.text", `${path}.text`, expected.text, annotation.text));
}

/** Every key the expectation names must deep-match; keys it does not name are ignored. */
function compareConfigSubset(
  checkId: string,
  expected: Readonly<Record<string, unknown>> | undefined,
  actual: Readonly<Record<string, unknown>> | undefined,
  path: string,
  checks: EvalCheck[],
): void {
  if (!expected) return;
  for (const [key, value] of Object.entries(expected)) {
    checks.push(equality(checkId, `${path}.${key}`, value, actual?.[key]));
  }
}

function scoreView(view: CompositionView, expected: ExpectedView, checks: EvalCheck[]): void {
  const tolerance = expected.tolerance ?? DEFAULT_VIEW_TOLERANCE;
  if (expected.zoom !== undefined)
    checks.push(closeTo("view.zoom", "state.view.zoom", expected.zoom, view.zoom, tolerance));
  if (expected.pitch !== undefined) {
    checks.push(closeTo("view.pitch", "state.view.pitch", expected.pitch, view.pitch, tolerance));
  }
  if (expected.bearing !== undefined) {
    checks.push(closeTo("view.bearing", "state.view.bearing", expected.bearing, view.bearing, tolerance));
  }
  const coordinateTolerance = expected.centerTolerance ?? tolerance;
  if (expected.center !== undefined) {
    checks.push(closeToTuple("view.center", "state.view.center", expected.center, view.center, coordinateTolerance));
  }
  if (expected.bbox !== undefined) {
    checks.push(closeToTuple("view.bbox", "state.view.bbox", expected.bbox, view.bbox, coordinateTolerance));
  }
  for (const field of expected.unset ?? []) {
    const actual = view[field];
    checks.push({
      id: "view.unset",
      path: `state.view.${field}`,
      status: actual === undefined ? "pass" : "fail",
      expected: undefined,
      actual,
      message: actual === undefined ? "unset, as expected" : `expected unset, got ${json(actual)}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

function scoreActivityLog(
  entries: readonly ActivityLogEntry[],
  expected: ExpectedActivityLog,
  checks: EvalCheck[],
): void {
  const types = entries.map((entry) => entry.type);

  for (const [type, count] of Object.entries(expected.counts ?? {})) {
    if (count === undefined) continue;
    const actual = types.filter((candidate) => candidate === type).length;
    checks.push(equality("activityLog.counts", `activityLog.counts.${type}`, count, actual));
  }

  for (const type of expected.absentTypes ?? []) {
    const actual = types.filter((candidate) => candidate === type).length;
    checks.push({
      id: "activityLog.absentTypes",
      path: `activityLog.counts.${type}`,
      status: actual === 0 ? "pass" : "fail",
      expected: 0,
      actual,
      message: actual === 0 ? "never logged, as expected" : `expected no "${type}" entries, found ${actual}`,
    });
  }

  if (expected.sequence) {
    const matched = isSubsequence(expected.sequence, types);
    checks.push({
      id: "activityLog.sequence",
      path: "activityLog.sequence",
      status: matched ? "pass" : "fail",
      expected: expected.sequence,
      actual: types,
      message: matched
        ? "entry types occur in the expected order"
        : `expected the types ${json(expected.sequence)} in this order; logged: ${json(types)}`,
    });
  }

  (expected.present ?? []).forEach((expectation, index) => {
    const matches = entries.filter(
      (entry) => entry.type === expectation.type && matchesSubset(expectation.detail, entry.detail),
    );
    const path = `activityLog.entries[${index}:${expectation.type}]`;
    if (expectation.count !== undefined) {
      checks.push({
        id: "activityLog.present",
        path,
        status: matches.length === expectation.count ? "pass" : "fail",
        expected: expectation.count,
        actual: matches.length,
        message:
          matches.length === expectation.count
            ? `${matches.length} matching entr${matches.length === 1 ? "y" : "ies"}`
            : `expected exactly ${expectation.count} "${expectation.type}" entr${expectation.count === 1 ? "y" : "ies"} matching ${json(expectation.detail ?? {})}, found ${matches.length}`,
      });
      return;
    }
    checks.push({
      id: "activityLog.present",
      path,
      status: matches.length > 0 ? "pass" : "fail",
      expected: expectation,
      actual: entries.filter((entry) => entry.type === expectation.type).map((entry) => entry.detail),
      message:
        matches.length > 0
          ? `matched ${matches.length} entr${matches.length === 1 ? "y" : "ies"}`
          : `no "${expectation.type}" entry matching ${json(expectation.detail ?? {})}`,
    });
  });
}

/** `expected` must occur in `actual` in order, but not necessarily contiguously. */
function isSubsequence(expected: readonly ActivityLogEntryType[], actual: readonly ActivityLogEntryType[]): boolean {
  let cursor = 0;
  for (const type of actual) {
    if (type === expected[cursor]) cursor += 1;
    if (cursor === expected.length) return true;
  }
  return expected.length === 0;
}

/** Deep subset: every key of `expected` must deep-equal the same key of `actual`. Arrays compare exactly. */
function matchesSubset(expected: Readonly<Record<string, unknown>> | undefined, actual: unknown): boolean {
  if (expected === undefined) return true;
  if (!isPlainObject(actual)) return false;
  return Object.entries(expected).every(([key, value]) => {
    const candidate = actual[key];
    if (isPlainObject(value)) return matchesSubset(value, candidate);
    return deepEquals(value, candidate);
  });
}

// ---------------------------------------------------------------------------
// Check constructors
// ---------------------------------------------------------------------------

function equality(id: string, path: string, expected: unknown, actual: unknown): EvalCheck {
  const ok = deepEquals(expected, actual);
  return {
    id,
    path,
    status: ok ? "pass" : "fail",
    expected,
    actual,
    message: ok ? `= ${json(expected)}` : `expected ${json(expected)}, got ${json(actual)}`,
  };
}

function membership(
  id: string,
  path: string,
  shouldBePresent: boolean,
  isPresent: boolean,
  all: readonly string[],
): EvalCheck {
  const ok = shouldBePresent === isPresent;
  return {
    id,
    path,
    status: ok ? "pass" : "fail",
    expected: shouldBePresent ? "present" : "absent",
    actual: isPresent ? "present" : "absent",
    message: ok
      ? shouldBePresent
        ? "present"
        : "absent"
      : shouldBePresent
        ? `expected present — actual: ${json(all)}`
        : `expected absent, but it is present — actual: ${json(all)}`,
  };
}

function closeTo(id: string, path: string, expected: number, actual: number | undefined, tolerance: number): EvalCheck {
  const ok = actual !== undefined && Math.abs(actual - expected) <= tolerance;
  return {
    id,
    path,
    status: ok ? "pass" : "fail",
    expected,
    actual,
    message: ok ? `= ${actual} (±${tolerance})` : `expected ${expected} ±${tolerance}, got ${json(actual)}`,
  };
}

function closeToTuple(
  id: string,
  path: string,
  expected: readonly number[],
  actual: readonly number[] | undefined,
  tolerance: number,
): EvalCheck {
  const ok =
    actual !== undefined &&
    actual.length === expected.length &&
    expected.every((value, index) => Math.abs((actual[index] as number) - value) <= tolerance);
  return {
    id,
    path,
    status: ok ? "pass" : "fail",
    expected,
    actual,
    message: ok ? `= ${json(actual)} (±${tolerance})` : `expected ${json(expected)} ±${tolerance}, got ${json(actual)}`,
  };
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

/** Structural equality via the composition model's own canonical (sorted-key) serialization. */
function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return canonicalCompositionJson(a) === canonicalCompositionJson(b);
}

function json(value: unknown): string {
  return value === undefined ? "undefined" : canonicalCompositionJson(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
