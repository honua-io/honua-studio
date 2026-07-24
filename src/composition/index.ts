/**
 * Public entry point for the composition engine (honua-studio#8). Side
 * effect free on import, like `../elements/index.ts`.
 *
 * @module
 */

export type {
  CanonicalJsonOptions,
  CompositionAnnotation,
  CompositionAnnotationKind,
  CompositionLayer,
  CompositionState,
  CompositionStyleRef,
  CompositionTarget,
  CompositionTargetKind,
  CompositionView,
  CompositionWidget,
  CompositionWidgetKind,
} from "./model.js";
export {
  COMPOSITION_ANNOTATION_KINDS,
  COMPOSITION_STATE_VERSION,
  COMPOSITION_TARGET_KINDS,
  COMPOSITION_WIDGET_KINDS,
  canonicalCompositionJson,
  compositionTargetKey,
  compositionTargetsEqual,
  createEmptyCompositionState,
} from "./model.js";

export type {
  AddAnnotationInput,
  AddLayerInput,
  AddWidgetInput,
  CompositionCommand,
  CompositionCommandName,
  CompositionCommandValidation,
} from "./commands.js";
export { COMPOSITION_COMMAND_NAMES, validateCompositionCommand } from "./commands.js";

export type {
  CompositionApplyBatchResult,
  CompositionApplyResult,
  CompositionChange,
  CompositionChangeKind,
  CompositionCommandErrorCode,
  CompositionDiff,
  CompositionTargetResolution,
} from "./reducer.js";
export {
  CompositionCommandError,
  applyCompositionCommand,
  applyCompositionCommands,
  isCompositionCommandError,
  isPinViolation,
  isPinned,
  resolveCompositionTarget,
} from "./reducer.js";

export type {
  CompositionDraft,
  CompositionDraftCreateRequest,
  CompositionDraftEnvelope,
  CompositionDraftErrorCode,
  CompositionDraftRebase,
  CompositionDraftReplaceRequest,
  CompositionDraftStore,
  CompositionHistoryOptions,
  CompositionRevision,
  DraftSyncConflict,
  DraftSyncOptions,
  FixtureDraftStoreOptions,
} from "./history.js";
export {
  CompositionDraftError,
  CompositionHistory,
  DraftSync,
  FixtureDraftStore,
  isCompositionDraftConflict,
} from "./history.js";

export type { CompositionControllerListener, Unsubscribe } from "./controller.js";
export { CompositionController } from "./controller.js";

export type { CompositionToolCall, CompositionToolCallScript } from "./tool-call.js";
export { isCompositionToolCall } from "./tool-call.js";

export type {
  FixtureConversationResult,
  FixtureConversationStepResult,
} from "./fixture-conversation.js";
export {
  FixtureConversationError,
  fixtureConversationCommandError,
  isFixtureConversationError,
  runFixtureConversation,
  toolCallToCommand,
} from "./fixture-conversation.js";
