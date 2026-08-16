/**
 * Rows + a Vega-Lite spec -> the points a mark draws (honua-studio#24
 * REQ-004).
 *
 * This module reads the **spec**, never the widget config. That is the point
 * of REQ-004's "keep the spec conversion as the contract": if the aggregation
 * were driven by `widget.config` it would be a second, parallel chart model
 * that could disagree with the spec other surfaces render, and the shared
 * vocabulary would be decorative. Everything below — the category field, the
 * aggregate op, the bin flag, the axis titles — comes out of
 * `spec.encoding`, which is what a real Vega renderer would read too.
 *
 * The supported slice is exactly the SDK subset's slice: one positional pair
 * (or a colour category, for an arc), one aggregate op, optional binning.
 * A spec outside that slice returns an empty point list with a reason rather
 * than a wrong chart.
 *
 * Pure, DOM-free, node-testable.
 *
 * @module
 */

import type { HonuaChartEncodingChannel, HonuaVegaLiteChartSpec } from "@honua/sdk-js/studio";

/** One drawable datum: a category (or bin/instant) and its aggregated magnitude. */
export interface ChartPoint {
  readonly label: string;
  readonly value: number;
  /** Sort key — the raw category value, or the bin/time start. Keeps temporal and binned axes in numeric order. */
  readonly order: number | string;
}

export interface ChartSeries {
  readonly points: readonly ChartPoint[];
  readonly categoryTitle: string;
  readonly valueTitle: string;
  /** Rows that carried no usable category value, and were therefore not plotted. Reported, never silently dropped. */
  readonly skippedRows: number;
  readonly reason?: string;
}

const EMPTY_SERIES: ChartSeries = { points: [], categoryTitle: "", valueTitle: "", skippedRows: 0 };

/** Bins a histogram gets when the spec says `bin: true` without a `maxbins`. Vega-Lite's own default is 10. */
const DEFAULT_MAXBINS = 10;

/** How many categories a bounded chart draws before the rest are folded into one "Other" slice/bar. */
const MAX_CATEGORIES = 24;

function channelTitle(channel: HonuaChartEncodingChannel | undefined, fallback: string): string {
  return channel?.title ?? channel?.field ?? fallback;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function toTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  return undefined;
}

function aggregate(op: HonuaChartEncodingChannel["aggregate"], values: readonly number[], count: number): number {
  switch (op) {
    case "sum":
      return values.reduce((total, value) => total + value, 0);
    case "mean":
      return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
    case "min":
      return values.length === 0 ? 0 : Math.min(...values);
    case "max":
      return values.length === 0 ? 0 : Math.max(...values);
    case "median": {
      if (values.length === 0) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
    }
    default:
      return count;
  }
}

/** The channel carrying the category: `x` for bar/line, `color` for an arc (see `./chart-spec.ts`'s pie projection). */
function categoryChannel(spec: HonuaVegaLiteChartSpec): HonuaChartEncodingChannel | undefined {
  const x = spec.encoding.x;
  if (x && x.type !== "quantitative") return x;
  if (x?.bin) return x;
  return spec.encoding.color ?? x;
}

function formatBinLabel(start: number, end: number): string {
  const round = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(2));
  return `${round(start)}–${round(end)}`;
}

function formatTemporal(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? String(timestamp) : (date.toISOString().slice(0, 10) ?? String(timestamp));
}

/**
 * Aggregates `rows` into the points `spec`'s mark draws. `rows` defaults to
 * the spec's own inline `data.values`, so a spec that already carries its
 * data is self-contained — the shape a host handing the spec to `vega-embed`
 * would also rely on.
 */
export function chartSeriesFromSpec(
  spec: HonuaVegaLiteChartSpec,
  rows?: ReadonlyArray<Record<string, unknown>>,
): ChartSeries {
  const data = rows ?? spec.data?.values ?? [];
  const category = categoryChannel(spec);
  const value = spec.encoding.y;
  if (!category?.field) {
    return { ...EMPTY_SERIES, reason: "The chart spec has no category encoding to group rows by." };
  }
  const categoryTitle = channelTitle(category, category.field);
  const valueTitle = channelTitle(value, "Count");
  if (data.length === 0) return { ...EMPTY_SERIES, categoryTitle, valueTitle };

  return category.bin
    ? binnedSeries(data, category, value, categoryTitle, valueTitle)
    : groupedSeries(data, category, value, categoryTitle, valueTitle);
}

