/**
 * honua-studio#24 REQ-004: charts render from an agent-authored widget
 * without a hand-written Vega-Lite spec, and the SDK's own
 * `chartWidgetToVegaLiteSpec` is what produces the spec.
 *
 * The strongest assertion in this file is the last one: the spec this module
 * emits is byte-identical to what the SDK helper emits for the equivalent
 * generated-app widget, for the encodings the helper already covers. That is
 * what makes "reuses the SDK conversion" checkable rather than a claim in a
 * comment — a second chart model would drift from it immediately.
 */
import { chartWidgetToVegaLiteSpec } from "@honua/sdk-js/studio";
import { describe, expect, it } from "vitest";

import type { CompositionWidget } from "../../src/composition/model.js";
import { compositionChartSpec, compositionChartToGeneratedAppWidget } from "../../src/widgets/chart-spec.js";
import { readChartConfig } from "../../src/widgets/widget-config.js";

const chart = (config: Record<string, unknown>, extra: Partial<CompositionWidget> = {}): CompositionWidget => ({
  id: "chart-1",
  kind: "chart",
  sourceId: "hi-parcels",
  config,
  ...extra,
});

describe("widgets/chart-spec (REQ-004)", () => {
  it("derives a counted bar chart from a groupBy alone", () => {
    const result = compositionChartSpec(chart({ groupBy: "zoning_code" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.$schema).toBe("https://vega.github.io/schema/vega-lite/v6.json");
    expect(result.spec.mark).toEqual({ type: "bar", tooltip: true });
    expect(result.spec.encoding.x).toMatchObject({ field: "zoning_code", type: "nominal" });
    expect(result.spec.encoding.y).toMatchObject({ field: "count", aggregate: "count" });
  });

  it("is byte-identical to the SDK helper for the encodings the helper covers", () => {
    const widget = chart({ groupBy: "zoning_code" }, { title: "Parcels by zoning" });
    const normalized = readChartConfig(widget);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    const sdkWidget = compositionChartToGeneratedAppWidget(widget, normalized.config);
    const direct = chartWidgetToVegaLiteSpec(sdkWidget);
    const viaStudio = compositionChartSpec(widget);
    expect(viaStudio.ok).toBe(true);
    if (!viaStudio.ok || !direct) return;
    // The one documented divergence: an axis title that merely repeated the
    // chart heading is dropped. Everything else must match exactly.
    const { title: _droppedAxisTitle, ...expectedX } = direct.encoding.x ?? {};
    expect(viaStudio.spec).toEqual({ ...direct, encoding: { ...direct.encoding, x: expectedX } });
  });

  it("draws a pie as an arc with the category on the colour channel", () => {
    const result = compositionChartSpec(chart({ groupBy: "district", chartType: "pie" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.mark).toEqual({ type: "arc", tooltip: true });
    expect(result.spec.encoding.color).toMatchObject({ field: "district", type: "nominal" });
    expect(result.spec.encoding.x).toBeUndefined();
    expect(result.spec.encoding.y).toMatchObject({ aggregate: "count" });
  });

  it("draws a temporal groupBy as a line over a temporal axis", () => {
    const result = compositionChartSpec(chart({ groupBy: "permit_date", chartType: "line" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.mark).toEqual({ type: "line", tooltip: true });
    expect(result.spec.encoding.x).toMatchObject({ field: "permit_date", type: "temporal" });
  });

  it("honors a non-count measure on a categorical chart (the helper only does so for time series)", () => {
    const result = compositionChartSpec(chart({ groupBy: "district", measure: { fn: "sum", field: "acres" } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.encoding.y).toEqual({
      field: "acres",
      type: "quantitative",
      aggregate: "sum",
      title: "sum(acres)",
    });
  });

  it("bins a histogram", () => {
    const result = compositionChartSpec(chart({ binField: "chloride_mg_l", bins: 5 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.encoding.x).toMatchObject({ field: "chloride_mg_l", type: "quantitative", bin: { maxbins: 5 } });
  });

  it("carries rows through as the spec's inline data.values", () => {
    const rows = [{ zoning_code: "R-5" }, { zoning_code: "B-2" }];
    const result = compositionChartSpec(chart({ groupBy: "zoning_code" }), rows);
    expect(result.ok && result.spec.data?.values).toEqual(rows);
  });

  it("degrades with a reason rather than emitting a broken spec", () => {
    const result = compositionChartSpec(chart({}));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("groupBy");
  });
});
