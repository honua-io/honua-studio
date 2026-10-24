/**
 * Authorized style-suggestion preview. The host transport calls the caller's
 * existing suggest-style route; this module never holds an administrator
 * credential. Preview patches a clone of the current map. Apply writes only
 * `setLayerStyleRef` for the selected composed layer.
 */
import type { CompositionController } from "../composition/controller.js";
import { type CompositionLayer, canonicalCompositionJson } from "../composition/model.js";
import type { CompositionSourceDescriptor } from "../map/source-resolution.js";
import type { MapStyleDocument } from "./map-style-edit.js";

const PERMITTED_OVERRIDE_KEYS = ["paint", "layout", "filter", "minzoom", "maxzoom", "metadata"] as const;
const CREDENTIAL_OR_UNSAFE_URL =
  /access_token|api_key|api-key|x-api-key|authorization|secret|token=|javascript:|data:|\/\/[^/\s:@"]+:[^/\s@"]+@/i;

export type StyleSuggestionResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type CanonicalLayerResolution =
  | { readonly ok: true; readonly canonicalLayerId: number }
  | { readonly ok: false; readonly reason: string };

export interface LayerStyleSuggestionOptions {
  readonly controller: CompositionController;
  readonly catalog: readonly CompositionSourceDescriptor[];
  readonly principalId: string;
  readonly environmentId: string;
  readonly transport: (canonicalLayerId: number, init: { readonly signal: AbortSignal }) => Promise<Response>;
  readonly onPreview?: (style: MapStyleDocument | undefined) => void;
  readonly container?: HTMLElement;
  readonly layerId: string;
}

interface SuggestionView {
  readonly classificationMethod?: string;
  readonly fieldName?: string;
  readonly paletteName?: string;
  readonly edition?: string;
  readonly legend: readonly { readonly label: string; readonly color: string }[];
  readonly observations: readonly string[];
}

