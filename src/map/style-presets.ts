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

import { COMPOSITION_LAYER_PALETTE, paletteColorFor, stableHash, styleRefColorFor } from "../composition/palette.js";
import type { CompositionLayerType } from "./source-resolution.js";

/**
 * The palette, its hash, the per-id colour, and the style-ref preset lookup
 * moved to `../composition/palette.ts` in honua-studio#24 so the legend and
 * layer-list widgets can show the same swatch this module paints without
 * dragging `src/map/` into the entry bundle. Re-exported here because this is
 * still where every paint consumer looks for them.
 */
export { COMPOSITION_LAYER_PALETTE, paletteColorFor, stableHash, styleRefColorFor };

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

/**
 * The paint property a layer archetype fades through, and the base value it
 * fades from. honua-studio#25's `opacity` control multiplies the archetype's
 * own default rather than overwriting it, so dragging a fill layer's slider
 * to 100% restores the 0.45 wash the projection chose — not an opaque slab
 * that hides everything beneath it.
 */
export function opacityPaintFor(layerType: CompositionLayerType, value: number): Record<string, unknown> {
  const clamped = Math.min(Math.max(value, 0), 1);
  switch (layerType) {
    case "fill":
      return { "fill-opacity": 0.45 * clamped };
    case "line":
      return { "line-opacity": clamped };
    case "circle":
      return { "circle-opacity": clamped, "circle-stroke-opacity": clamped };
    case "raster":
      return { "raster-opacity": clamped };
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
export function styleRefFallbackOverride(
  styleId: string,
  layerType: CompositionLayerType,
  opacity?: number,
): Record<string, unknown> {
  return {
    // The override replaces the layer's whole `paint`, so a runtime opacity
    // (honua-studio#25) has to be folded in HERE as well as in the projected
    // layer. Without this, an `opacity` control on a style-ref'd layer moves
    // and nothing happens — the override silently restores the archetype's
    // default, which is exactly the "control that changes nothing" failure
    // this issue exists to prevent.
    paint: {
      ...defaultPaintFor(layerType, styleRefColorFor(styleId)),
      ...(opacity !== undefined ? opacityPaintFor(layerType, opacity) : {}),
    },
    metadata: { "honua:styleRefFallback": styleId },
  };
}
