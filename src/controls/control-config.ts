/**
 * `CompositionControl.config` -> typed, per-kind view models
 * (honua-studio#25 REQ-001).
 *
 * The direct analogue of `../widgets/widget-config.ts`, and deliberately the
 * same shape of module, because the problem is the same one: ADR-0031 leaves
 * `config` open (`{"type": "object"}`, no per-kind schema, no discriminator),
 * so something has to close the gap between "the agent asked for a year-built
 * filter on parcels" and "this control needs a field, a domain, and a way to
 * publish what the user picked". That something is this module.
 *
 * The three properties `widget-config.ts` calls load-bearing hold here too —
 * pure and total, defensible defaults, generous about spelling — plus one
 * more that only controls have:
 *
 *  - **Every kind gets an answer, and "no" is a real answer.** REQ-001 says a
 *    kind that cannot be rendered reports as explicitly unsupported and is
 *    never silently dropped. {@link readControlConfig} is exhaustive over the
 *    closed 14-kind vocabulary and returns either a normalized config or a
 *    stated reason. There is no third outcome and no fall-through.
 *
 * ## Which kinds emit `change`
 *
 * ADR-0031's own schema splits the vocabulary, and {@link CONTROL_KIND_EMITS_CHANGE}
 * is that split made machine-readable. It decides two different things:
 *
 *  - a **map affordance** (`navigation`, `scale`, `fullscreen`, `geolocate`,
 *    `attribution`, `basemapSwitcher`, `bookmarks`, `measure`, `search`) acts
 *    on the map directly through the host — REQ-003's *intrinsic* behavior,
 *    which needs no authored binding and emits nothing;
 *  - a **data-binding affordance** (`timeSlider`, `filterSelect`,
 *    `filterSlider`, `filterDateRange`, `opacity`) emits `change`, which is
 *    what an ADR-0030 interaction binds to.
 *
 * An unbound data-binding control is *inert by design* per ADR-0031 ("a
 * control that a host renders as interactive but that no interaction binds is
 * inert-by-design"), not broken — but the control bar says so on the card
 * rather than leaving the user to discover it by dragging a slider that does
 * nothing.
 *
 * @module
 */

import type { CompositionControl, CompositionControlKind, CompositionState } from "../composition/model.js";

/** Either a normalized config, or the reason the control cannot be rendered as authored. Mirrors `WidgetConfigResult`. */
export type ControlConfigResult<T> =
  | { readonly ok: true; readonly config: T }
  | { readonly ok: false; readonly reason: string };

/**
 * Whether a control kind emits `change` (and therefore is bindable through
 * ADR-0030), or acts on the map intrinsically. Verbatim from the upstream
 * `controlKind` description's own two-way split.
 */
export const CONTROL_KIND_EMITS_CHANGE: Readonly<Record<CompositionControlKind, boolean>> = {
  navigation: false,
  scale: false,
  fullscreen: false,
  geolocate: false,
  search: false,
  measure: false,
  attribution: false,
  basemapSwitcher: false,
  bookmarks: false,
  timeSlider: true,
  filterSelect: true,
  filterSlider: true,
  filterDateRange: true,
  opacity: true,
};

/** Default label per kind — ADR-0031: "hosts fall back to a per-kind default label". */
export const CONTROL_KIND_LABELS: Readonly<Record<CompositionControlKind, string>> = {
  navigation: "Navigation",
  scale: "Scale",
  fullscreen: "Fullscreen",
  geolocate: "My location",
  search: "Search",
  measure: "Measure",
  timeSlider: "Time",
  filterSelect: "Filter",
  filterSlider: "Range",
  filterDateRange: "Date range",
  bookmarks: "Bookmarks",
  opacity: "Opacity",
  attribution: "Attribution",
  basemapSwitcher: "Basemap",
};

// ---------------------------------------------------------------------------
// Per-kind normalized configs
// ---------------------------------------------------------------------------

export interface NavigationControlConfig {
  readonly showZoom: boolean;
  readonly showCompass: boolean;
}

