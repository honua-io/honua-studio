import type { CompositionCommand } from "../composition/commands.js";
import type { CompositionController } from "../composition/controller.js";
import { canonicalCompositionJson } from "../composition/model.js";
import {
  type MapStyleDocument,
  type MapStyleField,
  type MapStyleLayerOwner,
  thematicMapStyle,
} from "./map-style-edit.js";

/** Same ramp `thematicMapStyle` documents for one-to-five classes plus the fallback color. */
const THEMATIC_PALETTE = ["#eff3ff", "#c6dbef", "#9ecae1", "#6baed6", "#3182bd", "#08519c"] as const;

export interface LayerStyleLegendEntry {
  readonly label: string;
  readonly color: string;
}

export interface LayerStyleThematicInput {
  readonly mode: "categories" | "breaks";
  readonly field: MapStyleField;
  readonly values: readonly unknown[];
}

export interface LayerStylePreviewInput {
  readonly color?: string;
  readonly opacity?: number;
  readonly strokeOrSize?: number;
  readonly thematic?: LayerStyleThematicInput;
}

export type LayerStylePreviewResult =
  | { readonly ok: true; readonly style: MapStyleDocument; readonly legend: readonly LayerStyleLegendEntry[] }
  | { readonly ok: false; readonly reason: string };

export type LayerStyleApplyResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface LayerStyleControls {
  readonly color: boolean;
  readonly opacity: boolean;
  readonly strokeOrSize: "size" | "stroke" | false;
  readonly breaks: boolean;
}

export interface LayerStyleInspectorOptions {
  readonly controller: CompositionController;
  readonly layerId: string;
  readonly fields?: readonly MapStyleField[];
  readonly container?: HTMLElement;
  readonly onPreview?: (style: MapStyleDocument | undefined) => void;
  readonly applyCommand?: (command: CompositionCommand) => Promise<LayerStyleApplyResult> | LayerStyleApplyResult;
}

type Geometry = "circle" | "line" | "fill";

interface PendingPreview {
  readonly layerId: string;
  readonly canonical: string;
  readonly style: MapStyleDocument;
  readonly layerPaint: Record<string, unknown>;
  readonly outlinePaint: Record<string, unknown>;
}

/**
 * Compact map-local paint editor. Preview is transient: it never calls the
 * controller. `setMapStyle` clears every style ref, so an edit is stored as
 * `setLayerStyleRef` whenever the composition already has any style ref.
 */
export class LayerStyleInspector {
  readonly container: HTMLElement | undefined;
  readonly #controller: CompositionController;
  readonly #fields: readonly MapStyleField[] | undefined;
  readonly #onPreview: ((style: MapStyleDocument | undefined) => void) | undefined;
  readonly #applyCommand: LayerStyleInspectorOptions["applyCommand"];
  #layerId: string;
  #root: HTMLElement | undefined;
  #pending: PendingPreview | undefined;

  public constructor(options: LayerStyleInspectorOptions) {
    this.container = options.container;
    this.#controller = options.controller;
    this.#layerId = options.layerId;
    this.#fields = options.fields;
    this.#onPreview = options.onPreview;
    this.#applyCommand = options.applyCommand;
    this.#render();
  }

