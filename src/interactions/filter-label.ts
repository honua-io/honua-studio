import type { FilterClause } from "@honua/sdk-js/exploration";

const FILTER_OPERATOR_WORDS: Readonly<Record<FilterClause["operator"], string>> = {
  "=": "is",
  "!=": "is not",
  "<": "is below",
  "<=": "is at most",
  ">": "is above",
  ">=": "is at least",
  in: "is one of",
  "not-in": "is none of",
  between: "is between",
  like: "matches",
  "is-null": "is empty",
  "is-not-null": "has a value",
};

/** Plain-language meaning of one exploration clause, e.g. `zoning_code is R-5`. */
export function describeFilterClause(clause: FilterClause): string {
  const words = FILTER_OPERATOR_WORDS[clause.operator] ?? clause.operator;
  const value = clause.value;
  if (clause.operator === "is-null" || clause.operator === "is-not-null") return `${clause.field} ${words}`;
  if (clause.operator === "between" && Array.isArray(value))
    return `${clause.field} ${words} ${value[0]} and ${value[1]}`;
  if (Array.isArray(value)) return `${clause.field} ${words} ${value.join(", ")}`;
  return `${clause.field} ${words} ${String(value)}`;
}
