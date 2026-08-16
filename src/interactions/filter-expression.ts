/**
 * `FilterClause` (the SDK's protocol-neutral exploration clause) -> a MapLibre
 * style-spec filter expression.
 *
 * The SDK is explicit that a `FilterClause` is **value-only**: "adapters build
 * the protocol-specific WHERE / CQL2 / $filter expression from `field`,
 * `operator`, and `value` together". MapLibre's expression language is one
 * more such dialect, and this module is Studio's adapter for it — the piece
 * that turns "the user picked R-1 in the zoning filter" into something the
 * renderer will actually honour.
 *
 * Pure and total, like every other translation module in this app: an
 * operator it cannot express returns `undefined` (the layer stays unfiltered
 * and the caller reports why) rather than throwing or, worse, emitting a
 * filter that silently matches nothing.
 *
 * @module
 */

import type { FilterClause } from "@honua/sdk-js/exploration";

/** A MapLibre style-spec filter expression. Kept `unknown`-ish on purpose — this module must not pull the MapLibre types into the entry graph. */
export type MaplibreFilter = readonly unknown[];

function get(field: string): readonly unknown[] {
  // `["get", field]` reads a feature property. The `id` property is special —
  // MapLibre exposes a feature's own id through `["id"]`, not `["get","id"]`,
  // and a filter on "id" that reads a non-existent property would match
  // nothing at all rather than everything.
  return field === "$id" || field === "id" ? ["id"] : ["get", field];
}

function isComparable(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * One clause -> one expression. Returns `undefined` when the clause cannot be
 * expressed (a value of the wrong shape for the operator, or an operator with
 * no MapLibre equivalent).
 */
export function clauseToMaplibreFilter(clause: FilterClause | undefined): MaplibreFilter | undefined {
  if (!clause || !clause.field) return undefined;
  const property = get(clause.field);
  switch (clause.operator) {
    case "=":
    case "!=":
    case "<":
    case "<=":
    case ">":
    case ">=":
      return isComparable(clause.value)
        ? [clause.operator === "=" ? "==" : clause.operator, property, clause.value]
        : undefined;
    case "in":
    case "not-in": {
      const values = Array.isArray(clause.value) ? clause.value.filter(isComparable) : undefined;
      if (!values || values.length === 0) return undefined;
      const inExpression = ["in", property, ["literal", values]];
      return clause.operator === "in" ? inExpression : ["!", inExpression];
    }
    case "between": {
      const bounds = Array.isArray(clause.value) ? clause.value : undefined;
      const [low, high] = bounds ?? [];
      if (typeof low !== "number" || typeof high !== "number") return undefined;
      return ["all", [">=", property, low], ["<=", property, high]];
    }
    case "like": {
      // MapLibre has no LIKE. A `%term%` pattern is a substring test, which
      // `index-of` expresses exactly; anything else (leading-only, escapes)
      // would need a regex the expression language does not have.
      if (typeof clause.value !== "string") return undefined;
      const bare = clause.value.replace(/^%|%$/g, "");
      if (bare.includes("%") || bare.includes("_")) return undefined;
      return [">=", ["index-of", bare, ["to-string", property]], 0];
    }
    case "is-null":
      return ["==", ["to-string", property], ""];
    case "is-not-null":
      return ["!=", ["to-string", property], ""];
  }
}

/**
 * Combines every clause that applies to one source into a single `all`
 * expression. Clauses are ANDed, which is what a filter *bar* means: each
 * control narrows the result further.
 *
 * `appliesTo` is honoured when present — a clause scoped to other sources is
 * skipped rather than leaking across layers.
 */
export function clausesToMaplibreFilter(
  clauses: readonly FilterClause[],
  sourceIds: readonly string[],
): MaplibreFilter | undefined {
  const expressions: MaplibreFilter[] = [];
  // Deduplicated by the expression they produce, not by clause identity. Two
  // clauses routinely arrive saying the same thing — a filter control scopes
  // to its own source layer, and a binding may target that same layer — and
  // `["all", X, X]` is not merely redundant: it is a filter a reader cannot
  // interpret and a style diff that churns for nothing.
  const seen = new Set<string>();
  for (const clause of clauses) {
    if (clause.appliesTo && clause.appliesTo.length > 0) {
      if (!clause.appliesTo.some((id) => sourceIds.includes(id))) continue;
    }
    const expression = clauseToMaplibreFilter(clause);
    if (!expression) continue;
    const key = JSON.stringify(expression);
    if (seen.has(key)) continue;
    seen.add(key);
    expressions.push(expression);
  }
  if (expressions.length === 0) return undefined;
  if (expressions.length === 1) return expressions[0];
  return ["all", ...expressions];
}
