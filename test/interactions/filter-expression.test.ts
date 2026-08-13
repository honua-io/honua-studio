/**
 * `FilterClause` -> MapLibre expression. The SDK's clause is protocol-neutral
 * by design ("adapters build the protocol-specific WHERE / CQL2 / $filter
 * expression"), so this adapter is where a wrong translation would turn a
 * working control into one that filters everything away.
 */
import { describe, expect, it } from "vitest";

import { clauseToMaplibreFilter, clausesToMaplibreFilter } from "../../src/interactions/filter-expression.js";

describe("interactions/filter-expression", () => {
  it("maps the comparison operators, spelling `=` as MapLibre's `==`", () => {
    expect(clauseToMaplibreFilter({ field: "zoning", operator: "=", value: "R-5" })).toEqual([
      "==",
      ["get", "zoning"],
      "R-5",
    ]);
    expect(clauseToMaplibreFilter({ field: "year", operator: ">=", value: 1950 })).toEqual([
      ">=",
      ["get", "year"],
      1950,
    ]);
    expect(clauseToMaplibreFilter({ field: "year", operator: "!=", value: 1950 })).toEqual([
      "!=",
      ["get", "year"],
      1950,
    ]);
  });

  it('reads a feature\'s own id through `["id"]`, not as a property that does not exist', () => {
    expect(clauseToMaplibreFilter({ field: "id", operator: "=", value: 7 })).toEqual(["==", ["id"], 7]);
  });

  it("expresses in / not-in over a literal list", () => {
    expect(clauseToMaplibreFilter({ field: "z", operator: "in", value: ["A", "B"] })).toEqual([
      "in",
      ["get", "z"],
      ["literal", ["A", "B"]],
    ]);
    expect(clauseToMaplibreFilter({ field: "z", operator: "not-in", value: ["A"] })).toEqual([
      "!",
      ["in", ["get", "z"], ["literal", ["A"]]],
    ]);
  });

  it("expresses between as an inclusive pair", () => {
    expect(clauseToMaplibreFilter({ field: "y", operator: "between", value: [1900, 2000] })).toEqual([
      "all",
      [">=", ["get", "y"], 1900],
      ["<=", ["get", "y"], 2000],
    ]);
  });

  it("expresses a plain %substring% LIKE, and refuses a pattern it cannot honour", () => {
    expect(clauseToMaplibreFilter({ field: "name", operator: "like", value: "%kai%" })).toEqual([
      ">=",
      ["index-of", "kai", ["to-string", ["get", "name"]]],
      0,
    ]);
    // A mid-pattern wildcard has no MapLibre equivalent — better unfiltered
    // than filtered wrongly.
    expect(clauseToMaplibreFilter({ field: "name", operator: "like", value: "ka%i" })).toBeUndefined();
  });

  it("returns nothing for a value of the wrong shape rather than emitting a filter that matches nothing", () => {
    expect(clauseToMaplibreFilter({ field: "z", operator: "in", value: "A" })).toBeUndefined();
    expect(clauseToMaplibreFilter({ field: "z", operator: "between", value: [1] })).toBeUndefined();
    expect(clauseToMaplibreFilter({ field: "z", operator: "=", value: { a: 1 } })).toBeUndefined();
    expect(clauseToMaplibreFilter(undefined)).toBeUndefined();
  });

  it("ANDs several clauses — each control narrows the result further", () => {
    const combined = clausesToMaplibreFilter(
      [
        { field: "zoning", operator: "=", value: "R-5" },
        { field: "year", operator: ">=", value: 1950 },
      ],
      ["parcels"],
    );
    expect(combined?.[0]).toBe("all");
    expect(combined).toHaveLength(3);
  });

  it("returns a lone clause unwrapped, and nothing at all for an empty set", () => {
    expect(clausesToMaplibreFilter([{ field: "z", operator: "=", value: "A" }], ["parcels"])?.[0]).toBe("==");
    expect(clausesToMaplibreFilter([], ["parcels"])).toBeUndefined();
  });

  it("deduplicates identical expressions — a control scoping to its own layer AND a binding naming it say the same thing once", () => {
    const clause = { field: "z", operator: "=" as const, value: "A" };
    expect(clausesToMaplibreFilter([clause, { ...clause }], ["parcels"])).toEqual(["==", ["get", "z"], "A"]);
  });

  it("honours appliesTo so a clause scoped elsewhere does not leak across layers", () => {
    const clauses = [{ field: "z", operator: "=" as const, value: "A", appliesTo: ["src-roads"] }];
    expect(clausesToMaplibreFilter(clauses, ["src-parcels"])).toBeUndefined();
    expect(clausesToMaplibreFilter(clauses, ["src-roads"])).toBeDefined();
  });
});
