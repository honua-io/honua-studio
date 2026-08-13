/**
 * Aggregation reads the **spec**, not the widget config (honua-studio#24
 * REQ-004's "keep the spec conversion as the contract").
 *
 * That is why every case below builds its spec through
 * `compositionChartSpec` rather than hand-writing one: if the aggregation
 * ever started reading `widget.config` directly, these tests would still
 * pass — but the first test in this file, which drives an entirely
 * hand-written spec through the aggregator with no widget in sight, would
 * not.
 */
import type { HonuaVegaLiteChartSpec } from "@honua/sdk-js/studio";
import { describe, expect, it } from "vitest";

import type { CompositionWidget } from "../../src/composition/model.js";
import { chartSeriesFromSpec } from "../../src/widgets/chart-data.js";
import { compositionChartSpec } from "../../src/widgets/chart-spec.js";

const PARCELS: ReadonlyArray<Record<string, unknown>> = [
  { zoning_code: "R-5", district: "Honolulu", acres: 2 },
  { zoning_code: "R-5", district: "Honolulu", acres: 4 },
  { zoning_code: "B-2", district: "ʻEwa", acres: 10 },
  { zoning_code: "AG-1", district: "ʻEwa", acres: 1 },
];

const chart = (config: Record<string, unknown>): CompositionWidget => ({
  id: "chart-1",
  kind: "chart",
  sourceId: "hi-parcels",
  config,
});

function specFor(
  config: Record<string, unknown>,
  rows: ReadonlyArray<Record<string, unknown>> = PARCELS,
): HonuaVegaLiteChartSpec {
  const result = compositionChartSpec(chart(config), rows);
  if (!result.ok) throw new Error(result.reason);
  return result.spec;
}

describe("widgets/chart-data", () => {
  it("aggregates from a spec that no widget produced — the spec really is the contract", () => {
    const handWritten: HonuaVegaLiteChartSpec = {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      mark: "bar",
      encoding: {
        x: { field: "district", type: "nominal" },
        y: { field: "count", type: "quantitative", aggregate: "count", title: "Count" },
      },
    };
    const series = chartSeriesFromSpec(handWritten, PARCELS);
    expect(series.points).toEqual([
      { label: "Honolulu", value: 2, order: "Honolulu" },
      { label: "ʻEwa", value: 2, order: "ʻEwa" },
    ]);
    expect(series.categoryTitle).toBe("district");
    expect(series.valueTitle).toBe("Count");
  });

  it("counts by category, biggest first", () => {
    const series = chartSeriesFromSpec(specFor({ groupBy: "zoning_code" }));
    expect(series.points.map((point) => [point.label, point.value])).toEqual([
      ["R-5", 2],
      ["AG-1", 1],
      ["B-2", 1],
    ]);
  });

  it("applies the aggregate op the spec asks for", () => {
    const summed = chartSeriesFromSpec(specFor({ groupBy: "district", measure: { fn: "sum", field: "acres" } }));
    expect(summed.points).toEqual([
      { label: "ʻEwa", value: 11, order: "ʻEwa" },
      { label: "Honolulu", value: 6, order: "Honolulu" },
    ]);
    const averaged = chartSeriesFromSpec(specFor({ groupBy: "district", measure: { fn: "avg", field: "acres" } }));
    expect(averaged.points.find((point) => point.label === "Honolulu")?.value).toBe(3);
  });

  it("reads a pie's category off the colour channel", () => {
    const series = chartSeriesFromSpec(specFor({ groupBy: "zoning_code", chartType: "pie" }));
    expect(series.points).toHaveLength(3);
    expect(series.categoryTitle).toBe("zoning_code");
  });

  it("orders a temporal series by time, not by magnitude", () => {
    const rows = [
      { permit_date: "2021-03-01" },
      { permit_date: "2019-01-01" },
      { permit_date: "2019-01-01" },
      { permit_date: "2020-06-01" },
    ];
    const series = chartSeriesFromSpec(specFor({ groupBy: "permit_date", chartType: "line" }, rows), rows);
    expect(series.points.map((point) => point.label)).toEqual(["2019-01-01", "2020-06-01", "2021-03-01"]);
    expect(series.points[0]?.value).toBe(2);
  });

  it("bins a histogram into equal-width buckets", () => {
    const rows = [{ v: 0 }, { v: 1 }, { v: 9 }, { v: 10 }];
    const series = chartSeriesFromSpec(specFor({ binField: "v", bins: 2 }, rows), rows);
    expect(series.points).toHaveLength(2);
    expect(series.points.reduce((sum, point) => sum + point.value, 0)).toBe(4);
  });

  it("reports rows it could not group rather than silently dropping them", () => {
    const rows = [{ district: "Honolulu" }, { district: null }, {}];
    const series = chartSeriesFromSpec(specFor({ groupBy: "district" }, rows), rows);
    expect(series.points).toEqual([{ label: "Honolulu", value: 1, order: "Honolulu" }]);
    expect(series.skippedRows).toBe(2);
  });

  it("folds a long categorical tail into one honest 'Other'", () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({ code: `c${index}` }));
    const series = chartSeriesFromSpec(specFor({ groupBy: "code" }, rows), rows);
    expect(series.points).toHaveLength(24);
    expect(series.points.at(-1)?.label).toBe("Other (17)");
    expect(series.points.reduce((sum, point) => sum + point.value, 0)).toBe(40);
  });

  it("returns an empty series (not a throw) for no rows", () => {
    const series = chartSeriesFromSpec(specFor({ groupBy: "district" }, []), []);
    expect(series.points).toEqual([]);
    expect(series.categoryTitle).toBe("district");
  });
});
