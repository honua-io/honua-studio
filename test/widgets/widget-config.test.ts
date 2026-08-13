/**
 * Config normalization (honua-studio#24 REQ-001/REQ-004).
 *
 * The behaviour worth protecting here is the *default*: an agent that says
 * only "chart the parcels by zoning code" must get a working chart, and an
 * agent that says "add a layer list" must get a working TOC. Every assertion
 * below is really asking "did the agent have to author chrome?".
 */
import { describe, expect, it } from "vitest";

import type { CompositionWidget } from "../../src/composition/model.js";
import {
  normalizeChartType,
  readChartConfig,
  readCompareConfig,
  readLegendConfig,
  readTableConfig,
  readTimeConfig,
  readTocConfig,
} from "../../src/widgets/widget-config.js";

const widget = (kind: CompositionWidget["kind"], config?: Record<string, unknown>): CompositionWidget => ({
  id: `w-${kind}`,
  kind,
  ...(config !== undefined ? { config } : {}),
});

describe("widgets/widget-config: chart", () => {
  it("a bare groupBy is a counted bar chart — no spec authoring required", () => {
    const result = readChartConfig(widget("chart", { groupBy: "zoning_code" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({
      chartType: "bar",
      groupBy: "zoning_code",
      measure: { fn: "count", field: "*" },
      temporal: false,
    });
  });

  it("normalizes chart-type spellings a model plausibly emits", () => {
    expect(normalizeChartType("column")).toBe("bar");
    expect(normalizeChartType("Donut")).toBe("pie");
    expect(normalizeChartType("time-series")).toBe("line");
    expect(normalizeChartType("banana")).toBe("bar");
    expect(normalizeChartType(undefined)).toBe("bar");
  });

  it("reads a measure from a nested object or the flattened pair", () => {
    const nested = readChartConfig(widget("chart", { groupBy: "district", measure: { fn: "sum", field: "acres" } }));
    const flat = readChartConfig(widget("chart", { groupBy: "district", measureFn: "average", measureField: "acres" }));
    expect(nested.ok && nested.config.measure).toEqual({ fn: "sum", field: "acres" });
    expect(flat.ok && flat.config.measure).toEqual({ fn: "avg", field: "acres" });
  });

  it("downgrades a fieldless aggregation to a count rather than emitting a meaningless sum", () => {
    const result = readChartConfig(widget("chart", { groupBy: "district", measureFn: "sum" }));
    expect(result.ok && result.config.measure).toEqual({ fn: "count", field: "*" });
  });

  it("infers a temporal axis from the field name, and from a line chart", () => {
    expect(readChartConfig(widget("chart", { groupBy: "permit_date" })).ok).toBe(true);
    const byName = readChartConfig(widget("chart", { groupBy: "permit_date" }));
    const byType = readChartConfig(widget("chart", { groupBy: "district", chartType: "line" }));
    expect(byName.ok && byName.config.temporal).toBe(true);
    expect(byType.ok && byType.config.temporal).toBe(true);
  });

  it("treats an explicit binField as a histogram over that field", () => {
    const result = readChartConfig(widget("chart", { binField: "chloride_mg_l", bins: 6 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({ field: "chloride_mg_l", bins: 6, chartType: "bar" });
    expect(result.config.groupBy).toBeUndefined();
  });

  it("fails with a reason when there is nothing to plot against", () => {
    const result = readChartConfig(widget("chart"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("groupBy");
  });
});

describe("widgets/widget-config: toc, legend, table", () => {
  it("a TOC with no config is valid — that is the whole point of REQ-002", () => {
    const result = readTocConfig(widget("toc"));
    expect(result).toEqual({ ok: true, config: { layerIds: [], showUnrenderable: true } });
  });

  it("a TOC may scope itself to named layers", () => {
    const result = readTocConfig(widget("toc", { layerIds: ["a", "b"], showUnrenderable: false }));
    expect(result.ok && result.config).toEqual({ layerIds: ["a", "b"], showUnrenderable: false });
  });

  it("a legend defaults to visible layers only", () => {
    expect(readLegendConfig(widget("legend")).ok && readLegendConfig(widget("legend"))).toMatchObject({
      config: { includeHidden: false },
    });
  });

  it("a grid bounds its page size even when asked for more", () => {
    const result = readTableConfig(widget("table", { pageSize: 100_000 }));
    expect(result.ok && result.config.pageSize).toBe(200);
    expect(readTableConfig(widget("table")).ok && readTableConfig(widget("table"))).toMatchObject({
      config: { pageSize: 25, fields: [] },
    });
  });

  it("a grid reads column aliases", () => {
    const result = readTableConfig(widget("table", { columns: ["parcel_id", "district"], primaryKey: "parcel_id" }));
    expect(result.ok && result.config).toEqual({
      fields: ["parcel_id", "district"],
      pageSize: 25,
      primaryKey: "parcel_id",
    });
  });
});

describe("widgets/widget-config: compare and time", () => {
  it("compare accepts an explicit pair or a layerIds array", () => {
    expect(readCompareConfig(widget("compare", { left: "a", right: "b" })).ok).toBe(true);
    const fromArray = readCompareConfig(widget("compare", { layerIds: ["a", "b"] }));
    expect(fromArray.ok && fromArray.config).toMatchObject({ left: "a", right: "b" });
  });

  it("compare fails with a reason when only one layer is named", () => {
    const result = readCompareConfig(widget("compare", { left: "a" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("needs two layers");
  });

  it("time steps through layers", () => {
    const result = readTimeConfig(widget("time", { steps: [{ label: "2019", layerId: "l19" }, { layerId: "l20" }] }));
    expect(result.ok && result.config.steps).toEqual([
      { label: "2019", layerId: "l19" },
      { label: "l20", layerId: "l20" },
    ]);
  });

  /**
   * The honest scope note, asserted rather than only documented: a
   * field-based temporal filter names the missing capability instead of
   * rendering a slider that moves and changes nothing.
   */
  it("time names the missing filter capability rather than faking a field filter", () => {
    const result = readTimeConfig(widget("time", { field: "permit_date" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("no filter command");
    expect(result.reason).toContain("permit_date");
  });
});
