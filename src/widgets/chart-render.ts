/**
 * A bounded, dependency-free SVG renderer for the mark types the SDK's
 * documented Vega-Lite subset declares (honua-studio#24 REQ-004).
 *
 * ## Why not Vega
 *
 * REQ-004 allows exactly this trade, and the numbers make the choice for us:
 * `vega-embed` + `vega-lite` + `vega` is roughly 1.2 MB minified — larger
 * than MapLibre, which this app already treats as heavy enough to lazy-load
 * behind a dynamic import and a WebGL probe. Studio's charts render four
 * marks over a single positional pair; paying a megabyte for a general
 * grammar-of-graphics compiler to draw a bar chart would be a poor deal, and
 * it would land in a bundle whose weight this repo already watches.
 *
 * **The spec conversion stays the contract regardless.** This renderer's
 * input is a `HonuaVegaLiteChartSpec` (via `./chart-data.ts`, which reads
 * only `spec.encoding`), so nothing here is a second chart model — it is one
 * consumer of the shared spec, and a deployment that wants full Vega can
 * hand the *same* spec object to `vega-embed` without translation. What is
 * bounded is the *renderer*, not the vocabulary.
 *
 * ## What it draws
 *
 * `bar` (vertical bars), `line` (polyline with vertices), `arc` (pie).
 * Output is a plain SVG string with a `viewBox`, so it scales to whatever
 * the widget card gives it, and it is pure — no DOM, no measurement, no
 * layout thrash — which is what makes it snapshot-testable in
 * `environment: "node"` alongside the projection.
 *
 * Accessibility: every chart carries `role="img"` plus a `<title>`/`<desc>`
 * pair naming the series and its top values, and the widget card renders a
 * text summary beside it. A chart nobody can read is not a rendered chart.
 *
 * @module
 */

import type { HonuaVegaLiteChartSpec } from "@honua/sdk-js/studio";

import { paletteColorFor } from "../composition/palette.js";
import type { ChartPoint, ChartSeries } from "./chart-data.js";

/** Nominal drawing surface. Everything is expressed in these units and scaled by the `viewBox`. */
const WIDTH = 320;
const HEIGHT = 180;
const PAD_LEFT = 40;
const PAD_RIGHT = 8;
const PAD_TOP = 12;
const PAD_BOTTOM = 30;

const PLOT_WIDTH = WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_HEIGHT = HEIGHT - PAD_TOP - PAD_BOTTOM;

/** Longest category label drawn under an axis before it is elided. */
const MAX_LABEL_CHARS = 9;

export interface ChartRenderResult {
  readonly svg: string;
  /** Plain-text equivalent — the chart's accessible summary and what the widget card shows when there is nothing to draw. */
  readonly summary: string;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Formats a magnitude for an axis tick or a data label: compact, never more precision than the value carries. */
export function formatValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000) return `${round(value / 1_000_000)}M`;
  if (magnitude >= 1_000) return `${round(value / 1_000)}k`;
  return Number.isInteger(value) ? String(value) : String(round(value));
}

function elide(label: string): string {
  return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label;
}

/** The mark a spec asks for, normalized past the `string | { type }` union. */
export function specMark(spec: HonuaVegaLiteChartSpec): string {
  return typeof spec.mark === "string" ? spec.mark : spec.mark.type;
}

function summarize(series: ChartSeries, mark: string): string {
  if (series.points.length === 0) return "No rows matched this chart's grouping.";
  const top = series.points
    .slice(0, 3)
    .map((point) => `${point.label} ${formatValue(point.value)}`)
    .join(", ");
  const skipped = series.skippedRows > 0 ? `; ${series.skippedRows} row(s) had no value` : "";
  return `${mark} chart of ${series.valueTitle} by ${series.categoryTitle}: ${series.points.length} categories, top ${top}${skipped}.`;
}

function frame(body: string, title: string, summary: string): string {
  return `<svg class="widget-chart-svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeXml(summary)}" xmlns="http://www.w3.org/2000/svg"><title>${escapeXml(title)}</title><desc>${escapeXml(summary)}</desc>${body}</svg>`;
}

/** Nice-ish upper bound for a value axis, so the top gridline is a readable number rather than the raw max. */
function axisMax(max: number): number {
  if (max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= max) return candidate;
  }
  return max;
}

function valueAxis(max: number): string {
  const ticks = [0, max / 2, max];
  return ticks
    .map((tick) => {
      const y = PAD_TOP + PLOT_HEIGHT - (tick / max) * PLOT_HEIGHT;
      return `<line class="widget-chart-grid" x1="${PAD_LEFT}" y1="${round(y)}" x2="${WIDTH - PAD_RIGHT}" y2="${round(y)}" /><text class="widget-chart-tick" x="${PAD_LEFT - 4}" y="${round(y + 3)}" text-anchor="end">${escapeXml(formatValue(tick))}</text>`;
    })
    .join("");
}

/**
 * Draws category labels under a positional axis, thinning them when there
 * are more categories than can be legibly labelled. Every bar keeps its
 * `<title>` tooltip regardless, so a thinned label never means lost data.
 */
function categoryAxis(points: readonly ChartPoint[], centerFor: (index: number) => number): string {
  const stride = Math.ceil(points.length / 8);
  return points
    .map((point, index) =>
      index % stride === 0
        ? `<text class="widget-chart-label" x="${round(centerFor(index))}" y="${HEIGHT - PAD_BOTTOM + 12}" text-anchor="middle">${escapeXml(elide(point.label))}</text>`
        : "",
    )
    .join("");
}

