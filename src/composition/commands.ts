/**
 * The composition engine's typed, bounded command set (honua-studio#8;
 * mirrors `@honua/sdk-js`'s `src/agent-tools/index.ts` vocabulary — flat
 * verb-first names, a small fixed union, dry-run-free because every command
 * IS previewed via the reducer's diff output rather than an in-command
 * `dryRun` flag — server#3002 mirrors this same vocabulary, see the module
 * doc on `reducer.ts` for why staying aligned matters).
 *
 * Every command name below corresponds 1:1 to a bounded mutation surface
 * from honua-studio#1's REQ-002 ("layer add/remove/style, view, widgets…")
 * plus pin/unpin (REQ-003) and annotations-as-targets (REQ-012). There is no
 * "run arbitrary code" escape hatch — an unrecognized `name` fails
 * {@link validateCompositionCommand} rather than being passed through.
 *
 * Validation here is structural only (shape, types, enum membership) —
 * hand-rolled, no schema-validation dependency, matching this repo's "no new
 * deps" instruction. Semantic validation that needs current state (does the
 * target exist? is it pinned? is `beforeId` a real layer?) lives in
 * `reducer.ts`, which always runs a command through
 * {@link validateCompositionCommand} first.
 *
 * @module
 */

import {
  COMPOSITION_ANNOTATION_KINDS,
  COMPOSITION_CONTROL_KINDS,
  COMPOSITION_INTERACTION_EVENTS,
  COMPOSITION_INTERACTION_VERBS,
  COMPOSITION_TARGET_KINDS,
  COMPOSITION_WIDGET_KINDS,
  type CompositionAnnotationKind,
  type CompositionControlKind,
  type CompositionInteraction,
  type CompositionStyleRef,
  type CompositionTarget,
  type CompositionTargetKind,
  type CompositionView,
  type CompositionWidgetKind,
} from "./model.js";

// ---------------------------------------------------------------------------
// Command payload shapes
// ---------------------------------------------------------------------------

