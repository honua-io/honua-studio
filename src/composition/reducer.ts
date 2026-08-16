/**
 * The composition engine's pure reducer (honua-studio#8): `state, command`
 * in, `{ state, diff }` out, or a thrown {@link CompositionCommandError}.
 * Never touches the DOM (honua-studio#8 REQ-004) and never calls out to a
 * server itself — persistence is `history.ts`'s job (AD-8: this reducer is
 * the client's projection/merge engine, not the source of truth).
 *
 * Every command is checked in two phases:
 *
 *  1. Structural validation ({@link validateCompositionCommand} in
 *     `commands.ts`) — shape, types, enum membership. Failures throw
 *     `invalid-command`.
 *  2. Semantic validation (this module) — does the target exist
 *     (`target-not-found`), is it already taken (`duplicate-id`), is a
 *     numeric field in range (`out-of-bounds`), and — the one honua-studio#1
 *     REQ-003 calls out by name — is the target **pinned**
 *     (`pin-violation`): a command touching a pinned layer/widget/annotation
 *     fails unless an explicit `unpin` for that same target runs first (in
 *     an earlier command of the same {@link applyCompositionCommands} batch,
 *     or a prior call entirely).
 *
 * The vocabulary here (`addLayer`/`removeLayer`/`setLayerStyleRef`/
 * `setVisibility`/`setView`/`addWidget`/`removeWidget`/`pin`/`unpin`, target resolution by
 * `{ kind: "layer" | "feature" | "region" | "component" }`) intentionally
 * mirrors `@honua/sdk-js`'s `src/agent-tools/index.ts` naming and
 * `src/app-controller/controller.ts`'s target vocabulary (layer/source
 * mutations, visibility targets, overlays, annotations) — honua-server#3002
 * mirrors the same vocabulary server-side, so an agent's tool-call shape
 * doesn't need translating at this boundary.
 *
 * @module
 */

import {
  type AddAnnotationInput,
  type AddControlInput,
  type AddLayerInput,
  type AddWidgetInput,
  type CompositionCommand,
  validateCompositionCommand,
} from "./commands.js";
import {
  type CompositionAnnotation,
  type CompositionControl,
  type CompositionInteraction,
  type CompositionLayer,
  type CompositionState,
  type CompositionStyleRef,
  type CompositionTarget,
  type CompositionTargetKind,
  type CompositionView,
  type CompositionWidget,
  canonicalCompositionJson,
  compositionTargetKey,
  compositionTargetsEqual,
  interactionsReferencingControl,
} from "./model.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type CompositionCommandErrorCode =
  | "invalid-command"
  | "duplicate-id"
  | "target-not-found"
  | "pin-violation"
  | "out-of-bounds"
  /**
   * `removeControl` was asked to remove a control an interaction still
   * references, with `cascadeInteractions` left at its default `false`
   * (honua-studio#25; mirrors honua-server#3196's refusal). The error names
   * the offending binding ids and the way forward, because "the removal
   * failed" without them is a dead end for both a human and an agent.
   */
  | "interaction-conflict";

/** Thrown by {@link applyCompositionCommand} for any rejected command. Never thrown mid-mutation — state is untouched on failure. */
export class CompositionCommandError extends Error {
  public readonly code: CompositionCommandErrorCode;
  public readonly command: CompositionCommand | undefined;
  public readonly details: readonly string[];

  public constructor(
    code: CompositionCommandErrorCode,
    message: string,
    options: { readonly command?: CompositionCommand; readonly details?: readonly string[] } = {},
  ) {
    super(message);
    this.name = "CompositionCommandError";
    this.code = code;
    this.command = options.command;
    this.details = options.details ?? [];
  }
}

/** Type guard for {@link CompositionCommandError}, including the pin-violation discriminant callers most often branch on. */
export function isCompositionCommandError(error: unknown): error is CompositionCommandError {
  return error instanceof CompositionCommandError;
}

export function isPinViolation(error: unknown): error is CompositionCommandError {
  return isCompositionCommandError(error) && error.code === "pin-violation";
}

// ---------------------------------------------------------------------------
// Diff (the preview payload)
// ---------------------------------------------------------------------------

export type CompositionChangeKind = "add" | "remove" | "replace";

/** One entry in a {@link CompositionDiff} — a single-collection-slot or single-view-field change. */
export interface CompositionChange {
  readonly path: string;
  readonly kind: CompositionChangeKind;
  readonly before?: unknown;
  readonly after?: unknown;
}

