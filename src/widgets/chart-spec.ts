/**
 * Composition chart widget -> Vega-Lite spec, **through the SDK's own
 * `chartWidgetToVegaLiteSpec`** (honua-studio#24 REQ-004).
 *
 * The requirement is not "produce a chart"; it is "reuse the SDK's existing
 * chart-spec conversion rather than growing a second chart model". So this
 * module does exactly one interesting thing: it projects a
 * {@link CompositionWidget} onto the SDK's `HonuaGeneratedAppChartWidget` and
 * hands it to `chartWidgetToVegaLiteSpec`. The returned
 * `HonuaVegaLiteChartSpec` is the contract every downstream consumer reads —
 * `./chart-data.ts` aggregates *from the spec's encoding*, and
 * `./chart-render.ts` draws *from the spec's mark*. Nothing downstream ever
 * reads the widget config again. That is what keeps Studio's charts and
 * Console's / MCP's / QGIS's charts the same chart: they share the spec, not
 * a screenshot.
 *
 * ## Two documented post-projections
 *
 * The published helper (`0.1.2-beta.0`) covers `categories` / `histogram` /
 * `time-series`, and its output is authoritative for all three. Two things
 * the *subset* declares but the *helper* never emits are applied here, both
 * staying strictly inside `HonuaVegaLiteChartSpec`:
 *
 *  1. **`pie` -> `mark.type: "arc"`.** `HonuaChartMark` includes `"arc"`, but
 *     `CHART_KIND_MARK` has no chart kind that produces it. A pie is a
 *     categories chart drawn as arcs, so it is projected as `categories` and
 *     re-marked. Worth contributing upstream as a `chartKind` (see REQ-006);
 *     until then this is one field, not a fork.
 *  2. **A non-count measure on a categorical chart.** The helper hardcodes
 *     `y: count` for `categories` and only honors `widget.metric` for
 *     `time-series`. "Chart total acreage by district" is a perfectly ordinary
 *     request, so the `y` channel is replaced with the measure's own
 *     `HonuaChartEncodingChannel` — the same shape the helper builds for a
 *     time series. Also upstream-worthy.
 *
 * A third, cosmetic one: the helper sets the categorical `x.title` to the
 * *widget* title, which then renders as an axis label duplicating the chart
 * heading. When they are identical the axis title is dropped so it falls back
 * to the field name.
 *
 * Everything here is pure — no DOM, no fetch — so it is testable in
 * `environment: "node"` like `../map/map-package-projection.ts`.
 *
 * @module
 */

import type { HonuaGeneratedAppChartWidget } from "@honua/sdk-js/generated-app";
import {
  type HonuaChartEncodingChannel,
  type HonuaVegaLiteChartSpec,
  chartWidgetToVegaLiteSpec,
} from "@honua/sdk-js/studio";

import type { CompositionWidget } from "../composition/model.js";
import { type CompositionChartConfig, type CompositionMeasure, readChartConfig } from "./widget-config.js";

export type { HonuaVegaLiteChartSpec };

/** Either a spec, or the reason this widget cannot become one. */
export type ChartSpecResult =
  | { readonly ok: true; readonly spec: HonuaVegaLiteChartSpec; readonly config: CompositionChartConfig }
  | { readonly ok: false; readonly reason: string };

/** SDK `AggregationMetric` function names, as `chartWidgetToVegaLiteSpec` consumes them. */
function measureToSdkFn(measure: CompositionMeasure): string {
  return measure.fn === "avg" ? "mean" : measure.fn;
}

/** Vega-Lite aggregate op for a measure — the same mapping the SDK's `metricToAggregate` applies. */
function measureToAggregate(measure: CompositionMeasure): HonuaChartEncodingChannel["aggregate"] {
  switch (measure.fn) {
    case "sum":
      return "sum";
    case "avg":
      return "mean";
    case "min":
      return "min";
    case "max":
      return "max";
    case "median":
      return "median";
    default:
      return "count";
  }
}

/** The `y` channel a measured chart wants: the measure's field, aggregated. */
function measureChannel(measure: CompositionMeasure): HonuaChartEncodingChannel {
  const aggregate = measureToAggregate(measure);
  const field = measure.field === "*" ? "count" : measure.field;
  return {
    field,
    type: "quantitative",
    aggregate,
    title: measure.alias ?? (aggregate === "count" ? "Count" : `${aggregate}(${field})`),
  };
}

