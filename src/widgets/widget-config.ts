/**
 * `CompositionWidget.config` -> typed, per-kind view models
 * (honua-studio#24 REQ-001).
 *
 * A widget's `config` is deliberately free-form in composition state: the
 * reducer validates `id`/`kind`/`sourceId` and otherwise treats `config` as
 * an opaque bag, because the composition model is a projection of a Studio
 * package draft rather than a renderer configuration (see
 * `../composition/model.ts`'s AD-8 note, and `../mcp/tool-bridge.ts`'s
 * `add_chart` mapping, which stashes `{ groupBy, chartType }` there
 * untouched). Something has to close the gap between "the agent asked for a
 * chart of parcels by zoning code" and "this surface needs a mark, an
 * encoding, and a measure", and that something is this module.
 *
 * Three properties are load-bearing:
 *
 *  - **Pure and total.** Every reader takes `unknown`-ish input and returns a
 *    normalized value or a `reason`. Nothing throws, because one malformed
 *    widget must not take the whole deck down — the same tolerance
 *    `../map/source-resolution.ts` applies to an unrenderable layer.
 *  - **Defaults are defensible, not clever.** An agent that says only
 *    "chart, groupBy zoning_code" gets a counted bar chart, because that is
 *    what the phrase means; it does not get an error asking it to author a
 *    Vega-Lite spec (REQ-004).
 *  - **Generous about spelling.** A model may write `chartType: "column"`,
 *    `"donut"`, or `"time-series"`. Rejecting a chart because it said
 *    "column" instead of "bar" would be an avoidable, infuriating failure —
 *    the same argument `layerTypeForGeometry` makes about `"polyline"`.
 *
 * @module
 */

import type { CompositionWidget } from "../composition/model.js";

/** The chart archetypes the bounded renderer draws (REQ-004's "bar/line/pie"). */
export type CompositionChartType = "bar" | "line" | "pie";

/** Aggregations a measure may apply. Mirrors the SDK's `AggregationMetric` function names. */
export type CompositionMeasureFn = "count" | "sum" | "avg" | "min" | "max" | "median";

export interface CompositionMeasure {
  readonly fn: CompositionMeasureFn;
  /** `"*"` means "the rows themselves" — a count. */
  readonly field: string;
  readonly alias?: string;
}

/** A chart widget's normalized intent: what to group by, what to measure, and how to draw it. */
export interface CompositionChartConfig {
  readonly chartType: CompositionChartType;
  /** The category / time axis. Absent for a histogram, which bins `field` instead. */
  readonly groupBy?: string;
  /** The numeric field a histogram bins. */
  readonly field?: string;
  readonly bins?: number;
  readonly measure: CompositionMeasure;
  /** True when `groupBy` is a date/time axis — drives the temporal encoding. */
  readonly temporal: boolean;
}

/** A data-grid widget's normalized intent. */
export interface CompositionTableConfig {
  /** Explicit column order. Empty means "infer from the first rows". */
  readonly fields: readonly string[];
  readonly pageSize: number;
  /** Property to use as the feature id when the feature itself carries none. */
  readonly primaryKey?: string;
}

/** A layer-list widget's normalized intent. */
export interface CompositionTocConfig {
  /** Restricts the list to these layer ids, in this order. Empty means "every layer, in composition order". */
  readonly layerIds: readonly string[];
  /** When false, layers the map could not resolve are omitted rather than flagged. Default true. */
  readonly showUnrenderable: boolean;
}

/** A legend widget's normalized intent. */
export interface CompositionLegendConfig {
  readonly layerIds: readonly string[];
  /** When true, hidden layers are listed greyed rather than omitted. Default false. */
  readonly includeHidden: boolean;
}

/** A comparison widget's normalized intent: two layers and a three-way A / both / B switch. */
export interface CompositionCompareConfig {
  readonly left: string;
  readonly right: string;
  readonly leftLabel?: string;
  readonly rightLabel?: string;
}

/** One step on a time widget's slider: a label and the layer that step shows. */
export interface CompositionTimeStep {
  readonly label: string;
  readonly layerId: string;
}

/** A time widget's normalized intent. */
export interface CompositionTimeConfig {
  readonly steps: readonly CompositionTimeStep[];
  /** Field a future field-based temporal filter would bind to. Carried through, never acted on — see {@link readTimeConfig}. */
  readonly field?: string;
}