/** The reducer's preview payload: the command that ran, and the structured before/after diff it produced. */
export interface CompositionDiff {
  readonly command: CompositionCommand;
  readonly changes: readonly CompositionChange[];
}

export interface CompositionApplyResult {
  readonly state: CompositionState;
  readonly diff: CompositionDiff;
}

export interface CompositionApplyBatchResult {
  readonly state: CompositionState;
  readonly diffs: readonly CompositionDiff[];
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

export interface CompositionTargetResolution {
  readonly target: CompositionTarget;
  readonly exists: boolean;
  readonly pinned: boolean;
  readonly entity?: CompositionLayer | CompositionWidget | CompositionControl | CompositionAnnotation;
}

/** True when `target` (by its stable key — see {@link compositionTargetKey}) is present in `state.pins`. */
export function isPinned(state: CompositionState, target: CompositionTarget): boolean {
  return state.pins.some((pin) => compositionTargetsEqual(pin, target));
}

/**
 * Resolves a deictic {@link CompositionTarget} against composition state.
 * `layer`/`component`/`region` targets resolve against the matching
 * collection (`layers`/`widgets`/`annotations`); `feature` targets always
 * report `exists: true` — composition state does not itself track feature
 * selection (that lives in the SDK's exploration context), so a `feature`
 * target resolves structurally only. Exposed publicly so the chat console
 * (honua-studio#6) can validate an annotation-derived target before
 * dispatching a command built from it.
 */
export function resolveCompositionTarget(
  state: CompositionState,
  target: CompositionTarget,
): CompositionTargetResolution {
  if (target.kind === "layer") {
    const entity = state.layers.find((layer) => layer.id === target.id);
    return { target, exists: entity !== undefined, pinned: isPinned(state, target), entity };
  }
  if (target.kind === "component") {
    const entity = state.widgets.find((widget) => widget.id === target.id);
    return { target, exists: entity !== undefined, pinned: isPinned(state, target), entity };
  }
  if (target.kind === "control") {
    const entity = state.controls.find((control) => control.id === target.id);
    return { target, exists: entity !== undefined, pinned: isPinned(state, target), entity };
  }
  if (target.kind === "region") {
    const entity = state.annotations.find((annotation) => annotation.id === target.id);
    return { target, exists: entity !== undefined, pinned: isPinned(state, target), entity };
  }
  return { target, exists: true, pinned: isPinned(state, target) };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Applies one command to `state`, returning the new state plus a structured
 * diff, or throwing a typed {@link CompositionCommandError}. `input` may be
 * an already-typed {@link CompositionCommand} or an arbitrary value (e.g.
 * JSON from a fixture conversation or a draft payload) — either way it is
 * always re-validated structurally first.
 */
export function applyCompositionCommand(
  state: CompositionState,
  input: CompositionCommand | unknown,
): CompositionApplyResult {
  const validation = validateCompositionCommand(input);
  if (!validation.ok) {
    throw new CompositionCommandError(
      "invalid-command",
      `Invalid composition command: ${validation.errors.join("; ")}`,
      { details: validation.errors },
    );
  }
  const command = validation.command;
  const nextState = applyValidatedCommand(state, command);
  const changes = diffCompositionState(state, nextState);
  return { state: nextState, diff: { command, changes } };
}

/** Applies a sequence of commands in order, threading state through each — see the module doc's pin-sequencing note. */
export function applyCompositionCommands(
  state: CompositionState,
  inputs: readonly (CompositionCommand | unknown)[],
): CompositionApplyBatchResult {
  let current = state;
  const diffs: CompositionDiff[] = [];
  for (const input of inputs) {
    const result = applyCompositionCommand(current, input);
    current = result.state;
    diffs.push(result.diff);
  }
  return { state: current, diffs };
}

function applyValidatedCommand(state: CompositionState, command: CompositionCommand): CompositionState {
  switch (command.name) {
    case "addLayer":
      return applyAddLayer(state, command.layer, command, command.beforeId);
    case "removeLayer": {
      const resolution = requireResolved(state, command.target, "layer", command);
      guardPin(resolution, command);
      const id = nonFeatureTargetId(command.target);
      return { ...state, layers: state.layers.filter((layer) => layer.id !== id) };
    }
    case "setLayerStyleRef": {
      const resolution = requireResolved(state, command.target, "layer", command);
      guardPin(resolution, command);
      const id = nonFeatureTargetId(command.target);
      return {
        ...state,
        layers: state.layers.map((layer) => (layer.id === id ? withStyleRef(layer, command.styleRef) : layer)),
      };
    }
    case "setVisibility": {
      const resolution = requireResolved(state, command.target, "layer", command);
      guardPin(resolution, command);
      const id = nonFeatureTargetId(command.target);
      return {
        ...state,
        layers: state.layers.map((layer) =>
          layer.id === id && layer.visible !== command.visible ? { ...layer, visible: command.visible } : layer,
        ),
      };
    }
    case "setView":
      return { ...state, view: applySetView(state.view, command.view, command) };
    case "addWidget":
      return applyAddWidget(state, command.widget, command);
    case "removeWidget": {
      const resolution = requireResolved(state, command.target, "component", command);
      guardPin(resolution, command);
      const id = nonFeatureTargetId(command.target);
      return { ...state, widgets: state.widgets.filter((widget) => widget.id !== id) };
    }
    case "addControl":
      return applyAddControl(state, command.control, command);
    case "removeControl":
      return applyRemoveControl(state, command);
    case "bindInteraction":
      return applyBindInteraction(state, command.interaction);
    case "removeInteraction": {
      if (!state.interactions.some((interaction) => interaction.id === command.interactionId)) {
        throw new CompositionCommandError(
          "target-not-found",
          `removeInteraction: interaction "${command.interactionId}" does not exist`,
          { command },
        );
      }
      return {
        ...state,
        interactions: state.interactions.filter((interaction) => interaction.id !== command.interactionId),
      };
    }
    case "addAnnotation":
      return applyAddAnnotation(state, command.annotation, command);
    case "removeAnnotation": {
      const resolution = requireResolved(state, command.target, "region", command);
      guardPin(resolution, command);
      const id = nonFeatureTargetId(command.target);
      return { ...state, annotations: state.annotations.filter((annotation) => annotation.id !== id) };
    }
    case "pin":
      return applyPin(state, command.target);
    case "unpin":
      return applyUnpin(state, command.target);
  }
}

function applyAddLayer(
  state: CompositionState,
  layer: AddLayerInput,
  command: CompositionCommand,
  beforeId?: string,
): CompositionState {
  if (state.layers.some((existing) => existing.id === layer.id)) {
    throw new CompositionCommandError("duplicate-id", `addLayer: layer "${layer.id}" already exists`, { command });
  }
  const nextLayer: CompositionLayer = {
    id: layer.id,
    sourceId: layer.sourceId,
    visible: layer.visible ?? true,
    ...(layer.title !== undefined ? { title: layer.title } : {}),
    ...(layer.styleRef !== undefined ? { styleRef: layer.styleRef } : {}),
    ...(layer.metadata !== undefined ? { metadata: layer.metadata } : {}),
  };
  if (beforeId === undefined) return { ...state, layers: [...state.layers, nextLayer] };
  const index = state.layers.findIndex((existing) => existing.id === beforeId);
  if (index === -1) {
    throw new CompositionCommandError("out-of-bounds", `addLayer: beforeId "${beforeId}" does not exist`, { command });
  }
  return { ...state, layers: [...state.layers.slice(0, index), nextLayer, ...state.layers.slice(index)] };
}

function applyAddWidget(
  state: CompositionState,
  widget: AddWidgetInput,
  command: CompositionCommand,
): CompositionState {
  if (state.widgets.some((existing) => existing.id === widget.id)) {
    throw new CompositionCommandError("duplicate-id", `addWidget: widget "${widget.id}" already exists`, { command });
  }
  const nextWidget: CompositionWidget = {
    id: widget.id,
    kind: widget.kind,
    ...(widget.title !== undefined ? { title: widget.title } : {}),
    ...(widget.sourceId !== undefined ? { sourceId: widget.sourceId } : {}),
    ...(widget.config !== undefined ? { config: widget.config } : {}),
  };
  return { ...state, widgets: [...state.widgets, nextWidget] };
}

function applyAddControl(
  state: CompositionState,
  control: AddControlInput,
  command: CompositionCommand,
): CompositionState {
  if (state.controls.some((existing) => existing.id === control.id)) {
    throw new CompositionCommandError("duplicate-id", `addControl: control "${control.id}" already exists`, {
      command,
    });
  }
  const nextControl: CompositionControl = {
    id: control.id,
    kind: control.kind,
    ...(control.title !== undefined ? { title: control.title } : {}),
    ...(control.sourceId !== undefined ? { sourceId: control.sourceId } : {}),
    ...(control.config !== undefined ? { config: control.config } : {}),
  };
  return { ...state, controls: [...state.controls, nextControl] };
}

/**
 * `removeControl`, with ADR-0031's dangling-binding obligation. The default
 * (`cascadeInteractions: false`) refuses, naming the bindings; `true` removes
 * them with the control. Silently leaving an unresolvable `control:{id}`
 * reference behind is the one outcome the standard rules out, so it is the
 * one outcome this function cannot produce.
 */
function applyRemoveControl(
  state: CompositionState,
  command: CompositionCommand & { readonly name: "removeControl" },
): CompositionState {
  const resolution = requireResolved(state, command.target, "control", command);
  guardPin(resolution, command);
  const id = nonFeatureTargetId(command.target);
  const referencing = interactionsReferencingControl(state, id);
  if (referencing.length > 0 && command.cascadeInteractions !== true) {
    throw new CompositionCommandError(
      "interaction-conflict",
      `removeControl: control "${id}" is still referenced by ${referencing
        .map((interaction) => `"${interaction.id}"`)
        .join(", ")} — remove those bindings first, or pass cascadeInteractions: true`,
      { command, details: referencing.map((interaction) => interaction.id) },
    );
  }
  const cascaded = new Set(referencing.map((interaction) => interaction.id));
  return {
    ...state,
    controls: state.controls.filter((control) => control.id !== id),
    interactions:
      cascaded.size === 0 ? state.interactions : state.interactions.filter((entry) => !cascaded.has(entry.id)),
  };
}

/** `bindInteraction` is add-or-**replace** by id, matching honua-server#3175's editor: re-binding the same id is an edit, not a duplicate-id error. */
function applyBindInteraction(state: CompositionState, interaction: CompositionInteraction): CompositionState {
  const index = state.interactions.findIndex((existing) => existing.id === interaction.id);
  if (index === -1) return { ...state, interactions: [...state.interactions, interaction] };
  const interactions = [...state.interactions];
  interactions[index] = interaction;
  return { ...state, interactions };
}

function applyAddAnnotation(
  state: CompositionState,
  annotation: AddAnnotationInput,
  command: CompositionCommand,
): CompositionState {
  if (state.annotations.some((existing) => existing.id === annotation.id)) {
    throw new CompositionCommandError("duplicate-id", `addAnnotation: annotation "${annotation.id}" already exists`, {
      command,
    });
  }
  const nextAnnotation: CompositionAnnotation = {
    id: annotation.id,
    kind: annotation.kind,
    ...(annotation.label !== undefined ? { label: annotation.label } : {}),
    ...(annotation.text !== undefined ? { text: annotation.text } : {}),
    ...(annotation.bbox !== undefined ? { bbox: annotation.bbox } : {}),
    ...(annotation.coordinate !== undefined ? { coordinate: annotation.coordinate } : {}),
  };
  return { ...state, annotations: [...state.annotations, nextAnnotation] };
}

function applySetView(
  view: CompositionView,
  patch: Partial<CompositionView>,
  command: CompositionCommand,
): CompositionView {
  if (patch.zoom !== undefined && (patch.zoom < 0 || patch.zoom > 24)) {
    throw new CompositionCommandError("out-of-bounds", `setView: zoom ${patch.zoom} is out of bounds [0, 24]`, {
      command,
    });
  }
  if (patch.pitch !== undefined && (patch.pitch < 0 || patch.pitch > 85)) {
    throw new CompositionCommandError("out-of-bounds", `setView: pitch ${patch.pitch} is out of bounds [0, 85]`, {
      command,
    });
  }
  if (patch.bearing !== undefined && (patch.bearing < 0 || patch.bearing >= 360)) {
    throw new CompositionCommandError("out-of-bounds", `setView: bearing ${patch.bearing} is out of bounds [0, 360)`, {
      command,
    });
  }
  return { ...view, ...patch };
}

function applyPin(state: CompositionState, target: CompositionTarget): CompositionState {
  if (target.kind !== "feature" && !resolveCompositionTarget(state, target).exists) {
    throw new CompositionCommandError(
      "target-not-found",
      `pin: target ${compositionTargetKey(target)} does not exist`,
      {
        command: { name: "pin", target },
      },
    );
  }
  if (isPinned(state, target)) return state;
  return { ...state, pins: [...state.pins, target] };
}

function applyUnpin(state: CompositionState, target: CompositionTarget): CompositionState {
  if (!isPinned(state, target)) return state;
  return { ...state, pins: state.pins.filter((pin) => !compositionTargetsEqual(pin, target)) };
}

function withStyleRef(layer: CompositionLayer, styleRef: CompositionStyleRef | undefined): CompositionLayer {
  if (styleRef === undefined) {
    const { styleRef: _drop, ...rest } = layer;
    return rest;
  }
  return { ...layer, styleRef };
}

function requireResolved(
  state: CompositionState,
  target: CompositionTarget,
  expectedKind: CompositionTargetKind,
  command: CompositionCommand,
): CompositionTargetResolution {
  if (target.kind !== expectedKind) {
    throw new CompositionCommandError(
      "invalid-command",
      `${command.name}: target must be kind "${expectedKind}", got "${target.kind}"`,
      { command },
    );
  }
  const resolution = resolveCompositionTarget(state, target);
  if (!resolution.exists) {
    throw new CompositionCommandError(
      "target-not-found",
      `${command.name}: target ${compositionTargetKey(target)} does not exist`,
      { command },
    );
  }
  return resolution;
}

function guardPin(resolution: CompositionTargetResolution, command: CompositionCommand): void {
  if (resolution.pinned) {
    throw new CompositionCommandError(
      "pin-violation",
      `${command.name}: target ${compositionTargetKey(resolution.target)} is pinned — unpin it first`,
      { command },
    );
  }
}

function nonFeatureTargetId(target: CompositionTarget): string {
  if (target.kind === "feature") throw new Error("unreachable: feature target has no scalar id");
  return target.id;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

function diffCompositionState(before: CompositionState, after: CompositionState): readonly CompositionChange[] {
  return [
    ...diffKeyedArray(
      before.layers,
      after.layers,
      (layer) => layer.id,
      (id) => `layers[${id}]`,
    ),
    ...diffView(before.view, after.view),
    ...diffKeyedArray(
      before.widgets,
      after.widgets,
      (widget) => widget.id,
      (id) => `widgets[${id}]`,
    ),
    ...diffKeyedArray(
      before.controls,
      after.controls,
      (control) => control.id,
      (id) => `controls[${id}]`,
    ),
    ...diffKeyedArray(
      before.interactions,
      after.interactions,
      (interaction) => interaction.id,
      (id) => `interactions[${id}]`,
    ),
    ...diffKeyedArray(
      before.annotations,
      after.annotations,
      (annotation) => annotation.id,
      (id) => `annotations[${id}]`,
    ),
    ...diffKeyedArray(
      before.pins,
      after.pins,
      (pin) => compositionTargetKey(pin),
      (key) => `pins[${key}]`,
    ),
  ];
}

function diffKeyedArray<T>(
  before: readonly T[],
  after: readonly T[],
  keyOf: (item: T) => string,
  pathOf: (key: string) => string,
): CompositionChange[] {
  const beforeMap = new Map(before.map((item) => [keyOf(item), item] as const));
  const afterMap = new Map(after.map((item) => [keyOf(item), item] as const));
  const changes: CompositionChange[] = [];
  for (const [key, item] of beforeMap) {
    if (!afterMap.has(key)) changes.push({ path: pathOf(key), kind: "remove", before: item });
  }
  for (const [key, item] of afterMap) {
    const previous = beforeMap.get(key);
    if (previous === undefined) {
      changes.push({ path: pathOf(key), kind: "add", after: item });
    } else if (canonicalCompositionJson(previous) !== canonicalCompositionJson(item)) {
      changes.push({ path: pathOf(key), kind: "replace", before: previous, after: item });
    }
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function diffView(before: CompositionView, after: CompositionView): CompositionChange[] {
  const keys = new Set<keyof CompositionView>([
    ...(Object.keys(before) as (keyof CompositionView)[]),
    ...(Object.keys(after) as (keyof CompositionView)[]),
  ]);
  const changes: CompositionChange[] = [];
  for (const key of keys) {
    const beforeValue = before[key];
    const afterValue = after[key];
    const beforeJson = beforeValue === undefined ? undefined : canonicalCompositionJson(beforeValue);
    const afterJson = afterValue === undefined ? undefined : canonicalCompositionJson(afterValue);
    if (beforeJson === afterJson) continue;
    if (beforeJson === undefined) changes.push({ path: `view.${key}`, kind: "add", after: afterValue });
    else if (afterJson === undefined) changes.push({ path: `view.${key}`, kind: "remove", before: beforeValue });
    else changes.push({ path: `view.${key}`, kind: "replace", before: beforeValue, after: afterValue });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}
