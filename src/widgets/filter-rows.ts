import type { FilterClause } from "@honua/sdk-js/exploration";
import { clauseToMaplibreFilter } from "../interactions/filter-expression.js";
import type { WidgetFeatureRow } from "./widget-data.js";

export type FilteredWidgetRows =
  | { readonly ok: true; readonly rows: readonly WidgetFeatureRow[] }
  | { readonly ok: false; readonly code: "unsupported-widget-filter"; readonly reason: string };

// Interpret only the closed expressions produced by the shared clause adapter.
// No authored expression/code is evaluated, and cached source rows are never mutated.
function evaluate(expression: unknown, row: WidgetFeatureRow): unknown {
  if (!Array.isArray(expression)) return expression;
  const [operator, ...args] = expression;
  const value = (index: number) => evaluate(args[index], row);
  switch (operator) {
    case "get": {
      const property = row.properties[String(args[0])];
      if (property !== undefined && property !== null && !["string", "number", "boolean"].includes(typeof property))
        throw new Error("A filter field contains a nonprimitive value.");
      if (typeof property === "number" && !Number.isFinite(property)) throw new Error("A filter field is not finite.");
      return property;
    }
    case "id":
      return row.featureId;
    case "literal":
      return args[0];
    case "to-string":
      return String(value(0) ?? "");
    case "index-of":
      return String(value(1)).indexOf(String(value(0)));
    case "all":
      return args.every((arg) => evaluate(arg, row) === true);
    case "!":
      return !value(0);
    case "in": {
      const values = value(1);
      return Array.isArray(values) && values.includes(value(0));
    }
    case "==":
      return value(0) === value(1);
    case "!=":
      return value(0) !== value(1);
    case "<":
    case "<=":
    case ">":
    case ">=": {
      const left = value(0);
      const right = value(1);
      if (
        !(
          (typeof left === "number" && typeof right === "number") ||
          (typeof left === "string" && typeof right === "string")
        )
      )
        return false;
      if (operator === "<") return left < right;
      if (operator === "<=") return left <= right;
      if (operator === ">") return left > right;
      return left >= right;
    }
    default:
      throw new Error("Unsupported generated filter expression.");
  }
}

export function filterWidgetRows(
  rows: readonly WidgetFeatureRow[],
  clauses: readonly FilterClause[],
  sourceId: string,
): FilteredWidgetRows {
  const applicable = clauses.filter((clause) => !clause.appliesTo?.length || clause.appliesTo.includes(sourceId));
  const expressions = applicable.map(clauseToMaplibreFilter);
  if (expressions.some((expression) => expression === undefined))
    return {
      ok: false,
      code: "unsupported-widget-filter",
      reason: "The active source filter cannot be evaluated by this chart or table.",
    };
  try {
    return {
      ok: true,
      rows: rows.filter((row) => expressions.every((expression) => evaluate(expression, row) === true)),
    };
  } catch {
    return {
      ok: false,
      code: "unsupported-widget-filter",
      reason: "The active source filter uses an unsupported expression.",
    };
  }
}