export type ScaleUnit = "metric" | "imperial";

export interface ScaleControlConfig {
  readonly unit: ScaleUnit;
  /** Longest the bar may be drawn, in CSS pixels. The rendered bar is the largest "nice" distance that fits. */
  readonly maxWidthPx: number;
}

export interface FullscreenControlConfig {
  readonly targetLabel: string;
}

export interface GeolocateControlConfig {
  /** Zoom the camera settles on once a fix arrives. */
  readonly zoom: number;
  readonly highAccuracy: boolean;
}

export type MeasureMode = "distance" | "area";

export interface MeasureControlConfig {
  readonly mode: MeasureMode;
  readonly unit: ScaleUnit;
}

export interface AttributionControlConfig {
  /** When true the credits collapse behind a toggle instead of listing inline. */
  readonly compact: boolean;
}

/** One exclusive basemap option. Field names borrowed from the SDK control kit's `HonuaBasemapDefinition` (`@honua/sdk-js/controls`) rather than invented here. */
export interface BasemapOption {
  readonly id: string;
  readonly label: string;
  readonly kind: "vector" | "raster" | "raster-dem-composite";
  /** The Studio offline basemap theme this option selects, when it is one of the built-ins. */
  readonly theme?: "light" | "dark";
}

export interface BasemapSwitcherControlConfig {
  readonly bases: readonly BasemapOption[];
}

/** One bookmark: a label and the view it restores. */
export interface BookmarkEntry {
  readonly id: string;
  readonly label: string;
  readonly view: {
    readonly bbox?: readonly [number, number, number, number];
    readonly center?: readonly [number, number];
    readonly zoom?: number;
    readonly pitch?: number;
    readonly bearing?: number;
  };
}

export interface BookmarksControlConfig {
  readonly bookmarks: readonly BookmarkEntry[];
}

/** One option a `filterSelect` offers. */
export interface FilterSelectOption {
  readonly value: string;
  readonly label: string;
}

export interface FilterSelectControlConfig {
  readonly field: string;
  /** Authored options. Empty means "derive the domain from the bound source's feature values". */
  readonly options: readonly FilterSelectOption[];
  readonly multiple: boolean;
  /** Whether an explicit "All" entry clears the filter. Default true — a filter you cannot undo is a trap. */
  readonly includeAllOption: boolean;
}

export interface FilterSliderControlConfig {
  readonly field: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** `>=` (a floor) is the single-handle default; `<=` and `=` are the other single-value shapes an agent may ask for. */
  readonly operator: ">=" | "<=" | "=";
}

export interface FilterDateRangeControlConfig {
  readonly field: string;
  /** ISO `YYYY-MM-DD` bounds the picker starts on. Absent means unset, not "epoch". */
  readonly from?: string;
  readonly to?: string;
}

export interface TimeSliderControlConfig {
  readonly field: string;
  /** ISO `YYYY-MM-DD` bounds of the slider's travel. */
  readonly from: string;
  readonly to: string;
  /** Slider granularity in days. */
  readonly stepDays: number;
}

export interface OpacityControlConfig {
  /** Composition layer ids the slider drives. Never empty on a successful read. */
  readonly layerIds: readonly string[];
  readonly value: number;
}

/** The discriminated union of every normalized control config. */
export type CompositionControlConfig =
  | { readonly kind: "navigation"; readonly config: NavigationControlConfig }
  | { readonly kind: "scale"; readonly config: ScaleControlConfig }
  | { readonly kind: "fullscreen"; readonly config: FullscreenControlConfig }
  | { readonly kind: "geolocate"; readonly config: GeolocateControlConfig }
  | { readonly kind: "measure"; readonly config: MeasureControlConfig }
  | { readonly kind: "attribution"; readonly config: AttributionControlConfig }
  | { readonly kind: "basemapSwitcher"; readonly config: BasemapSwitcherControlConfig }
  | { readonly kind: "bookmarks"; readonly config: BookmarksControlConfig }
  | { readonly kind: "timeSlider"; readonly config: TimeSliderControlConfig }
  | { readonly kind: "filterSelect"; readonly config: FilterSelectControlConfig }
  | { readonly kind: "filterSlider"; readonly config: FilterSliderControlConfig }
  | { readonly kind: "filterDateRange"; readonly config: FilterDateRangeControlConfig }
  | { readonly kind: "opacity"; readonly config: OpacityControlConfig };

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function configOf(control: CompositionControl): Record<string, unknown> {
  return isPlainObject(control.config) ? control.config : {};
}

