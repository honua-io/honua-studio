import type { FilterClause } from "@honua/sdk-js/exploration";
import { describe, expect, it } from "vitest";
import { filterWidgetRows } from "../../src/widgets/filter-rows.js";

const rows = [
  { featureId: 1, properties: { district: "East", score: 10 } },
  { featureId: 2, properties: { district: "West", score: 20 } },
  { featureId: 3, properties: { district: "East", score: 30 } },
];
describe("source-scoped widget filtering", () => {
  it("ANDs the shared clauses, respects appliesTo and keeps raw data unchanged", () => {
    const before = structuredClone(rows);
    expect(
      filterWidgetRows(
        rows,
        [
          { field: "district", operator: "=", value: "East", appliesTo: ["roads"] },
          { field: "score", operator: ">=", value: 20 },
          { field: "score", operator: "<", value: 0, appliesTo: ["other"] },
        ],
        "roads",
      ),
    ).toEqual({ ok: true, rows: [rows[2]] });
    expect(rows).toEqual(before);
    expect(filterWidgetRows(rows, [], "roads")).toEqual({ ok: true, rows });
  });
  it.each([
    ["in", [10, 30], [1, 3]],
    ["not-in", [10, 30], [2]],
    ["between", [10, 20], [1, 2]],
    ["!=", 20, [1, 3]],
    ["<", 20, [1]],
    ["<=", 20, [1, 2]],
    [">", 20, [3]],
  ])("matches the map clause adapter for %s", (operator, value, ids) => {
    const result = filterWidgetRows(rows, [{ field: "score", operator, value } as FilterClause], "roads");
    expect(result.ok && result.rows.map((row) => row.featureId)).toEqual(ids);
  });
  it("uses the same substring/null/id expressions and refuses unsupported LIKE semantics", () => {
    expect(filterWidgetRows(rows, [{ field: "district", operator: "like", value: "%as%" }], "roads")).toEqual({
      ok: true,
      rows: [rows[0], rows[2]],
    });
    expect(filterWidgetRows(rows, [{ field: "$id", operator: "=", value: 2 }], "roads")).toEqual({
      ok: true,
      rows: [rows[1]],
    });
    expect(filterWidgetRows(rows, [{ field: "district", operator: "like", value: "Ea_t%" }], "roads")).toMatchObject({
      ok: false,
      code: "unsupported-widget-filter",
    });
    expect(filterWidgetRows(rows, [{ field: "absent", operator: "is-null" } as FilterClause], "roads")).toEqual({
      ok: true,
      rows,
    });
  });
});
