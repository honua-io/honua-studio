/**
 * `src/interactions/` — the ADR-0030 half of honua-studio#25: the declarative
 * compiler, the exploration transport a control's `change` travels on, and
 * the `FilterClause` -> MapLibre translation that makes a moved control move
 * the map.
 *
 * A barrel for hosts and tests. **Element modules import the concrete files
 * instead** — honua-studio#23's lazy-chunk rule: a dynamically imported
 * module that reaches back into a barrel the entry also imports statically
 * makes the same module evaluate twice under two URLs (fatally, under
 * ASP.NET Core's fingerprinted `MapStaticAssets`). See
 * `../elements/studio-canvas-element.ts`'s import block.
 *
 * @module
 */

export {
  GESTURE_EVENT_SOURCES,
  INTERACTION_EVENT_PATH_PREFIX,
  INTERACTION_FANOUT_CAP,
  compileStudioInteractions,
  isInteractionEventPath,
  parseInteractionRef,
  readInteractionEventPath,
  resolveInteractionArgs,
  validateInteractions,
} from "./declarative.js";
export type {
  CompileStudioInteractionsOptions,
  CompiledInteractionBinding,
  ControlChangePayload,
  InteractionDispatchRecord,
  InteractionIssue,
  InteractionIssueCode,
  InteractionLayerComponent,
  InteractionMapComponent,
  InteractionViewport,
  InteractionWidgetComponent,
  ParsedInteractionRef,
  StudioCompiledInteractions,
  StudioControlChangeEvent,
  StudioInteractionComponents,
  StudioInteractionEventSource,
  StudioInteractionRefKind,
  UnsupportedInteraction,
} from "./declarative.js";

export { clauseToMaplibreFilter, clausesToMaplibreFilter } from "./filter-expression.js";
export type { MaplibreFilter } from "./filter-expression.js";

export { EMPTY_LAYER_APPEARANCE, OPACITY_CLAUSE_FIELD, StudioInteractionRuntime } from "./studio-interactions.js";
export type { StudioInteractionRuntimeOptions, StudioLayerAppearance } from "./studio-interactions.js";
