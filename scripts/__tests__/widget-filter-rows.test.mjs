import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

// Dependency-free runtime check of the actual pure adapters. Node strips types
// only; the shared SDK clause -> map-expression implementation stays unchanged.
function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}
const adapter = moduleUrl(
  stripTypeScriptTypes(readFileSync(new URL("../../src/interactions/filter-expression.ts", import.meta.url), "utf8")),
);
const source = stripTypeScriptTypes(
  readFileSync(new URL("../../src/widgets/filter-rows.ts", import.meta.url), "utf8"),
).replace('"../interactions/filter-expression.js"', JSON.stringify(adapter));
const { filterWidgetRows } = await import(moduleUrl(source));
const rows = Object.freeze([
  Object.freeze({ featureId: 1, properties: Object.freeze({ district: "East", score: 10 }) }),
  Object.freeze({ featureId: 2, properties: Object.freeze({ district: "West", score: 20 }) }),
  Object.freeze({ featureId: 3, properties: Object.freeze({ district: "East", score: 30 }) }),
]);
test("shared source clauses narrow exact rows while unrelated scopes and raw cache stay unchanged", () => {
  const result = filterWidgetRows(
    rows,
    [
      { field: "district", operator: "=", value: "East", appliesTo: ["roads"] },
      { field: "score", operator: ">=", value: 20 },
      { field: "district", operator: "=", value: "West", appliesTo: ["other-layer"] },
    ],
    "roads",
  );
  assert.deepEqual(result, { ok: true, rows: [rows[2]] });
  assert.deepEqual(filterWidgetRows(rows, [], "roads"), { ok: true, rows });
  assert.equal(rows.length, 3);
});
test("admitted list/range/id/null/substring expressions use the shared map adapter", () => {
  for (const [clause, ids] of [
    [{ field: "score", operator: "between", value: [10, 20] }, [1, 2]],
    [{ field: "score", operator: "not-in", value: [10, 30] }, [2]],
    [{ field: "$id", operator: "=", value: 2 }, [2]],
    [{ field: "district", operator: "like", value: "%as%" }, [1, 3]],
    [{ field: "missing", operator: "is-null" }, [1, 2, 3]],
  ]) {
    const result = filterWidgetRows(rows, [clause], "roads");
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.rows.map((row) => row.featureId),
      ids,
    );
  }
});
test("unsupported active filter returns a typed blocker rather than silently unfiltered data", () => {
  assert.equal(
    filterWidgetRows(rows, [{ field: "district", operator: "like", value: "Ea_t%" }], "roads").code,
    "unsupported-widget-filter",
  );
  assert.equal(
    filterWidgetRows(rows, [{ field: "district", operator: "unrecognized", value: "East" }], "roads").code,
    "unsupported-widget-filter",
  );
});

test("nonprimitive field values are blocked instead of inventing map string conversion semantics", () => {
  const result = filterWidgetRows(
    [{ properties: { district: { nested: "East" } } }],
    [{ field: "district", operator: "like", value: "%East%" }],
    "roads",
  );
  assert.equal(result.code, "unsupported-widget-filter");
});

test("date-control strings filter inclusively without converting numeric epochs or accepting mixed bounds", () => {
  const dated = [
    { featureId: 1, properties: { day: "2025-12-31" } },
    { featureId: 2, properties: { day: "2026-01-01" } },
    { featureId: 3, properties: { day: "2026-01-02" } },
    { featureId: 4, properties: { day: "2026-01-03" } },
    { featureId: 5, properties: { day: "2026-01-04" } },
    { featureId: 6, properties: { day: 1767312000000 } },
  ];
  const result = filterWidgetRows(
    dated,
    [{ field: "day", operator: "between", value: ["2026-01-01", "2026-01-03"] }],
    "roads",
  );
  assert.deepEqual(
    result.rows.map((row) => row.featureId),
    [2, 3, 4],
  );
  assert.equal(
    filterWidgetRows(dated, [{ field: "day", operator: "between", value: ["2026-01-01", 1767398400000] }], "roads")
      .code,
    "unsupported-widget-filter",
  );
  assert.deepEqual(
    filterWidgetRows(rows, [{ field: "score", operator: "between", value: [-10, 20] }], "roads").rows.map(
      (row) => row.featureId,
    ),
    [1, 2],
  );
  for (const value of [[1, Number.POSITIVE_INFINITY], [Number.NaN, 2], [false, true], [1], [1, 2, 3]])
    assert.equal(
      filterWidgetRows(rows, [{ field: "score", operator: "between", value }], "roads").code,
      "unsupported-widget-filter",
    );
});