/** Either a normalized config, or the reason the widget cannot be rendered as authored. */
export type WidgetConfigResult<T> =
  | { readonly ok: true; readonly config: T }
  | { readonly ok: false; readonly reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function configOf(widget: CompositionWidget): Record<string, unknown> {
  return isPlainObject(widget.config) ? widget.config : {};
}

function readString(source: Record<string, unknown>, ...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0) return value;
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

function readPositiveInt(source: Record<string, unknown>, ...names: readonly string[]): number | undefined {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return undefined;
}

function readBoolean(source: Record<string, unknown>, name: string): boolean | undefined {
  const value = source[name];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Chart-type spelling normalization. `column`/`bar`/`histogram` all draw
 * bars; `pie`/`donut`/`doughnut` all draw arcs; `line`/`area`/`time-series`
 * all draw a line. Anything unrecognized falls back to `bar` rather than
 * failing — a chart drawn the wrong way is recoverable by the next
 * utterance; a chart that refuses to draw is not.
 */
export function normalizeChartType(value: string | undefined): CompositionChartType {
  const normalized = (value ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (normalized === "pie" || normalized === "donut" || normalized === "doughnut" || normalized === "arc") return "pie";
  if (normalized === "line" || normalized === "area" || normalized === "timeseries" || normalized === "trend") {
    return "line";
  }
  return "bar";
}

function normalizeMeasureFn(value: string | undefined): CompositionMeasureFn {
  const normalized = (value ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (normalized === "sum" || normalized === "total") return "sum";
  if (normalized === "avg" || normalized === "average" || normalized === "mean") return "avg";
  if (normalized === "min") return "min";
  if (normalized === "max") return "max";
  if (normalized === "median") return "median";
  return "count";
}

/**
 * Reads a measure from any of the shapes an agent (or the MCP bridge) might
 * produce: a nested `measure`/`metric` object, or the flattened
 * `measureFn` + `measureField` pair. Defaults to a count, which is the
 * measure a bare "chart X by Y" asks for.
 */
function readMeasure(config: Record<string, unknown>): CompositionMeasure {
  const nested = isPlainObject(config.measure)
    ? config.measure
    : isPlainObject(config.metric)
      ? config.metric
      : undefined;
  const fn = normalizeMeasureFn(
    nested ? readString(nested, "fn", "function", "aggregate", "metric") : readString(config, "measureFn", "aggregate"),
  );
  const field =
    (nested ? readString(nested, "field", "on", "column") : readString(config, "measureField", "measureOn")) ?? "*";
  const alias = nested ? readString(nested, "alias", "title", "label") : readString(config, "measureAlias");
  // A named aggregation over no field cannot mean anything but a count.
  const effectiveFn: CompositionMeasureFn = field === "*" && fn !== "count" ? "count" : fn;
  return { fn: effectiveFn, field, ...(alias !== undefined ? { alias } : {}) };
}

/**
 * Whether a `groupBy` names a time axis. Heuristic on purpose: composition
 * state carries no field schema (it holds a `sourceId`, not a catalog
 * record), and `chartType: "line"` over a field called `year` is
 * overwhelmingly a time series. A wrong guess costs an axis label, not a
 * render.
 */
function looksTemporal(field: string | undefined, chartType: CompositionChartType): boolean {
  if (!field) return false;
  if (/date|time|year|month|day|timestamp|ts$|_at$/i.test(field)) return true;
  return chartType === "line";
}

/** Normalizes a `chart` widget. Fails only when there is nothing at all to plot against. */
export function readChartConfig(widget: CompositionWidget): WidgetConfigResult<CompositionChartConfig> {
  const config = configOf(widget);
  const chartType = normalizeChartType(readString(config, "chartType", "chartKind", "type", "mark"));
  const groupBy = readString(config, "groupBy", "categoryField", "category", "by", "x", "field");
  const histogramField = readString(config, "binField", "histogramField");
  const bins = readPositiveInt(config, "bins", "maxbins");
  const measure = readMeasure(config);

  // A histogram is the one encoding with no category axis: it bins a numeric
  // field. It is requested either explicitly (`binField`/`bins`) or by
  // spelling the chart type "histogram".
  const explicitHistogram =
    histogramField !== undefined ||
    (bins !== undefined && /hist/i.test(readString(config, "chartType", "chartKind", "type") ?? ""));
  if (explicitHistogram) {
    const field = histogramField ?? groupBy;
    if (!field) {
      return { ok: false, reason: `Chart "${widget.id}" asks for a histogram but names no field to bin.` };
    }
    return {
      ok: true,
      config: {
        chartType: "bar",
        field,
        ...(bins !== undefined ? { bins } : {}),
        measure,
        temporal: false,
      },
    };
  }

  if (!groupBy) {
    return {
      ok: false,
      reason: `Chart "${widget.id}" has no "groupBy" (nor a field to bin), so there is nothing to plot against.`,
    };
  }
  return {
    ok: true,
    config: {
      chartType,
      groupBy,
      ...(bins !== undefined ? { bins } : {}),
      measure,
      temporal: looksTemporal(groupBy, chartType),
    },
  };
}

/** Rows a grid shows before paging. Bounded by default (#1 REQ-005) — a 50 000-row table is a browser hang, not a feature. */
const DEFAULT_TABLE_PAGE_SIZE = 25;
const MAX_TABLE_PAGE_SIZE = 200;

/** Normalizes a `table` widget. Always succeeds — a grid with no declared columns infers them from the data. */
export function readTableConfig(widget: CompositionWidget): WidgetConfigResult<CompositionTableConfig> {
  const config = configOf(widget);
  const pageSize = Math.min(
    readPositiveInt(config, "pageSize", "limit", "rows") ?? DEFAULT_TABLE_PAGE_SIZE,
    MAX_TABLE_PAGE_SIZE,
  );
  const primaryKey = readString(config, "primaryKey", "idField", "objectIdField");
  return {
    ok: true,
    config: {
      fields: readStringArray(config, "fields", "columns", "tableFields"),
      pageSize,
      ...(primaryKey !== undefined ? { primaryKey } : {}),
    },
  };
}

/** Normalizes a `toc` widget. Always succeeds — a TOC with no config is the common (and intended) case: "add a layer list". */
export function readTocConfig(widget: CompositionWidget): WidgetConfigResult<CompositionTocConfig> {
  const config = configOf(widget);
  return {
    ok: true,
    config: {
      layerIds: readStringArray(config, "layerIds", "layers"),
      showUnrenderable: readBoolean(config, "showUnrenderable") ?? true,
    },
  };
}

/** Normalizes a `legend` widget. Always succeeds. */
export function readLegendConfig(widget: CompositionWidget): WidgetConfigResult<CompositionLegendConfig> {
  const config = configOf(widget);
  return {
    ok: true,
    config: {
      layerIds: readStringArray(config, "layerIds", "layers"),
      includeHidden: readBoolean(config, "includeHidden") ?? false,
    },
  };
}

/** Normalizes a `compare` widget. Needs two layer ids — a comparison of one thing is not a comparison. */
export function readCompareConfig(widget: CompositionWidget): WidgetConfigResult<CompositionCompareConfig> {
  const config = configOf(widget);
  const pair = readStringArray(config, "layerIds", "layers");
  const left = readString(config, "left", "leftLayerId", "a") ?? pair[0];
  const right = readString(config, "right", "rightLayerId", "b") ?? pair[1];
  if (!left || !right) {
    return {
      ok: false,
      reason: `Compare "${widget.id}" needs two layers — set config.left and config.right (or config.layerIds).`,
    };
  }
  const leftLabel = readString(config, "leftLabel");
  const rightLabel = readString(config, "rightLabel");
  return {
    ok: true,
    config: {
      left,
      right,
      ...(leftLabel !== undefined ? { leftLabel } : {}),
      ...(rightLabel !== undefined ? { rightLabel } : {}),
    },
  };
}

/**
 * Normalizes a `time` widget.
 *
 * The honest scope note, and the reason this reader is shaped the way it is:
 * **composition state has no filter vocabulary**. There is no `setFilter`
 * command (the SDK's agent-tool surface has one; this engine's bounded set
 * does not — see `../composition/commands.ts`), so a slider bound to a
 * feature *attribute* would have nothing to write to and would be pure
 * chrome theater — a control that moves and changes nothing.
 *
 * What the vocabulary *does* support is visibility, so the supported form is
 * a step list over layers (`config.steps: [{ label, layerId }]`) — the
 * "time as a layer stack" pattern, which is how a composed offline map
 * actually carries time. Moving the slider is a `setVisibility` through the
 * same reducer as everything else.
 *
 * A field-based config is **reported, not silently accepted**: it returns a
 * reason naming the missing capability, the same way an unrenderable layer
 * is reported rather than dropped. honua-studio#24 REQ-006 flags a temporal
 * filter verb as the upstream (geospatial-mcp) gap this depends on.
 */
export function readTimeConfig(widget: CompositionWidget): WidgetConfigResult<CompositionTimeConfig> {
  const config = configOf(widget);
  const rawSteps = Array.isArray(config.steps) ? config.steps : [];
  const steps: CompositionTimeStep[] = [];
  for (const entry of rawSteps) {
    if (!isPlainObject(entry)) continue;
    const layerId = readString(entry, "layerId", "layer", "id");
    if (!layerId) continue;
    steps.push({ label: readString(entry, "label", "title", "time") ?? layerId, layerId });
  }
  const field = readString(config, "field", "timeField", "dateField");
  if (steps.length === 0) {
    return {
      ok: false,
      reason: field
        ? `Time "${widget.id}" filters on "${field}", but the composition vocabulary has no filter command yet — author it as config.steps: [{ label, layerId }] to drive layer visibility instead.`
        : `Time "${widget.id}" has no config.steps: [{ label, layerId }] to step through.`,
    };
  }
  return { ok: true, config: { steps, ...(field !== undefined ? { field } : {}) } };
}