export interface AddLayerInput {
  readonly id: string;
  readonly sourceId: string;
  readonly title?: string;
  readonly visible?: boolean;
  readonly styleRef?: CompositionStyleRef;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AddWidgetInput {
  readonly id: string;
  readonly kind: CompositionWidgetKind;
  readonly title?: string;
  readonly sourceId?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

/** Mirrors {@link AddWidgetInput} field for field — ADR-0031's entry shape is deliberately the widget entry's. */
export interface AddControlInput {
  readonly id: string;
  readonly kind: CompositionControlKind;
  readonly title?: string;
  readonly sourceId?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface AddAnnotationInput {
  readonly id: string;
  readonly kind: CompositionAnnotationKind;
  readonly label?: string;
  readonly text?: string;
  readonly bbox?: readonly [number, number, number, number];
  readonly coordinate?: readonly [number, number];
}

/** The composition engine's bounded command union. */
export type CompositionCommand =
  | { readonly name: "addLayer"; readonly layer: AddLayerInput; readonly beforeId?: string }
  | { readonly name: "removeLayer"; readonly target: CompositionTarget }
  | { readonly name: "setLayerStyleRef"; readonly target: CompositionTarget; readonly styleRef?: CompositionStyleRef }
  | { readonly name: "setVisibility"; readonly target: CompositionTarget; readonly visible: boolean }
  | { readonly name: "setView"; readonly view: Partial<CompositionView> }
  | { readonly name: "addWidget"; readonly widget: AddWidgetInput }
  | { readonly name: "removeWidget"; readonly target: CompositionTarget }
  | { readonly name: "addControl"; readonly control: AddControlInput }
  /**
   * `cascadeInteractions` mirrors honua-server#3196's `remove_control`
   * argument exactly, including its default: `false` **rejects** the removal
   * while any binding still references the control, `true` removes the
   * dependent bindings with it. There is no third option — ADR-0031 states
   * plainly that silently retaining an unresolvable binding is not conformant.
   */
  | {
      readonly name: "removeControl";
      readonly target: CompositionTarget;
      readonly cascadeInteractions?: boolean;
    }
  | { readonly name: "bindInteraction"; readonly interaction: CompositionInteraction }
  | { readonly name: "removeInteraction"; readonly interactionId: string }
  | { readonly name: "addAnnotation"; readonly annotation: AddAnnotationInput }
  | { readonly name: "removeAnnotation"; readonly target: CompositionTarget }
  | { readonly name: "pin"; readonly target: CompositionTarget }
  | { readonly name: "unpin"; readonly target: CompositionTarget };

export const COMPOSITION_COMMAND_NAMES = [
  "addLayer",
  "removeLayer",
  "setLayerStyleRef",
  "setVisibility",
  "setView",
  "addWidget",
  "removeWidget",
  "addControl",
  "removeControl",
  "bindInteraction",
  "removeInteraction",
  "addAnnotation",
  "removeAnnotation",
  "pin",
  "unpin",
] as const;

export type CompositionCommandName = (typeof COMPOSITION_COMMAND_NAMES)[number];

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export type CompositionCommandValidation =
  | { readonly ok: true; readonly command: CompositionCommand }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Structurally validates an arbitrary value as a {@link CompositionCommand}.
 * Returns a discriminated result rather than throwing — callers at a
 * boundary (draft ingestion, a fixture conversation, a chat tool call) get a
 * list of every problem at once instead of a single first-error exception.
 * `reducer.ts` calls this first and converts a failure into a thrown
 * {@link CompositionCommandError}.
 */
export function validateCompositionCommand(input: unknown): CompositionCommandValidation {
  if (!isPlainObject(input)) return fail(["command must be an object"]);
  const name = input.name;
  if (typeof name !== "string") return fail(["command.name must be a string"]);
  if (!isCompositionCommandName(name)) {
    return fail([`command.name "${name}" is not a known composition command`]);
  }

  switch (name) {
    case "addLayer":
      return validateAddLayer(input);
    case "removeLayer":
      return validateTargetedCommand(input, "removeLayer");
    case "setLayerStyleRef":
      return validateSetLayerStyleRef(input);
    case "setVisibility":
      return validateSetVisibility(input);
    case "setView":
      return validateSetView(input);
    case "addWidget":
      return validateAddWidget(input);
    case "removeWidget":
      return validateTargetedCommand(input, "removeWidget");
    case "addControl":
      return validateAddControl(input);
    case "removeControl":
      return validateRemoveControl(input);
    case "bindInteraction":
      return validateBindInteraction(input);
    case "removeInteraction":
      return validateRemoveInteraction(input);
    case "addAnnotation":
      return validateAddAnnotation(input);
    case "removeAnnotation":
      return validateTargetedCommand(input, "removeAnnotation");
    case "pin":
      return validateTargetedCommand(input, "pin");
    case "unpin":
      return validateTargetedCommand(input, "unpin");
  }
}

function isCompositionCommandName(value: string): value is CompositionCommandName {
  return (COMPOSITION_COMMAND_NAMES as readonly string[]).includes(value);
}

function validateAddLayer(input: Record<string, unknown>): CompositionCommandValidation {
  const errors: string[] = [];
  const layer = input.layer;
  if (!isPlainObject(layer)) {
    errors.push("layer.layer must be an object");
    return fail(errors);
  }
  if (!isNonEmptyString(layer.id)) errors.push("layer.layer.id must be a non-empty string");
  if (!isNonEmptyString(layer.sourceId)) errors.push("layer.layer.sourceId must be a non-empty string");
  if (layer.title !== undefined && typeof layer.title !== "string") errors.push("layer.layer.title must be a string");
  if (layer.visible !== undefined && typeof layer.visible !== "boolean") {
    errors.push("layer.layer.visible must be a boolean");
  }
  errors.push(...validateOptionalStyleRef(layer.styleRef, "layer.layer.styleRef"));
  if (layer.metadata !== undefined && !isPlainObject(layer.metadata)) {
    errors.push("layer.layer.metadata must be an object");
  }
  if (input.beforeId !== undefined && !isNonEmptyString(input.beforeId)) {
    errors.push("layer.beforeId must be a non-empty string");
  }
  if (errors.length > 0) return fail(errors);
  return {
    ok: true,
    command: {
      name: "addLayer",
      layer: layer as unknown as AddLayerInput,
      ...(typeof input.beforeId === "string" ? { beforeId: input.beforeId } : {}),
    },
  };
}

function validateSetLayerStyleRef(input: Record<string, unknown>): CompositionCommandValidation {
  const errors: string[] = [];
  const target = validateTarget(input.target, errors, "setLayerStyleRef.target");
  errors.push(...validateOptionalStyleRef(input.styleRef, "setLayerStyleRef.styleRef"));
  if (errors.length > 0 || !target) return fail(errors);
  return {
    ok: true,
    command: {
      name: "setLayerStyleRef",
      target,
      ...(input.styleRef !== undefined ? { styleRef: input.styleRef as CompositionStyleRef } : {}),
    },
  };
}

/**
 * `setVisibility` — the mutation a TOC's checkbox performs (honua-studio#24
 * REQ-003) and the one an agent uses to say "hide the parcels".
 *
 * Named after the SDK's `HonuaAppController.setVisibility`, whose vocabulary
 * `reducer.ts` already mirrors, so the composition command and the runtime
 * method a custom binding would call are the same word. It stays in the
 * bounded command set precisely so that the TOC's *intrinsic* toggle and an
 * agent's *authored* one are the same write path: there is no chrome-only
 * side door around the reducer, pins, history, or draft sync.
 */
function validateSetVisibility(input: Record<string, unknown>): CompositionCommandValidation {
  const errors: string[] = [];
  const target = validateTarget(input.target, errors, "setVisibility.target");
  if (typeof input.visible !== "boolean") errors.push("setVisibility.visible must be a boolean");
  if (errors.length > 0 || !target) return fail(errors);
  return { ok: true, command: { name: "setVisibility", target, visible: input.visible as boolean } };
}

function validateSetView(input: Record<string, unknown>): CompositionCommandValidation {
  const errors: string[] = [];
  const view = input.view;
  if (!isPlainObject(view)) return fail(["setView.view must be an object"]);
  if (view.bbox !== undefined && !isNumberTuple(view.bbox, 4)) errors.push("setView.view.bbox must be [x,y,x,y]");
  if (view.center !== undefined && !isNumberTuple(view.center, 2)) errors.push("setView.view.center must be [x,y]");
  if (view.zoom !== undefined && !isFiniteNumber(view.zoom)) errors.push("setView.view.zoom must be a number");
  if (view.pitch !== undefined && !isFiniteNumber(view.pitch)) errors.push("setView.view.pitch must be a number");
  if (view.bearing !== undefined && !isFiniteNumber(view.bearing)) {
    errors.push("setView.view.bearing must be a number");
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, command: { name: "setView", view: view as Partial<CompositionView> } };
}

function validateAddWidget(input: Record<string, unknown>): CompositionCommandValidation {
  const errors: string[] = [];
  const widget = input.widget;
  if (!isPlainObject(widget)) return fail(["addWidget.widget must be an object"]);
  if (!isNonEmptyString(widget.id)) errors.push("addWidget.widget.id must be a non-empty string");
  if (typeof widget.kind !== "string" || !(COMPOSITION_WIDGET_KINDS as readonly string[]).includes(widget.kind)) {
    errors.push(`addWidget.widget.kind must be one of ${COMPOSITION_WIDGET_KINDS.join(", ")}`);
  }
  if (widget.title !== undefined && typeof widget.title !== "string") {
    errors.push("addWidget.widget.title must be a string");
  }
  if (widget.sourceId !== undefined && typeof widget.sourceId !== "string") {
    errors.push("addWidget.widget.sourceId must be a string");
  }
  if (widget.config !== undefined && !isPlainObject(widget.config)) {
    errors.push("addWidget.widget.config must be an object");
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, command: { name: "addWidget", widget: widget as unknown as AddWidgetInput } };
}

/**
 * `addControl` — ADR-0031's `add_control`, with its closed 14-kind admission
 * gate. The gate is the point: a control kind this app cannot name is a
 * control no host can render, and rejecting it at authoring time is the
 * difference between an agent learning it asked for something that does not
 * exist and a user staring at a document that renders nothing.
 *
 * Deliberately *not* validated here: whether `sourceId` resolves to a layer.
 * honua-server#3196 enforces that at its three gates, but this app's state is
 * a projection where a control may legitimately arrive before the layer it
 * reads from (a streamed conversation adds them in whichever order the model
 * chose) — so an unresolvable `sourceId` is a *render-time* reported reason
 * (`../controls/control-config.ts`), not an authoring-time rejection.
 */
function validateAddControl(input: Record<string, unknown>): CompositionCommandValidation {
  const errors: string[] = [];
  const control = input.control;
  if (!isPlainObject(control)) return fail(["addControl.control must be an object"]);
  if (!isNonEmptyString(control.id)) errors.push("addControl.control.id must be a non-empty string");
  if (typeof control.kind !== "string" || !(COMPOSITION_CONTROL_KINDS as readonly string[]).includes(control.kind)) {
    errors.push(`addControl.control.kind must be one of ${COMPOSITION_CONTROL_KINDS.join(", ")}`);
  }
  if (control.title !== undefined && typeof control.title !== "string") {
    errors.push("addControl.control.title must be a string");
  }
  if (control.sourceId !== undefined && !isNonEmptyString(control.sourceId)) {
    errors.push("addControl.control.sourceId must be a non-empty string when present");
  }
  if (control.config !== undefined && !isPlainObject(control.config)) {
    errors.push("addControl.control.config must be an object");
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, command: { name: "addControl", control: control as unknown as AddControlInput } };
}

function validateRemoveControl(input: Record<string, unknown>): CompositionCommandValidation {
  const errors: string[] = [];
  const target = validateTarget(input.target, errors, "removeControl.target");
  if (input.cascadeInteractions !== undefined && typeof input.cascadeInteractions !== "boolean") {
    errors.push("removeControl.cascadeInteractions must be a boolean");
  }
  if (errors.length > 0 || !target) return fail(errors);
  return {
    ok: true,
    command: {
      name: "removeControl",
      target,
      ...(typeof input.cascadeInteractions === "boolean" ? { cascadeInteractions: input.cascadeInteractions } : {}),
    },
  };
}

/** The `map | layer:{id} | widget:{id} | control:{id}` grammar, verbatim from ADR-0030's `componentRef` pattern. */
const INTERACTION_REF_PATTERN = /^(map|layer:.+|widget:.+|control:.+)$/;

function validateBindInteraction(input: Record<string, unknown>): CompositionCommandValidation {
  const errors: string[] = [];
  const interaction = input.interaction;
  if (!isPlainObject(interaction)) return fail(["bindInteraction.interaction must be an object"]);
  if (!isNonEmptyString(interaction.id)) errors.push("bindInteraction.interaction.id must be a non-empty string");

  const on = interaction.on;
  if (!isPlainObject(on)) {
    errors.push("bindInteraction.interaction.on must be an object");
  } else {
    if (!isNonEmptyString(on.ref) || !INTERACTION_REF_PATTERN.test(on.ref)) {
      errors.push(
        'bindInteraction.interaction.on.ref must match "map", "layer:{id}", "widget:{id}", or "control:{id}"',
      );
    }
    if (typeof on.event !== "string" || !(COMPOSITION_INTERACTION_EVENTS as readonly string[]).includes(on.event)) {
      errors.push(`bindInteraction.interaction.on.event must be one of ${COMPOSITION_INTERACTION_EVENTS.join(", ")}`);
    }
  }

  const action = interaction.do;
  if (!isPlainObject(action)) {
    errors.push("bindInteraction.interaction.do must be an object");
  } else {
    if (!isNonEmptyString(action.ref) || !INTERACTION_REF_PATTERN.test(action.ref)) {
      errors.push(
        'bindInteraction.interaction.do.ref must match "map", "layer:{id}", "widget:{id}", or "control:{id}"',
      );
    }
    if (
      typeof action.verb !== "string" ||
      !(COMPOSITION_INTERACTION_VERBS as readonly string[]).includes(action.verb)
    ) {
      errors.push(`bindInteraction.interaction.do.verb must be one of ${COMPOSITION_INTERACTION_VERBS.join(", ")}`);
    }
    if (action.args !== undefined && !isPlainObject(action.args)) {
      errors.push("bindInteraction.interaction.do.args must be an object");
    }
  }

  if (interaction.disabled !== undefined && typeof interaction.disabled !== "boolean") {
    errors.push("bindInteraction.interaction.disabled must be a boolean");
  }
  if (errors.length > 0) return fail(errors);
  return {
    ok: true,
    command: { name: "bindInteraction", interaction: interaction as unknown as CompositionInteraction },
  };
}

function validateRemoveInteraction(input: Record<string, unknown>): CompositionCommandValidation {
  if (!isNonEmptyString(input.interactionId)) {
    return fail(["removeInteraction.interactionId must be a non-empty string"]);
  }
  return { ok: true, command: { name: "removeInteraction", interactionId: input.interactionId } };
}

function validateAddAnnotation(input: Record<string, unknown>): CompositionCommandValidation {
  const errors: string[] = [];
  const annotation = input.annotation;
  if (!isPlainObject(annotation)) return fail(["addAnnotation.annotation must be an object"]);
  if (!isNonEmptyString(annotation.id)) errors.push("addAnnotation.annotation.id must be a non-empty string");
  if (
    typeof annotation.kind !== "string" ||
    !(COMPOSITION_ANNOTATION_KINDS as readonly string[]).includes(annotation.kind)
  ) {
    errors.push(`addAnnotation.annotation.kind must be one of ${COMPOSITION_ANNOTATION_KINDS.join(", ")}`);
  }
  if (annotation.label !== undefined && typeof annotation.label !== "string") {
    errors.push("addAnnotation.annotation.label must be a string");
  }
  if (annotation.text !== undefined && typeof annotation.text !== "string") {
    errors.push("addAnnotation.annotation.text must be a string");
  }
  if (annotation.bbox !== undefined && !isNumberTuple(annotation.bbox, 4)) {
    errors.push("addAnnotation.annotation.bbox must be [x,y,x,y]");
  }
  if (annotation.coordinate !== undefined && !isNumberTuple(annotation.coordinate, 2)) {
    errors.push("addAnnotation.annotation.coordinate must be [x,y]");
  }
  if (errors.length > 0) return fail(errors);
  return { ok: true, command: { name: "addAnnotation", annotation: annotation as unknown as AddAnnotationInput } };
}

function validateTargetedCommand(
  input: Record<string, unknown>,
  name: "removeLayer" | "removeWidget" | "removeAnnotation" | "pin" | "unpin",
): CompositionCommandValidation {
  const errors: string[] = [];
  const target = validateTarget(input.target, errors, `${name}.target`);
  if (errors.length > 0 || !target) return fail(errors);
  return { ok: true, command: { name, target } };
}

function validateTarget(value: unknown, errors: string[], path: string): CompositionTarget | undefined {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object`);
    return undefined;
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !(COMPOSITION_TARGET_KINDS as readonly string[]).includes(kind)) {
    errors.push(`${path}.kind must be one of ${COMPOSITION_TARGET_KINDS.join(", ")}`);
    return undefined;
  }
  const targetKind = kind as CompositionTargetKind;
  if (targetKind === "feature") {
    if (!isNonEmptyString(value.sourceId)) errors.push(`${path}.sourceId must be a non-empty string`);
    if (value.featureId === undefined || (typeof value.featureId !== "string" && typeof value.featureId !== "number")) {
      errors.push(`${path}.featureId must be a string or number`);
    }
    if (errors.length > 0) return undefined;
    return { kind: "feature", sourceId: value.sourceId as string, featureId: value.featureId as string | number };
  }
  if (!isNonEmptyString(value.id)) {
    errors.push(`${path}.id must be a non-empty string`);
    return undefined;
  }
  return { kind: targetKind, id: value.id } as CompositionTarget;
}

function validateOptionalStyleRef(value: unknown, path: string): readonly string[] {
  if (value === undefined) return [];
  if (!isPlainObject(value)) return [`${path} must be an object`];
  const errors: string[] = [];
  if (value.kind !== "style-ref") errors.push(`${path}.kind must be "style-ref"`);
  if (!isNonEmptyString(value.styleId)) errors.push(`${path}.styleId must be a non-empty string`);
  if (value.version !== undefined && typeof value.version !== "string") {
    errors.push(`${path}.version must be a string`);
  }
  return errors;
}

function fail(errors: readonly string[]): CompositionCommandValidation {
  return { ok: false, errors };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNumberTuple(value: unknown, length: number): value is readonly number[] {
  return Array.isArray(value) && value.length === length && value.every((entry) => isFiniteNumber(entry));
}
