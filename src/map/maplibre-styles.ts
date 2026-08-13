/**
 * MapLibre GL JS's own stylesheet, as a string (honua-studio#23 REQ-003).
 *
 * Two reasons it is imported `?inline` rather than linked or side-effect
 * imported:
 *
 *  - **Shadow DOM.** `<honua-studio-canvas>` renders into an open shadow
 *    root, and a document-level stylesheet does not cross that boundary.
 *    The canvas injects this string into its own `<style>` so MapLibre's
 *    controls, attribution, and popups are styled inside the element.
 *  - **No CDN, ever.** The bytes ship in the bundle. There is no `<link>`
 *    to unpkg, no `@import`, and the file's own `url(...)` values are all
 *    `data:` URIs, so nothing here resolves to a network fetch at runtime.
 *
 * It lives in `src/map/` — not `src/elements/styles.ts` — so it is part of
 * the lazily imported map chunk. Studio's entry bundle should not carry
 * 70 KB of renderer CSS for a session that never opens the map.
 *
 * @module
 */

import maplibreCss from "maplibre-gl/dist/maplibre-gl.css?inline";

export const MAPLIBRE_CSS: string = maplibreCss;
