/**
 * Public entry point for the model-quality eval corpus (honua-studio#46).
 * Side effect free on import, like the other feature barrels.
 *
 * See `docs/evals.md` for the corpus format, how to add a task, and the
 * live-model lane's driver seam (blocked on honua-studio#40).
 *
 * @module
 */

export type {
  EvalCapability,
  EvalCheck,
  EvalCheckStatus,
  EvalExpectation,
  EvalKnownBadVariant,
  EvalInstructionTurn,
  EvalScore,
  EvalTask,
  EvalTurn,
  EvalUserActionTurn,
  ExpectedActivityLog,
  ExpectedActivityLogEntry,
  ExpectedAnnotation,
  ExpectedCollection,
  ExpectedCompositionState,
  ExpectedControl,
  ExpectedInteraction,
  ExpectedLayer,
  ExpectedPins,
  ExpectedView,
  ExpectedWidget,
  FixtureAssistantScript,
} from "./types.js";
export { DEFAULT_VIEW_TOLERANCE } from "./types.js";

export type { EvalToolResult, EvalTurnContext, EvalTurnDriver } from "./driver.js";
export { EvalDriverError, FixtureTurnDriver, scriptedTurnEvents } from "./driver.js";

export type { EvalRunOptions, EvalRunResult, EvalTurnRecord, ObservedToolCall } from "./runner.js";
export { createEvalClock, runEvalTask, withKnownBadVariant } from "./runner.js";

export { failingPaths, formatEvalScore, scoreEvalRun } from "./scorer.js";

export { EVAL_CORPUS, evalTaskById } from "./corpus.js";