/** `bin: true` / `bin: { maxbins }` — equal-width buckets over a numeric field. */
function binnedSeries(
  rows: ReadonlyArray<Record<string, unknown>>,
  category: HonuaChartEncodingChannel,
  value: HonuaChartEncodingChannel | undefined,
  categoryTitle: string,
  valueTitle: string,
): ChartSeries {
  const field = category.field;
  const maxbins = (typeof category.bin === "object" ? category.bin.maxbins : undefined) ?? DEFAULT_MAXBINS;
  const numbers: { readonly bucketValue: number; readonly measured: number | undefined }[] = [];
  let skippedRows = 0;
  for (const row of rows) {
    const bucketValue = toNumber(row[field]);
    if (bucketValue === undefined) {
      skippedRows += 1;
      continue;
    }
    numbers.push({ bucketValue, measured: value?.field ? toNumber(row[value.field]) : undefined });
  }
  if (numbers.length === 0) return { points: [], categoryTitle, valueTitle, skippedRows };

  const min = Math.min(...numbers.map((entry) => entry.bucketValue));
  const max = Math.max(...numbers.map((entry) => entry.bucketValue));
  const width = max === min ? 1 : (max - min) / maxbins;
  const buckets = new Map<number, { values: number[]; count: number }>();
  for (const entry of numbers) {
    const index = max === min ? 0 : Math.min(Math.floor((entry.bucketValue - min) / width), maxbins - 1);
    const bucket = buckets.get(index) ?? { values: [], count: 0 };
    bucket.count += 1;
    if (entry.measured !== undefined) bucket.values.push(entry.measured);
    buckets.set(index, bucket);
  }

  const points = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, bucket]) => ({
      label: formatBinLabel(min + index * width, min + (index + 1) * width),
      value: aggregate(value?.aggregate, bucket.values, bucket.count),
      order: min + index * width,
    }));
  return { points, categoryTitle, valueTitle, skippedRows };
}

/** Nominal / ordinal / temporal grouping — one point per distinct category value. */
function groupedSeries(
  rows: ReadonlyArray<Record<string, unknown>>,
  category: HonuaChartEncodingChannel,
  value: HonuaChartEncodingChannel | undefined,
  categoryTitle: string,
  valueTitle: string,
): ChartSeries {
  const field = category.field;
  const temporal = category.type === "temporal";
  const groups = new Map<string, { values: number[]; count: number; order: number | string }>();
  let skippedRows = 0;

  for (const row of rows) {
    const raw = row[field];
    if (raw === undefined || raw === null || raw === "") {
      skippedRows += 1;
      continue;
    }
    const timestamp = temporal ? toTimestamp(raw) : undefined;
    if (temporal && timestamp === undefined) {
      skippedRows += 1;
      continue;
    }
    const label = temporal && timestamp !== undefined ? formatTemporal(timestamp) : String(raw);
    const group = groups.get(label) ?? { values: [], count: 0, order: timestamp ?? label };
    group.count += 1;
    if (value?.field) {
      const measured = toNumber(row[value.field]);
      if (measured !== undefined) group.values.push(measured);
    }
    groups.set(label, group);
  }

  const points = [...groups.entries()].map(([label, group]) => ({
    label,
    value: aggregate(value?.aggregate, group.values, group.count),
    order: group.order,
  }));

  // Temporal axes read in time order; categorical ones read biggest-first,
  // which is what makes a bar chart of "counts by district" legible.
  points.sort((a, b) =>
    temporal ? Number(a.order) - Number(b.order) : b.value - a.value || String(a.label).localeCompare(String(b.label)),
  );

  return { points: boundCategories(points, temporal), categoryTitle, valueTitle, skippedRows };
}

/**
 * Folds a long categorical tail into one "Other" point. A chart with 900
 * bars is not a chart; a chart that silently shows only the first 24 is a
 * lie. "Other" is the honest third option, and temporal series are exempt
 * because collapsing time would be meaningless.
 */
function boundCategories(points: readonly ChartPoint[], temporal: boolean): readonly ChartPoint[] {
  if (temporal || points.length <= MAX_CATEGORIES) return points;
  const head = points.slice(0, MAX_CATEGORIES - 1);
  const tail = points.slice(MAX_CATEGORIES - 1);
  const total = tail.reduce((sum, point) => sum + point.value, 0);
  return [...head, { label: `Other (${tail.length})`, value: total, order: "￿" }];
}
