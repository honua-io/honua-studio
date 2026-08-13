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
  COMPOSITION_TARGET_KINDS,
  COMPOSITION_WIDGET_KINDS,
  type CompositionAnnotationKind,
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