function renderBars(series: ChartSeries, color: string): string {
  const max = axisMax(Math.max(...series.points.map((point) => point.value), 0));
  const slot = PLOT_WIDTH / series.points.length;
  const barWidth = Math.max(slot * 0.7, 1);
  const centerFor = (index: number): number => PAD_LEFT + slot * (index + 0.5);
  const bars = series.points
    .map((point, index) => {
      const height = Math.max((point.value / max) * PLOT_HEIGHT, point.value > 0 ? 1 : 0);
      const x = centerFor(index) - barWidth / 2;
      const y = PAD_TOP + PLOT_HEIGHT - height;
      return `<rect class="widget-chart-bar" x="${round(x)}" y="${round(y)}" width="${round(barWidth)}" height="${round(height)}" fill="${color}"><title>${escapeXml(`${point.label}: ${formatValue(point.value)}`)}</title></rect>`;
    })
    .join("");
  return `${valueAxis(max)}${bars}${categoryAxis(series.points, centerFor)}`;
}

function renderLine(series: ChartSeries, color: string): string {
  const max = axisMax(Math.max(...series.points.map((point) => point.value), 0));
  const step = series.points.length > 1 ? PLOT_WIDTH / (series.points.length - 1) : 0;
  const centerFor = (index: number): number =>
    series.points.length > 1 ? PAD_LEFT + step * index : PAD_LEFT + PLOT_WIDTH / 2;
  const coordinates = series.points.map((point, index) => ({
    x: centerFor(index),
    y: PAD_TOP + PLOT_HEIGHT - (point.value / max) * PLOT_HEIGHT,
    point,
  }));
  const path = coordinates.map(({ x, y }) => `${round(x)},${round(y)}`).join(" ");
  const vertices = coordinates
    .map(
      ({ x, y, point }) =>
        `<circle class="widget-chart-vertex" cx="${round(x)}" cy="${round(y)}" r="2.5" fill="${color}"><title>${escapeXml(`${point.label}: ${formatValue(point.value)}`)}</title></circle>`,
    )
    .join("");
  return `${valueAxis(max)}<polyline class="widget-chart-line" points="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />${vertices}${categoryAxis(series.points, centerFor)}`;
}

/** SVG arc path for one pie slice, `startAngle`/`endAngle` in radians from 12 o'clock, clockwise. */
function slicePath(cx: number, cy: number, radius: number, startAngle: number, endAngle: number): string {
  // A slice covering the whole circle cannot be drawn as a single arc (its
  // start and end points coincide, so the renderer draws nothing) — two
  // half-circles are the standard workaround.
  if (endAngle - startAngle >= Math.PI * 2 - 1e-9) {
    return `M ${round(cx)} ${round(cy - radius)} A ${radius} ${radius} 0 1 1 ${round(cx)} ${round(cy + radius)} A ${radius} ${radius} 0 1 1 ${round(cx)} ${round(cy - radius)} Z`;
  }
  const point = (angle: number): string =>
    `${round(cx + radius * Math.sin(angle))} ${round(cy - radius * Math.cos(angle))}`;
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${round(cx)} ${round(cy)} L ${point(startAngle)} A ${radius} ${radius} 0 ${largeArc} 1 ${point(endAngle)} Z`;
}

function renderArcs(series: ChartSeries): string {
  const total = series.points.reduce((sum, point) => sum + Math.max(point.value, 0), 0);
  if (total <= 0) return "";
  const cx = PAD_LEFT + PLOT_HEIGHT / 2;
  const cy = PAD_TOP + PLOT_HEIGHT / 2;
  const radius = PLOT_HEIGHT / 2 - 2;
  let angle = 0;
  const slices = series.points
    .map((point) => {
      const sweep = (Math.max(point.value, 0) / total) * Math.PI * 2;
      const path = slicePath(cx, cy, radius, angle, angle + sweep);
      angle += sweep;
      const share = Math.round((Math.max(point.value, 0) / total) * 100);
      return `<path class="widget-chart-slice" d="${path}" fill="${paletteColorFor(point.label)}"><title>${escapeXml(`${point.label}: ${formatValue(point.value)} (${share}%)`)}</title></path>`;
    })
    .join("");

  // Legend column: a pie without one is a colour puzzle.
  const legendX = cx + radius + 12;
  const legend = series.points
    .slice(0, 8)
    .map((point, index) => {
      const y = PAD_TOP + 8 + index * 14;
      return `<rect x="${legendX}" y="${y - 6}" width="8" height="8" rx="2" fill="${paletteColorFor(point.label)}" /><text class="widget-chart-label" x="${legendX + 12}" y="${y + 1}">${escapeXml(elide(point.label))} ${escapeXml(formatValue(point.value))}</text>`;
    })
    .join("");
  return `${slices}${legend}`;
}

/**
 * Renders one chart. `spec` decides the mark; `series` (already aggregated
 * from that same spec by `./chart-data.ts`) supplies the geometry.
 */
export function renderChartSvg(spec: HonuaVegaLiteChartSpec, series: ChartSeries): ChartRenderResult {
  const mark = specMark(spec);
  const title = spec.title ?? `${series.valueTitle} by ${series.categoryTitle}`;
  const summary = summarize(series, mark);
  if (series.points.length === 0) {
    return { svg: frame("", title, summary), summary };
  }
  const color = paletteColorFor(spec.title ?? series.categoryTitle);
  const body =
    mark === "arc" ? renderArcs(series) : mark === "line" ? renderLine(series, color) : renderBars(series, color);
  return { svg: frame(body, title, summary), summary };
}