function readString(source: Record<string, unknown>, ...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function readNumber(source: Record<string, unknown>, ...names: readonly string[]): number | undefined {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    // An agent that writes `min: "1900"` means 1900. Refusing that would be an
    // avoidable failure, in exactly the sense `normalizeChartType` argues.
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function readBoolean(source: Record<string, unknown>, ...names: readonly string[]): boolean | undefined {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function readStringArray(source: Record<string, unknown>, ...names: readonly string[]): readonly string[] {
  for (const name of names) {
    const value = source[name];
    if (Array.isArray(value)) {
      const entries = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
      if (entries.length > 0) return entries;
    }
  }
  return [];
}

/** `metric`/`imperial`, spelled generously (`km`, `us`, `english`, …). Metric is the default because the rest of the stack is. */
function readUnit(config: Record<string, unknown>): ScaleUnit {
  const raw = (readString(config, "unit", "units", "system") ?? "").toLowerCase();
  if (raw.startsWith("imp") || raw === "us" || raw === "english" || raw === "mi" || raw === "ft") return "imperial";
  return "metric";
}

/** ISO `YYYY-MM-DD` if the value looks like a date at all, else `undefined`. Accepts a full ISO timestamp and truncates it. */
export function readIsoDate(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const fromEpoch = new Date(value);
    return Number.isNaN(fromEpoch.getTime()) ? undefined : (fromEpoch.toISOString().slice(0, 10) as string);
  }
  if (typeof value !== "string" || value.length === 0) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (match?.[1]) return match[1];
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

const DEFAULT_SCALE_MAX_WIDTH_PX = 120;
const DEFAULT_GEOLOCATE_ZOOM = 13;

/** The built-in bases: the vendored offline basemap, in the two themes `../map/basemap.ts` paints. No network, no CDN — REQ-003 of honua-studio#23. */
export const BUILT_IN_BASEMAP_OPTIONS: readonly BasemapOption[] = [
  { id: "honua-offline-light", label: "Light", kind: "vector", theme: "light" },
  { id: "honua-offline-dark", label: "Dark", kind: "vector", theme: "dark" },
];

/**
 * Normalizes one control. Exhaustive over the closed vocabulary: every kind
 * either produces a config or a reason, and `search` is the one kind whose
 * reason is unconditional — see the inline note.
 */
export function readControlConfig(control: CompositionControl): ControlConfigResult<CompositionControlConfig> {
  const config = configOf(control);
  switch (control.kind) {
    case "navigation":
      return ok({
        kind: "navigation",
        config: {
          showZoom: readBoolean(config, "showZoom", "zoom") ?? true,
          showCompass: readBoolean(config, "showCompass", "compass") ?? true,
        },
      });

    case "scale":
      return ok({
        kind: "scale",
        config: {
          unit: readUnit(config),
          maxWidthPx: readNumber(config, "maxWidth", "maxWidthPx", "width") ?? DEFAULT_SCALE_MAX_WIDTH_PX,
        },
      });

    case "fullscreen":
      return ok({
        kind: "fullscreen",
        config: { targetLabel: readString(config, "targetLabel", "label") ?? "map" },
      });

    case "geolocate":
      return ok({
        kind: "geolocate",
        config: {
          zoom: readNumber(config, "zoom") ?? DEFAULT_GEOLOCATE_ZOOM,
          highAccuracy: readBoolean(config, "highAccuracy", "enableHighAccuracy") ?? true,
        },
      });

    case "attribution":
      return ok({ kind: "attribution", config: { compact: readBoolean(config, "compact") ?? false } });

    case "measure":
      return ok({
        kind: "measure",
        config: {
          mode: (readString(config, "mode", "measure") ?? "").toLowerCase().startsWith("area") ? "area" : "distance",
          unit: readUnit(config),
        },
      });

    case "basemapSwitcher": {
      const authored = readBasemapOptions(config);
      return ok({
        kind: "basemapSwitcher",
        config: { bases: authored.length > 0 ? authored : BUILT_IN_BASEMAP_OPTIONS },
      });
    }

    case "bookmarks": {
      const bookmarks = readBookmarks(config, control.id);
      if (bookmarks.length === 0) {
        return fail(
          `Bookmarks "${control.id}" has no config.bookmarks: [{ label, bbox }] (or { label, center, zoom }) to travel to.`,
        );
      }
      return ok({ kind: "bookmarks", config: { bookmarks } });
    }

    case "opacity": {
      // A slider with nothing to fade is chrome theater. `sourceId` is the
      // ADR's binding field; `config.layerIds` is the multi-layer spelling.
      const layerIds = readStringArray(config, "layerIds", "layers");
      const resolved = layerIds.length > 0 ? layerIds : control.sourceId ? [control.sourceId] : [];
      if (resolved.length === 0) {
        return fail(`Opacity "${control.id}" names no layer — set the control's sourceId, or config.layerIds.`);
      }
      const value = readNumber(config, "value", "opacity", "default");
      return ok({
        kind: "opacity",
        config: { layerIds: resolved, value: clamp01(value ?? 1) },
      });
    }

    case "filterSelect": {
      const field = readString(config, "field", "attribute", "property");
      if (!field) {
        return fail(`Filter "${control.id}" has no config.field, so there is nothing for it to filter on.`);
      }
      return ok({
        kind: "filterSelect",
        config: {
          field,
          options: readSelectOptions(config),
          multiple: readBoolean(config, "multiple", "multi") ?? false,
          includeAllOption: readBoolean(config, "includeAllOption", "includeAll") ?? true,
        },
      });
    }

    case "filterSlider": {
      const field = readString(config, "field", "attribute", "property");
      if (!field) {
        return fail(`Range filter "${control.id}" has no config.field, so there is nothing for it to filter on.`);
      }
      const min = readNumber(config, "min", "minimum", "from");
      const max = readNumber(config, "max", "maximum", "to");
      if (min === undefined || max === undefined || !(max > min)) {
        return fail(
          `Range filter "${control.id}" needs a numeric config.min and config.max with max greater than min — a slider with no domain cannot be drawn.`,
        );
      }
      const rawOperator = (readString(config, "operator", "op", "comparison") ?? "").trim();
      const operator = rawOperator === "<=" || rawOperator === "=" ? rawOperator : ">=";
      return ok({
        kind: "filterSlider",
        config: { field, min, max, step: readNumber(config, "step") ?? niceStep(min, max), operator },
      });
    }

    case "filterDateRange": {
      const field = readString(config, "field", "dateField", "timeField", "attribute");
      if (!field) {
        return fail(`Date filter "${control.id}" has no config.field naming the date attribute to filter on.`);
      }
      const from = readIsoDate(config.from ?? config.start ?? config.min);
      const to = readIsoDate(config.to ?? config.end ?? config.max);
      return ok({
        kind: "filterDateRange",
        config: { field, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) },
      });
    }

    case "timeSlider": {
      const field = readString(config, "field", "timeField", "dateField");
      if (!field) {
        return fail(
          `Time slider "${control.id}" has no config.field naming the time attribute it ranges over. (A "time as a layer stack" stepper is the \`time\` WIDGET — see ../widgets/widget-config.ts.)`,
        );
      }
      const from = readIsoDate(config.from ?? config.start ?? config.min);
      const to = readIsoDate(config.to ?? config.end ?? config.max);
      if (!from || !to) {
        return fail(
          `Time slider "${control.id}" needs config.from and config.to (ISO dates) — the composition carries no field schema to infer a time extent from.`,
        );
      }
      const stepDays = Math.max(Math.trunc(readNumber(config, "stepDays", "step") ?? 1), 1);
      return ok({ kind: "timeSlider", config: { field, from, to, stepDays } });
    }

    case "search":
      /**
       * The one kind that reports unsupported unconditionally, and the reason
       * is a real gap rather than laziness. A search box needs a *provider*:
       * either a geocoder (which is an off-origin HTTP call — forbidden by
       * honua-studio#23's no-off-origin-request rule, enforced by a browser
       * test) or a feature-search endpoint. ADR-0031's `config` is open but
       * names no provider vocabulary, so a document cannot even declare which
       * one it wants; Studio would have to invent that vocabulary privately,
       * which is exactly the drift this repo has paid for before. Reported
       * with the specific missing piece so the upstream gap is legible.
       */
      return fail(
        `Search "${control.id}" cannot be rendered: no search provider is declared. ADR-0031's control config carries no provider vocabulary (geocoder endpoint vs. feature search over sourceId), and Studio will not invent one privately or call an off-origin geocoder. Upstream gap — geospatial-mcp needs a provider field before this kind can render.`,
      );
  }
}

function ok(config: CompositionControlConfig): ControlConfigResult<CompositionControlConfig> {
  return { ok: true, config };
}

function fail(reason: string): ControlConfigResult<CompositionControlConfig> {
  return { ok: false, reason };
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/** A step that divides the domain into a usable number of stops without inventing decimals the agent never asked for. */
function niceStep(min: number, max: number): number {
  const span = max - min;
  if (span <= 1) return span / 100;
  if (span <= 10) return 0.1;
  if (span <= 1000) return 1;
  return 10 ** (Math.floor(Math.log10(span)) - 2);
}

function readSelectOptions(config: Record<string, unknown>): readonly FilterSelectOption[] {
  const raw = config.options ?? config.values ?? config.choices;
  if (!Array.isArray(raw)) return [];
  const options: FilterSelectOption[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" || typeof entry === "number") {
      options.push({ value: String(entry), label: String(entry) });
      continue;
    }
    if (!isPlainObject(entry)) continue;
    const value = entry.value ?? entry.id ?? entry.key;
    if (typeof value !== "string" && typeof value !== "number") continue;
    options.push({ value: String(value), label: readString(entry, "label", "title", "name") ?? String(value) });
  }
  return options;
}

function readBasemapOptions(config: Record<string, unknown>): readonly BasemapOption[] {
  const raw = config.bases ?? config.basemaps ?? config.options;
  if (!Array.isArray(raw)) return [];
  const bases: BasemapOption[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) continue;
    const id = readString(entry, "id", "value", "key");
    if (!id) continue;
    const theme = (readString(entry, "theme", "mode") ?? "").toLowerCase();
    const kindRaw = (readString(entry, "kind", "type") ?? "").toLowerCase();
    bases.push({
      id,
      label: readString(entry, "label", "title", "name") ?? id,
      kind: kindRaw === "raster" ? "raster" : kindRaw.startsWith("raster-dem") ? "raster-dem-composite" : "vector",
      ...(theme === "dark" || theme === "light" ? { theme: theme as "light" | "dark" } : {}),
    });
  }
  return bases;
}

function readBookmarks(config: Record<string, unknown>, controlId: string): readonly BookmarkEntry[] {
  const raw = config.bookmarks ?? config.views ?? config.places;
  if (!Array.isArray(raw)) return [];
  const bookmarks: BookmarkEntry[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isPlainObject(entry)) continue;
    const source = isPlainObject(entry.view) ? entry.view : entry;
    const bbox = readNumberTuple(source.bbox ?? source.extent, 4);
    const center = readNumberTuple(source.center ?? source.coordinate, 2);
    const zoom = readNumber(source, "zoom");
    if (!bbox && !center) continue;
    const label = readString(entry, "label", "title", "name") ?? `View ${index + 1}`;
    bookmarks.push({
      id: readString(entry, "id") ?? `${controlId}-${index}`,
      label,
      view: {
        ...(bbox ? { bbox: bbox as readonly [number, number, number, number] } : {}),
        ...(center ? { center: center as readonly [number, number] } : {}),
        ...(zoom !== undefined ? { zoom } : {}),
        ...(readNumber(source, "pitch") !== undefined ? { pitch: readNumber(source, "pitch") as number } : {}),
        ...(readNumber(source, "bearing") !== undefined ? { bearing: readNumber(source, "bearing") as number } : {}),
      },
    });
  }
  return bookmarks;
}

