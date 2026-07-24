/**
 * Runs a scripted {@link CompositionToolCallScript} (honua-studio#8 build
 * item 5) through the reducer and returns the resulting state, the diff
 * trail, and a {@link CompositionHistory} — the deterministic, model-free
 * evaluation path NFR-001 requires (`.specifica/studio-v0/spec.md`): the
 * SAME composition journeys a live agent would produce, replayed byte-stably
 * in CI with no model in the loop.
 *
 * @module
 */

import type { CompositionCommand } from "./commands.js";
import { CompositionHistory, type CompositionHistoryOptions } from "./history.js";
import { type CompositionState, canonicalCompositionJson, createEmptyCompositionState } from "./model.js";
import { type CompositionCommandError, type CompositionDiff, isCompositionCommandError } from "./reducer.js";
import type { CompositionToolCall, CompositionToolCallScript } from "./tool-call.js";

/** Converts a `{ tool, input }` entry into a {@link CompositionCommand}-shaped value by treating `tool` as the command `name`. Structural only — the reducer re-validates via `commands.ts`. */
export function toolCallToCommand(call: CompositionToolCall): Record<string, unknown> {
  return { name: call.tool, ...call.input };
}

export interface FixtureConversationStepResult {
  readonly call: CompositionToolCall;
  readonly diff: CompositionDiff;
}

export interface FixtureConversationResult {
  readonly state: CompositionState;
  readonly history: CompositionHistory;
  readonly steps: readonly FixtureConversationStepResult[];
  readonly canonicalJson: string;
}

/** Thrown by {@link runFixtureConversation} when a scripted step is rejected — wraps the underlying {@link CompositionCommandError} with the step's position and the script's id for a legible failure. */
export class FixtureConversationError extends Error {
  public readonly scriptId: string;
  public readonly stepIndex: number;
  public readonly call: CompositionToolCall;
  public readonly cause: unknown;

  public constructor(scriptId: string, stepIndex: number, call: CompositionToolCall, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`Fixture conversation "${scriptId}" step ${stepIndex} ("${call.tool}") failed: ${causeMessage}`);
    this.name = "FixtureConversationError";
    this.scriptId = scriptId;
    this.stepIndex = stepIndex;
    this.call = call;
    this.cause = cause;
  }
}

export function isFixtureConversationError(error: unknown): error is FixtureConversationError {
  return error instanceof FixtureConversationError;
}

/** Unwraps the underlying {@link CompositionCommandError}, if any, from a {@link FixtureConversationError}. */
export function fixtureConversationCommandError(error: FixtureConversationError): CompositionCommandError | undefined {
  return isCompositionCommandError(error.cause) ? error.cause : undefined;
}

/**
 * Applies every call in `script.calls`, in order, against `initialState`
 * (default: {@link createEmptyCompositionState}). Stops and throws a
 * {@link FixtureConversationError} on the first rejected step — a fixture
 * conversation is a script, not a best-effort batch; a step that fails
 * means the fixture itself (or the reducer) has a bug, not something to
 * silently skip.
 */
export function runFixtureConversation(
  script: CompositionToolCallScript,
  initialState: CompositionState = createEmptyCompositionState(),
  options: CompositionHistoryOptions = {},
): FixtureConversationResult {
  const history = new CompositionHistory(initialState, options);
  const steps: FixtureConversationStepResult[] = [];
  script.calls.forEach((call, index) => {
    try {
      const diff = history.apply(toolCallToCommand(call));
      steps.push({ call, diff });
    } catch (error) {
      throw new FixtureConversationError(script.id, index, call, error);
    }
  });
  return { state: history.current, history, steps, canonicalJson: canonicalCompositionJson(history.current) };
}