interface PendingSuggestion {
  readonly layerId: string;
  readonly revision: string;
  readonly selection: string;
  readonly styleBody: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export function resolveCanonicalMetadataLayer(
  layer: CompositionLayer | undefined,
  catalog: readonly CompositionSourceDescriptor[],
): CanonicalLayerResolution {
  if (!layer) return { ok: false, reason: "The selected layer is no longer on the map." };
  const matches = catalog.filter((entry) => entry.id === layer.sourceId);
  if (matches.length === 0) return { ok: false, reason: "This source is not an authorized catalog layer." };
  if (matches.length > 1) return { ok: false, reason: "The canonical layer is ambiguous." };
  const locator = matches[0]?.locator;
  const url = locator?.url;
  if (typeof url === "string" && (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//"))) {
    return { ok: false, reason: "This source is not an authorized catalog layer." };
  }
  const layerId = locator?.layerId;
  if (typeof layerId !== "number" || !Number.isSafeInteger(layerId) || layerId < 0) {
    return { ok: false, reason: "This layer has no canonical metadata id." };
  }
  return { ok: true, canonicalLayerId: layerId };
}

export class LayerStyleSuggestion {
  readonly #controller: CompositionController;
  readonly #catalog: readonly CompositionSourceDescriptor[];
  readonly #principalId: string;
  readonly #environmentId: string;
  readonly #transport: LayerStyleSuggestionOptions["transport"];
  readonly #onPreview: LayerStyleSuggestionOptions["onPreview"];
  readonly #container: HTMLElement | undefined;
  #layerId: string;
  #generation = 0;
  #abort: AbortController | undefined;
  #cancelReason = "The selection changed before the suggestion returned.";
  #pending: PendingSuggestion | undefined;

  public constructor(options: LayerStyleSuggestionOptions) {
    this.#controller = options.controller;
    this.#catalog = options.catalog;
    this.#principalId = options.principalId;
    this.#environmentId = options.environmentId;
    this.#transport = options.transport;
    this.#onPreview = options.onPreview;
    this.#container = options.container;
    this.#layerId = options.layerId;
  }

  public async request(): Promise<StyleSuggestionResult> {
    const layer = this.#controller.state.layers.find((entry) => entry.id === this.#layerId);
    const resolved = resolveCanonicalMetadataLayer(layer, this.#catalog);
    if (!resolved.ok) return resolved;
    const mapSpec = this.#controller.state.mapSpec;
    if (!mapSpec) return { ok: false, reason: "The suggestion could not be read." };
    const revision = canonicalCompositionJson(this.#controller.state);
    const selection = canonicalCompositionJson(this.#controller.selection);
    const layerId = this.#layerId;
    this.#cancelReason = "The selection changed before the suggestion returned.";
    const generation = ++this.#generation;
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    let response: Response;
    try {
      response = await this.#transport(resolved.canonicalLayerId, { signal: abort.signal });
    } catch {
      if (generation !== this.#generation || abort.signal.aborted) return { ok: false, reason: this.#cancelReason };
      return { ok: false, reason: "The suggestion could not be read." };
    }
    const stale = this.#stale(generation, abort, layerId, revision, selection);
    if (stale) return stale;
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "The suggestion was not authorized." };
    }
    if (response.status === 404) return { ok: false, reason: "The canonical layer is no longer available." };
    if (!response.ok) return { ok: false, reason: "The suggestion could not be read." };
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, reason: "The suggestion could not be read." };
    }
    const afterBody = this.#stale(generation, abort, layerId, revision, selection);
    if (afterBody) return afterBody;
    if (
      !isRecord(payload) ||
      !bindingMatches(payload.binding, {
        principalId: this.#principalId,
        environmentId: this.#environmentId,
        canonicalLayerId: resolved.canonicalLayerId,
        draftRevision: revision,
        composedLayerId: layerId,
      })
    ) {
      return { ok: false, reason: "The suggestion does not match this principal, environment, layer, or draft." };
    }
    const parsed = parseSuggestion(payload.suggestion);
    if (!parsed) return { ok: false, reason: "The suggestion could not be read." };
    const styleBody = styleBodyFor(parsed.layers, layerId, mapSpec);
    if (!styleBody) return { ok: false, reason: "The suggestion could not be read." };
    if (copiedStyleIsRefused(styleBody, mapSpec)) {
      return { ok: false, reason: "The suggestion includes a credential or an unapproved style URL." };
    }
    const stillCurrent = this.#stale(generation, abort, layerId, revision, selection);
    if (stillCurrent) return stillCurrent;
    this.#pending = { layerId, revision, selection, styleBody };
    this.#onPreview?.(overlayPaint(mapSpec, styleBody));
    this.#render(parsed.view);
    return { ok: true };
  }

  public apply(): StyleSuggestionResult {
    const pending = this.#pending;
    if (!pending || pending.layerId !== this.#layerId) {
      return { ok: false, reason: "There is no style suggestion to apply." };
    }
    if (canonicalCompositionJson(this.#controller.selection) !== pending.selection) {
      return { ok: false, reason: "The selection changed before the suggestion returned." };
    }
    if (canonicalCompositionJson(this.#controller.state) !== pending.revision) {
      return { ok: false, reason: "The composition changed since the suggestion." };
    }
    try {
      this.#controller.apply({
        name: "setLayerStyleRef",
        target: { kind: "layer", id: pending.layerId },
        styleBody: pending.styleBody,
      });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : "The suggestion could not be read." };
    }
    this.#pending = undefined;
    this.#onPreview?.(undefined);
    this.#render(undefined);
    return { ok: true };
  }

  public discard(): void {
    this.#cancelReason = "There is no style suggestion to apply.";
    this.#generation += 1;
    this.#abort?.abort();
    this.#abort = undefined;
    this.#pending = undefined;
    this.#onPreview?.(undefined);
    this.#render(undefined);
  }

  public undo(): boolean {
    return this.#controller.undo();
  }

  public retarget(layerId: string): void {
    this.#layerId = layerId;
    this.#cancelReason = "The selection changed before the suggestion returned.";
    this.#generation += 1;
    this.#abort?.abort();
    this.#abort = undefined;
    this.#pending = undefined;
    this.#render(undefined);
  }

  #stale(
    generation: number,
    abort: AbortController,
    layerId: string,
    revision: string,
    selection: string,
  ): StyleSuggestionResult | undefined {
    if (generation !== this.#generation || abort.signal.aborted || this.#layerId !== layerId) {
      return { ok: false, reason: this.#cancelReason };
    }
    if (!this.#controller.state.layers.some((entry) => entry.id === layerId)) {
      return { ok: false, reason: "The selected layer is no longer on the map." };
    }
    if (canonicalCompositionJson(this.#controller.selection) !== selection) {
      return { ok: false, reason: "The selection changed before the suggestion returned." };
    }
    if (canonicalCompositionJson(this.#controller.state) !== revision) {
      return { ok: false, reason: "The composition changed since the suggestion." };
    }
    return undefined;
  }

  #render(view: SuggestionView | undefined): void {
    const container = this.#container;
    if (!container) return;
    container.replaceChildren();
    if (!view) return;
    const section = document.createElement("section");
    section.setAttribute("data-style-suggestion", "");
    appendText(section, "method", view.classificationMethod);
    appendText(section, "field", view.fieldName);
    appendText(section, "palette", view.paletteName);
    appendText(section, "edition", view.edition);
    const legend = document.createElement("ul");
    legend.setAttribute("data-style-suggestion-legend", "");
    for (const entry of view.legend) {
      const item = document.createElement("li");
      item.textContent = `${entry.label} ${entry.color}`;
      legend.append(item);
    }
    const observations = document.createElement("ul");
    observations.setAttribute("data-style-suggestion-observations", "");
    for (const observation of view.observations) {
      const item = document.createElement("li");
      item.textContent = observation;
      observations.append(item);
    }
    section.append(legend, observations);
    container.append(section);
  }
}

function appendText(parent: HTMLElement, name: string, value: string | undefined): void {
  if (value === undefined) return;
  const node = document.createElement("p");
  node.setAttribute(`data-style-suggestion-${name}`, "");
  node.textContent = value;
  parent.append(node);
}

function bindingMatches(
  value: unknown,
  expected: {
    readonly principalId: string;
    readonly environmentId: string;
    readonly canonicalLayerId: number;
    readonly draftRevision: string;
    readonly composedLayerId: string;
  },
): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 5) return false;
  return (
    value.principalId === expected.principalId &&
    value.environmentId === expected.environmentId &&
    value.canonicalLayerId === expected.canonicalLayerId &&
    value.draftRevision === expected.draftRevision &&
    value.composedLayerId === expected.composedLayerId
  );
}

