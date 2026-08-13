/**
 * The deterministic identity colour of a composed entity.
 *
 * This started life inside `../map/style-presets.ts` (honua-studio#23), which
 * is still its only *paint* consumer. honua-studio#24 gave it a second,
 * non-map consumer: a legend and a layer list have to show the **same**
 * swatch the map draws, or the chrome is quietly lying about which layer is
 * which. So the hash and the palette live here — in the composition layer,
 * which both the renderer and the chrome already depend on — and
 * `style-presets.ts` re-exports them, leaving every existing import intact.
 *
 * There is also a bundling reason. `src/map/` is reached through a dynamic
 * import so MapLibre stays out of the entry chunk; the widget deck is a
 * registered element and therefore *is* in the entry. Had the deck imported
 * the palette from `src/map/`, the lazy map chunk would import back into the
 * entry — the circularity honua-studio#23 had to fix, whose symptom is an
 * element module evaluating twice under two URLs.
 *
 * @module
 */

/**
 * Qualitative palette for composed entities. Chosen for contrast against the
 * offline basemap's muted land/water and against each other; ordered so
 * adjacent entries never collide.
 */
export const COMPOSITION_LAYER_PALETTE: readonly string[] = [
  "#0b6b4d",
  "#b4531b",
  "#3a5fa8",
  "#8a2f6b",
  "#1f7a8c",
  "#94741a",
  "#5c3b8f",
  "#a03a3a",
];

/**
 * FNV-1a. Small, dependency-free, and — the property that actually matters
 * here — stable across runs and platforms, so a snapshot taken in CI matches
 * one taken on a developer's machine.
 */
export function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic palette entry for an id.
 *
 * Hashing the id (rather than counting entities) means adding `roads` never
 * recolours `parcels` — the map, the legend, and the layer list all move only
 * where the composition actually changed.
 */
export function paletteColorFor(id: string): string {
  const palette = COMPOSITION_LAYER_PALETTE;
  return palette[stableHash(id) % palette.length] ?? palette[0] ?? "#0b6b4d";
}

/** Named style presets. A `styleId` that matches one of these gets a real, intended look rather than a hashed fallback colour. */
const NAMED_PRESETS: Readonly<Record<string, string>> = {
  neutral: "#5f6e66",
  accent: "#0b6b4d",
  warning: "#b4531b",
  critical: "#a03a3a",
  cool: "#3a5fa8",
};

/** Resolves a `styleId` to a colour: a named preset when one matches, otherwise a deterministic hashed one. */
export function styleRefColorFor(styleId: string): string {
  return NAMED_PRESETS[styleId.toLowerCase()] ?? paletteColorFor(`style:${styleId}`);
}

/** The colour a composed layer reads as, everywhere it is shown: its style-ref preset when it has one, otherwise its own identity colour. */
export function compositionLayerColor(layer: {
  readonly id: string;
  readonly styleRef?: { readonly styleId: string };
}): string {
  return layer.styleRef ? styleRefColorFor(layer.styleRef.styleId) : paletteColorFor(layer.id);
}
