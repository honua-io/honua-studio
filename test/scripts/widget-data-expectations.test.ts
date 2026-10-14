// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  bindWidgetFeatureResponse,
  expectedChartValues,
  expectedWidgetData,
  requireMatchingWidgetData,
} from "../../scripts/lib/widget-data-expectations.mjs";
import { chartSeriesFromSpec } from "../../src/widgets/chart-data.js";
import { renderChartSvg } from "../../src/widgets/chart-render.js";
import { compositionChartSpec } from "../../src/widgets/chart-spec.js";
import { readTableConfig } from "../../src/widgets/widget-config.js";
import { formatCellValue, inferColumns, rowsFromFeatureCollection } from "../../src/widgets/widget-data.js";
const pipeline = {
  compositionChartSpec,
  chartSeriesFromSpec,
  renderChartSvg,
  readTableConfig,
  rowsFromFeatureCollection,
  inferColumns,
  formatCellValue,
};
const collection = {
  type: "FeatureCollection",
  features: [
    { properties: { id: 1, zone: "R", district: "North" } },
    { properties: { id: 2, zone: "R", district: "South" } },
    { properties: { id: 3, zone: "B", district: "North" } },
  ],
};
const url = "https://honua.test/rest/services/Parcels/FeatureServer/1/query?f=geojson&resultRecordCount=500";
const response = { method: "GET", browserUrl: url, status: 200, response: JSON.stringify(collection) };
function chart(config = { categoryField: "zone", chartType: "bar" }) {
  const expected = expectedWidgetData(
    { id: "chart", kind: "chart", sourceId: "parcels", config },
    collection,
    pipeline,
  );
  if (expected.kind !== "chart") throw new Error("Expected chart");
  return { ...expected, renderedValues: expectedChartValues(expected.svg) };
}
describe("captured widget data expectations", () => {
  it("binds only the exact source query and refuses stale success after a failed latest response", () => {
    expect(bindWidgetFeatureResponse(url, [response]).collection).toEqual(collection);
    expect(() => bindWidgetFeatureResponse(url.replace("/1/", "/2/"), [response])).toThrow();
    expect(() => bindWidgetFeatureResponse(url.replace("honua.test", "other.test"), [response])).toThrow();
    expect(() =>
      bindWidgetFeatureResponse(url, [response, { ...response, response: '{"error":{"code":499}}' }]),
    ).toThrow();
    expect(() =>
      bindWidgetFeatureResponse(url, [
        response,
        { ...response, response: JSON.stringify({ type: "FeatureCollection", features: [] }) },
      ]),
    ).toThrow("ambiguous");
  });
  it("permits bounded authorization retry before the actual successful feature response", () => {
    expect(
      bindWidgetFeatureResponse(url, [{ ...response, response: '{"error":{"code":499}}' }, response]).collection,
    ).toEqual(collection);
  });
  it("uses the real alias parser/aggregation for expected values and rejects wrong rendered field or numbers", () => {
    const expected = chart();
    expect(expected.renderedValues).toEqual(["R: 2", "B: 1"]);
    expect(() => requireMatchingWidgetData(expected, expected)).not.toThrow();
    expect(() => requireMatchingWidgetData(chart({ categoryField: "district", chartType: "bar" }), expected)).toThrow(
      "chart values",
    );
    expect(() => requireMatchingWidgetData({ ...expected, renderedValues: ["B: 9", "R: 2"] }, expected)).toThrow();
  });
  it("derives exact grid cells from the real configured columns and rejects wrong columns/source rows", () => {
    const widget = {
      id: "grid",
      kind: "table" as const,
      sourceId: "parcels",
      config: { fields: ["id", "zone"], pageSize: 25 },
    };
    const expected = expectedWidgetData(widget, collection, pipeline);
    if (expected.kind !== "table") throw new Error("Expected table");
    expect(expected.tableCells).toEqual(["1", "R", "2", "R", "3", "B"]);
    expect(() => requireMatchingWidgetData(expected, expected)).not.toThrow();
    const wrongColumns = expectedWidgetData(
      { ...widget, config: { fields: ["id", "district"] } },
      collection,
      pipeline,
    );
    expect(() => requireMatchingWidgetData(wrongColumns, expected)).toThrow("table cells");
    expect(() => requireMatchingWidgetData({ ...expected, tableCells: ["99", "X"] }, expected)).toThrow();
    expect(() => requireMatchingWidgetData({ ...expected, tableColumns: ["id", "district"] }, expected)).toThrow();
  });
});
