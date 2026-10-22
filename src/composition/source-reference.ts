import type { CompositionState } from "./model.js";

/** Layer aliases and backing source IDs share a wire field. A collision must
 * never select a different source depending on which consumer reads it. */
export function compositionDataSource(state: CompositionState, reference: string): string | undefined {
  if (
    !reference.trim() ||
    reference.trim() !== reference ||
    [...reference].some((character) => character.charCodeAt(0) < 32)
  )
    return undefined;
  const alias = state.layers.find((layer) => layer.id === reference);
  if (!alias) return reference; // A raw catalog source need not have a visual layer.
  if (alias.sourceId !== reference && state.layers.some((layer) => layer.sourceId === reference)) return undefined;
  return alias.sourceId;
}