  public controls(): LayerStyleControls {
    const geometry = this.#geometry();
    const strokeOrSize =
      geometry === "circle"
        ? "size"
        : geometry === "line" || (geometry === "fill" && this.#hasOutline())
          ? "stroke"
          : false;
    return {
      color: true,
      opacity: true,
      strokeOrSize,
      breaks: (this.#fields?.length ?? 0) > 0,
    };
  }

  public preview(input: LayerStylePreviewInput): LayerStylePreviewResult {
    const shared = this.#sharedStyleRefusal();
    if (shared) return shared;
    const current = this.#mapSpec();
    if (!current) return { ok: false, reason: "This layer has no map style." };
    const geometry = this.#geometry();
    if (!geometry) return { ok: false, reason: "This layer cannot be styled." };
    const lossy = lossyLiteralReplacement(current, this.#layerId, geometry, input);
    if (lossy) return lossy;
    const described = input.thematic ? this.#describedField(input.thematic.field) : undefined;
    if (input.thematic && !described) return { ok: false, reason: "Choose a described field." };
    try {
      const built = this.#build(current, geometry, input, described);
      this.#pending = {
        layerId: this.#layerId,
        canonical: canonicalCompositionJson(this.#controller.state),
        style: built.style,
        layerPaint: built.layerPaint,
        outlinePaint: built.outlinePaint,
      };
      this.#onPreview?.(built.style);
      return { ok: true, style: built.style, legend: built.legend };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "The style preview was rejected." };
    }
  }

  public cancel(): void {
    if (!this.#pending) return;
    this.#pending = undefined;
    this.#onPreview?.(undefined);
  }

  public retarget(layerId: string): void {
    this.#layerId = layerId;
    this.#pending = undefined;
    this.#onPreview?.(undefined);
    this.#render();
  }

  public async apply(): Promise<LayerStyleApplyResult> {
    const pending = this.#pending;
    if (!pending || pending.layerId !== this.#layerId)
      return { ok: false, reason: "There is no style preview to apply." };
    if (canonicalCompositionJson(this.#controller.state) !== pending.canonical) {
      return { ok: false, reason: "The composition changed since the preview." };
    }
    const command = this.#command(pending);
    if (this.#applyCommand) {
      const result = await this.#applyCommand(command);
      if (!result.ok) return result;
      this.#pending = undefined;
      return { ok: true };
    }
    try {
      this.#controller.apply(command);
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "The style edit was rejected." };
    }
    this.#pending = undefined;
    return { ok: true };
  }

  public undo(): boolean {
    return this.#controller.undo();
  }

  public dispose(): void {
    this.#root?.remove();
    this.#root = undefined;
  }

  #command(pending: PendingPreview): CompositionCommand {
    const refs = this.#controller.state.styleRefs;
    if (!refs || refs.length === 0) return { name: "setMapStyle", mapSpec: pending.style };
    const body: Record<string, { paint: Record<string, unknown> }> = {};
    const layerPaint = { ...this.#inlinePaint(pending.layerId), ...pending.layerPaint };
    const outlineId = `${pending.layerId}__outline`;
    const outlinePaint = { ...this.#inlinePaint(outlineId), ...pending.outlinePaint };
    if (Object.keys(layerPaint).length > 0) body[pending.layerId] = { paint: layerPaint };
    if (Object.keys(outlinePaint).length > 0) body[outlineId] = { paint: outlinePaint };
    return { name: "setLayerStyleRef", target: { kind: "layer", id: pending.layerId }, styleBody: body };
  }

  #build(
    current: MapStyleDocument,
    geometry: Geometry,
    input: LayerStylePreviewInput,
    described: MapStyleField | undefined,
  ): {
    style: MapStyleDocument;
    legend: readonly LayerStyleLegendEntry[];
    layerPaint: Record<string, unknown>;
    outlinePaint: Record<string, unknown>;
  } {
    let style = overlayInline(current, this.#inlineBody());
    let legend: readonly LayerStyleLegendEntry[] = [];
    if (input.thematic && described) {
      const owner = this.#owner();
      if (!owner) throw new Error("The selected composed layer has no primary render layer.");
      style = thematicMapStyle(style, owner, described, input.thematic.mode, input.thematic.values, THEMATIC_PALETTE);
      legend = legendFor(input.thematic.mode, input.thematic.values);
    }
    const patch: Record<string, unknown> = {};
    if (!input.thematic && input.color !== undefined) patch[`${geometry}-color`] = input.color;
    if (input.opacity !== undefined) patch[`${geometry}-opacity`] = input.opacity;
    if (geometry !== "fill" && input.strokeOrSize !== undefined) {
      patch[geometry === "circle" ? "circle-radius" : "line-width"] = input.strokeOrSize;
    }
    if (Object.keys(patch).length > 0) style = withPaint(style, this.#layerId, patch);
    const outlineId = `${this.#layerId}__outline`;
    if (geometry === "fill" && input.strokeOrSize !== undefined) {
      if (!findLayer(style, outlineId)) throw new Error("This polygon has no outline stroke.");
      style = withPaint(style, outlineId, { "line-width": input.strokeOrSize });
    }
    const base = overlayInline(current, this.#inlineBody());
    return {
      style,
      legend,
      layerPaint: diffPaint(base, style, this.#layerId),
      outlinePaint: diffPaint(base, style, outlineId),
    };
  }

  #sharedStyleRefusal(): LayerStylePreviewResult | undefined {
    const styleId = this.#compositionLayer()?.styleRef?.styleId;
    if (styleId && styleId !== `honua-inline:${this.#layerId}`) {
      return { ok: false, reason: "A shared style cannot be edited from this layer inspector." };
    }
    return undefined;
  }

  #describedField(field: MapStyleField): MapStyleField | undefined {
    return this.#fields?.find((candidate) => candidate.name === field.name);
  }

  #owner(): MapStyleLayerOwner | undefined {
    const layer = this.#compositionLayer();
    if (!layer) return undefined;
    return { id: layer.id, sourceId: layer.sourceId, ...(layer.title !== undefined ? { title: layer.title } : {}) };
  }

  #compositionLayer() {
    return this.#controller.state.layers.find((layer) => layer.id === this.#layerId);
  }

  #geometry(): Geometry | undefined {
    const type = this.#compositionLayer()?.type ?? findLayer(this.#mapSpec(), this.#layerId)?.type;
    return type === "circle" || type === "line" || type === "fill" ? type : undefined;
  }

  #mapSpec(): MapStyleDocument | undefined {
    const spec = this.#controller.state.mapSpec;
    return spec && typeof spec === "object" ? spec : undefined;
  }

  #hasOutline(): boolean {
    return findLayer(this.#mapSpec(), `${this.#layerId}__outline`) !== undefined;
  }

  #inlineBody(): Record<string, unknown> | undefined {
    const body = this.#controller.state.styleRefs?.find((ref) => ref.styleId === `honua-inline:${this.#layerId}`)?.body;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  }

  #inlinePaint(targetId: string): Record<string, unknown> {
    const override = this.#inlineBody()?.[targetId];
    return isRecord(override) && isRecord(override.paint) ? { ...override.paint } : {};
  }

  #render(): void {
    this.#root?.remove();
    this.#root = undefined;
    if (!this.container) return;
    const controls = this.controls();
    const root = document.createElement("div");
    if (controls.strokeOrSize === "size") root.append(controlNode("layer-style-size"));
    if (controls.strokeOrSize === "stroke") root.append(controlNode("layer-style-stroke"));
    if (controls.breaks) root.append(controlNode("layer-style-breaks"));
    this.container.append(root);
    this.#root = root;
  }
}