function parseSuggestion(
  value: unknown,
): { readonly layers: readonly Record<string, unknown>[]; readonly view: SuggestionView } | undefined {
  const payload = suggestionData(value);
  if (!payload || !isRecord(payload.mapLibreStyle) || !Array.isArray(payload.mapLibreStyle.layers)) return undefined;
  const layers = payload.mapLibreStyle.layers.filter(isStyledLayer);
  if (layers.length === 0 || !isStringArray(payload.observations)) return undefined;
  if (!isRecord(payload.legend) || !Array.isArray(payload.legend.entries)) return undefined;
  const legend: { label: string; color: string }[] = [];
  for (const entry of payload.legend.entries) {
    if (!isRecord(entry) || typeof entry.label !== "string" || typeof entry.color !== "string") return undefined;
    legend.push({ label: entry.label, color: entry.color });
  }
  const classificationMethod = optionalString(payload.classificationMethod);
  const paletteName = optionalString(payload.paletteName);
  const edition = optionalString(payload.edition);
  if (classificationMethod === null || paletteName === null || edition === null) return undefined;
  let fieldName: string | undefined;
  if (payload.suggestedField !== undefined && payload.suggestedField !== null) {
    if (!isRecord(payload.suggestedField) || typeof payload.suggestedField.name !== "string") return undefined;
    fieldName = payload.suggestedField.name;
  }
  return {
    layers,
    view: {
      ...(classificationMethod === undefined ? {} : { classificationMethod }),
      ...(fieldName === undefined ? {} : { fieldName }),
      ...(paletteName === undefined ? {} : { paletteName }),
      ...(edition === undefined ? {} : { edition }),
      legend,
      observations: payload.observations,
    },
  };
}

function suggestionData(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (value.data === undefined) return value;
  return isRecord(value.data) ? value.data : undefined;
}

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : null;
}

function styleBodyFor(
  layers: readonly Record<string, unknown>[],
  layerId: string,
  mapSpec: MapStyleDocument,
): Record<string, Record<string, unknown>> | undefined {
  const primary = overrideFrom(layers[0]);
  if (!primary) return undefined;
  const body: Record<string, Record<string, unknown>> = { [layerId]: primary };
  const outline = layers[1] ? overrideFrom(layers[1]) : undefined;
  if (outline && hasOutline(mapSpec, layerId)) body[`${layerId}__outline`] = outline;
  return body;
}

function overrideFrom(layer: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!layer) return undefined;
  const body: Record<string, unknown> = {};
  for (const key of PERMITTED_OVERRIDE_KEYS) {
    if (layer[key] !== undefined) body[key] = structuredClone(layer[key]);
  }
  return Object.keys(body).length > 0 ? body : undefined;
}

function hasOutline(mapSpec: MapStyleDocument, layerId: string): boolean {
  return (
    Array.isArray(mapSpec.layers) &&
    mapSpec.layers.some((layer) => isRecord(layer) && layer.id === `${layerId}__outline`)
  );
}

function copiedStyleIsRefused(styleBody: unknown, mapSpec: MapStyleDocument): boolean {
  const json = JSON.stringify(styleBody);
  if (CREDENTIAL_OR_UNSAFE_URL.test(json)) return true;
  const mapJson = JSON.stringify(mapSpec);
  for (const url of json.match(/[a-z][a-z0-9+.-]*:\/\/[^"\\\s]+/gi) ?? []) {
    try {
      if (!mapJson.includes(new URL(url).origin)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function overlayPaint(style: MapStyleDocument, styleBody: Record<string, Record<string, unknown>>): MapStyleDocument {
  const next = structuredClone(style) as { layers?: unknown };
  if (!Array.isArray(next.layers)) return next as MapStyleDocument;
  next.layers = next.layers.map((value) => {
    if (!isRecord(value) || typeof value.id !== "string") return value;
    const override = styleBody[value.id];
    if (!isRecord(override) || !isRecord(override.paint)) return value;
    const paint = isRecord(value.paint) ? { ...value.paint, ...override.paint } : { ...override.paint };
    return { ...value, paint };
  });
  return next as MapStyleDocument;
}

function isStyledLayer(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (value.type === "fill" || value.type === "line" || value.type === "circle");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