function readNumberTuple(value: unknown, length: number): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length !== length) return undefined;
  const numbers = value.map((entry) => (typeof entry === "number" ? entry : Number(entry)));
  return numbers.every((entry) => Number.isFinite(entry)) ? numbers : undefined;
}

// ---------------------------------------------------------------------------
// Render-time reporting
// ---------------------------------------------------------------------------

/** How a control resolved against the composition it lives in. */
export type ControlStatus =
  /** Renders and behaves. */
  | { readonly state: "rendered"; readonly config: CompositionControlConfig; readonly note?: string }
  /** Renders nothing, for a stated reason (REQ-001's typed unsupported path). */
  | { readonly state: "unsupported"; readonly reason: string };

/**
 * Resolves one control against composition state: normalizes its config, then
 * checks the two things a config alone cannot know — whether its `sourceId`
 * resolves, and whether any interaction actually binds it.
 *
 * A change-emitting control with no binding is **not** an error: ADR-0031
 * calls an unbound control inert-by-design. It does get a `note`, because a
 * user dragging a slider deserves to know the composition has not wired it to
 * anything yet, and an agent reading the readout deserves the same.
 */
export function describeControl(state: CompositionState, control: CompositionControl): ControlStatus {
  const normalized = readControlConfig(control);
  if (!normalized.ok) return { state: "unsupported", reason: normalized.reason };

  if (control.sourceId !== undefined && !controlSourceResolves(state, control.sourceId)) {
    return {
      state: "unsupported",
      reason: `${CONTROL_KIND_LABELS[control.kind]} "${control.id}" reads from "${control.sourceId}", which is not a layer in this composition (nor a source any layer binds).`,
    };
  }

  if (normalized.config.kind === "opacity") {
    const missing = normalized.config.config.layerIds.filter(
      (layerId) => !state.layers.some((layer) => layer.id === layerId),
    );
    if (missing.length === normalized.config.config.layerIds.length) {
      return {
        state: "unsupported",
        reason: `Opacity "${control.id}" drives ${missing.map((id) => `"${id}"`).join(", ")}, which the composition does not hold.`,
      };
    }
  }

  if (!CONTROL_KIND_EMITS_CHANGE[control.kind]) return { state: "rendered", config: normalized.config };

  const bound = state.interactions.some(
    (interaction) => interaction.on.ref === `control:${control.id}` && interaction.disabled !== true,
  );
  return {
    state: "rendered",
    config: normalized.config,
    ...(bound ? {} : { note: "Emits change — no interaction binds it yet." }),
  };
}

/** ADR-0031's `sourceId` resolution rule, as honua-server#3196 implements it: a layer's own id, or the `sourceId` that layer binds. */
export function controlSourceResolves(state: CompositionState, sourceId: string): boolean {
  return state.layers.some((layer) => layer.id === sourceId || layer.sourceId === sourceId);
}

/** Composition layers a control's `sourceId` names — the set a filter clause scopes to. */
export function controlTargetLayers(state: CompositionState, sourceId: string | undefined): readonly string[] {
  if (!sourceId) return [];
  return state.layers.filter((layer) => layer.id === sourceId || layer.sourceId === sourceId).map((layer) => layer.id);
}
