/**
 * Paint for composed layers, and the offline fallback for a
 * {@link CompositionStyleRef} whose real body Studio cannot fetch
 * (honua-studio#23 REQ-001/REQ-005).
 *
 * Two separate jobs live here, and the difference matters:
 *
 *  - **Default paint.** A layer the agent just added has no style of its
 *    own yet. It still has to be *visible* and *distinguishable* from the
 *    layer added before it, so each layer gets a colour derived from a hash
 *    of its id. Hashing the id (rather than counting layers) means adding
 *    `roads` never recolours `parcels` — the map mutates only where the
 *    composition actually changed, which is the whole point of a surface
 *    that streams.
 *
 *  - **Style-ref fallback.** `setLayerStyleRef` names a `styleId` that lives
 *    on the server's OGC API – Styles surface. Offline (and in fixture mode,
 *    which is CI's only mode — REQ-005) there is nothing to fetch. Rather
 *    than render the style-ref as a no-op — which would make
 *    `setLayerStyleRef` look broken, since the map would not move — the
 *    projection substitutes a deterministic preset derived from the styleId
 *    and tags the layer's `metadata` with `honua:styleRefFallback` so the
 *    substitution is auditable rather than invisible. A caller that CAN
 *    resolve real bodies passes them to `compositionToMapPackage` as
 *    `styleRefBodies` and this fallback never runs.
 *
 * Everything here is pure and deterministic: the same composition always
 * produces byte-identical paint, which is what lets the projection be
 * snapshot-tested (REQ-005).
 *
 * @module
 */

import type { CompositionLayerType } from "./source-resolution.js";

/**
 * Qualitative palette for composed layers. Chosen for contrast against the
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

/** Named style presets. A `styleId` that matches one of these gets a real, intended look rather than a hashed fallback colour. */
const NAMED_PRESETS: Readonly<Record<string, string>> = {
  neutral: "#5f6e66",
  accent: "#0b6b4d",
  warning: "#b4531b",
  critical: "#a03a3a",
  cool: "#3a5fa8",
};

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

/** Deterministic palette entry for an id. */
export function paletteColorFor(id: string): string {
  const palette = COMPOSITION_LAYER_PALETTE;
  return palette[stableHash(id) % palette.length] ?? palette[0] ?? "#0b6b4d";
}

/** Resolves a `styleId` to a colour: a named preset when one matches, otherwise a deterministic hashed one. */
export function styleRefColorFor(styleId: string): string {
  return NAMED_PRESETS[styleId.toLowerCase()] ?? paletteColorFor(`style:${styleId}`);
}

/** MapLibre `paint` for a layer archetype in a given colour. */
export function defaultPaintFor(layerType: CompositionLayerType, color: string): Record<string, unknown> {
  switch (layerType) {
    case "fill":
      return { "fill-color": color, "fill-opacity": 0.45 };
    case "line":
      return { "line-color": color, "line-width": 1.75 };
    case "circle":
      return { "circle-color": color, "circle-radius": 4, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1 };
    case "raster":
      return { "raster-opacity": 1 };
  }
}

/** MapLibre `paint` for the companion outline a `fill` layer gets, so polygons read as shapes rather than blobs. */
export function outlinePaintFor(color: string): Record<string, unknown> {
  return { "line-color": color, "line-width": 1 };
}

/**
 * The offline substitute for a style-ref body: the same paint shape the
 * layer already uses, recoloured to the styleId's preset colour, plus the
 * `honua:styleRefFallback` audit marker described in this module's doc.
 */
export function styleRefFallbackOverride(styleId: string, layerType: CompositionLayerType): Record<string, unknown> {
  return {
    paint: defaultPaintFor(layerType, styleRefColorFor(styleId)),
    metadata: { "honua:styleRefFallback": styleId },
  };
}