function controlNode(testId: string): HTMLElement {
  const node = document.createElement("div");
  node.dataset.testid = testId;
  return node;
}

function lossyLiteralReplacement(
  style: MapStyleDocument,
  layerId: string,
  geometry: Geometry,
  input: LayerStylePreviewInput,
): LayerStylePreviewResult | undefined {
  const paint = paintOf(style, layerId);
  if (!input.thematic && input.color !== undefined) {
    const reason = lossyReason(paint[`${geometry}-color`]);
    if (reason) return { ok: false, reason };
  }
  if (input.opacity !== undefined) {
    const reason = lossyReason(paint[`${geometry}-opacity`]);
    if (reason) return { ok: false, reason };
  }
  if (input.strokeOrSize !== undefined) {
    const target = geometry === "fill" ? paintOf(style, `${layerId}__outline`) : paint;
    const key = geometry === "circle" ? "circle-radius" : "line-width";
    const reason = lossyReason(target[key]);
    if (reason) return { ok: false, reason };
  }
  return undefined;
}

function lossyReason(current: unknown): string | undefined {
  if (!Array.isArray(current)) return undefined;
  if (current[0] === "match") return "A categorical expression cannot be replaced by a flat value.";
  return "An advanced expression cannot be replaced by a flat value.";
}

function legendFor(mode: "categories" | "breaks", values: readonly unknown[]): readonly LayerStyleLegendEntry[] {
  if (mode === "categories") {
    return [
      ...values.map((value, index) => ({
        label: String(value),
        color: THEMATIC_PALETTE[index] ?? THEMATIC_PALETTE[0],
      })),
      { label: "Other", color: THEMATIC_PALETTE[values.length] ?? THEMATIC_PALETTE[THEMATIC_PALETTE.length - 1] },
    ];
  }
  const breaks = values.map((value) => Number(value));
  const entries: LayerStyleLegendEntry[] = [{ label: `< ${breaks[0]}`, color: THEMATIC_PALETTE[0] }];
  for (let index = 0; index < breaks.length - 1; index += 1) {
    entries.push({
      label: `${breaks[index]}\u2013${breaks[index + 1]}`,
      color: THEMATIC_PALETTE[index + 1] ?? THEMATIC_PALETTE[0],
    });
  }
  entries.push({
    label: `\u2265 ${breaks[breaks.length - 1]}`,
    color: THEMATIC_PALETTE[breaks.length] ?? THEMATIC_PALETTE[THEMATIC_PALETTE.length - 1],
  });
  return entries;
}

function overlayInline(style: MapStyleDocument, body: Record<string, unknown> | undefined): MapStyleDocument {
  if (!body) return structuredClone(style);
  let next = structuredClone(style);
  for (const [targetId, override] of Object.entries(body)) {
    if (!isRecord(override) || !isRecord(override.paint)) continue;
    next = withPaint(next, targetId, override.paint);
  }
  return next;
}

function withPaint(style: MapStyleDocument, layerId: string, patch: Record<string, unknown>): MapStyleDocument {
  const next = structuredClone(style) as { layers?: unknown };
  if (!Array.isArray(next.layers)) return next;
  next.layers = next.layers.map((value) => {
    if (!isRecord(value) || value.id !== layerId) return value;
    const paint = isRecord(value.paint) ? { ...value.paint, ...patch } : { ...patch };
    return { ...value, paint };
  });
  return next;
}

function diffPaint(before: MapStyleDocument, after: MapStyleDocument, layerId: string): Record<string, unknown> {
  const previous = paintOf(before, layerId);
  const next = paintOf(after, layerId);
  const changed: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (
      canonicalCompositionJson(previous[key] ?? null) !== canonicalCompositionJson(next[key] ?? null) &&
      Object.hasOwn(next, key)
    ) {
      changed[key] = next[key];
    }
  }
  return changed;
}

function paintOf(style: MapStyleDocument | undefined, layerId: string): Record<string, unknown> {
  const paint = findLayer(style, layerId)?.paint;
  return isRecord(paint) ? paint : {};
}

function findLayer(style: MapStyleDocument | undefined, layerId: string): Record<string, unknown> | undefined {
  if (!style || !Array.isArray(style.layers)) return undefined;
  const layer = style.layers.find((value) => isRecord(value) && value.id === layerId);
  return isRecord(layer) ? layer : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