/**
 * Projects a normalized composition chart config onto the SDK's
 * generated-app chart widget — the input `chartWidgetToVegaLiteSpec` takes.
 * A `pie` is projected as `categories`; the arc mark is applied afterwards.
 */
export function compositionChartToGeneratedAppWidget(
  widget: CompositionWidget,
  config: CompositionChartConfig,
): HonuaGeneratedAppChartWidget {
  const chartKind = config.field !== undefined ? "histogram" : config.temporal ? "time-series" : "categories";
  return {
    id: widget.id,
    kind: "chart",
    chartKind,
    ...(widget.title !== undefined ? { title: widget.title } : {}),
    ...(widget.sourceId !== undefined ? { sourceId: widget.sourceId } : {}),
    ...(config.groupBy !== undefined ? { groupBy: config.groupBy } : {}),
    // The SDK reads `field` as the histogram/time axis; a categorical chart
    // leaves it unset and uses `groupBy`.
    ...(config.field !== undefined ? { field: config.field } : {}),
    ...(config.temporal && config.groupBy !== undefined ? { field: config.groupBy } : {}),
    ...(config.bins !== undefined ? { bins: config.bins } : {}),
    ...(config.measure.fn !== "count"
      ? { metric: { fn: measureToSdkFn(config.measure), field: config.measure.field } }
      : {}),
  } as HonuaGeneratedAppChartWidget;
}

/**
 * The whole REQ-004 path: composition widget in, SDK-derived Vega-Lite spec
 * out, no hand-authored spec anywhere. `rows` become the spec's inline
 * `data.values`, exactly as the SDK's subset documents.
 */
export function compositionChartSpec(
  widget: CompositionWidget,
  rows?: ReadonlyArray<Record<string, unknown>>,
): ChartSpecResult {
  const normalized = readChartConfig(widget);
  if (!normalized.ok) return { ok: false, reason: normalized.reason };
  const config = normalized.config;

  const sdkWidget = compositionChartToGeneratedAppWidget(widget, config);
  const base = chartWidgetToVegaLiteSpec(sdkWidget, rows);
  if (!base) {
    return {
      ok: false,
      reason: `Chart "${widget.id}" does not carry the field its "${sdkWidget.chartKind}" encoding needs.`,
    };
  }

  return { ok: true, spec: applyPostProjections(base, config), config };
}

/** The three documented adjustments described in this module's doc. Kept in one place so "what we changed about the SDK's output" is a single readable function. */
function applyPostProjections(spec: HonuaVegaLiteChartSpec, config: CompositionChartConfig): HonuaVegaLiteChartSpec {
  const isCategorical = spec.encoding.x?.type === "nominal" || spec.encoding.x?.type === "ordinal";
  const encoding: Record<string, HonuaChartEncodingChannel | undefined> = { ...spec.encoding };

  // (2) A measured categorical chart: the helper only honors `metric` for
  // time series, so give the y channel the measure it was asked for.
  if (isCategorical && config.measure.fn !== "count") {
    encoding.y = measureChannel(config.measure);
  }

  // (3) Cosmetic: drop an axis title that merely repeats the chart heading.
  const x = encoding.x;
  if (x && spec.title !== undefined && x.title === spec.title) {
    const { title: _dropped, ...rest } = x;
    encoding.x = rest;
  }

  // (1) A pie is a categories chart drawn as arcs, with the category moved to
  // the colour channel. Vega-Lite proper would put the magnitude on `theta`,
  // but `HonuaChartEncoding` bounds itself to `x`/`y`/`color`, so the
  // quantitative channel stays `y`. That is a limitation of the documented
  // subset, not of this projection — widening it to `theta` is part of the
  // upstream contribution REQ-006 records.
  if (config.chartType === "pie") {
    const category = encoding.x;
    return {
      ...spec,
      mark: { type: "arc", tooltip: true },
      encoding: {
        ...(encoding.y !== undefined ? { y: encoding.y } : {}),
        ...(category !== undefined ? { color: category } : {}),
      },
    };
  }

  if (config.chartType === "line" && typeof spec.mark === "object" && spec.mark.type !== "line") {
    return { ...spec, mark: { ...spec.mark, type: "line" }, encoding: encoding as HonuaVegaLiteChartSpec["encoding"] };
  }

  return { ...spec, encoding: encoding as HonuaVegaLiteChartSpec["encoding"] };
}
