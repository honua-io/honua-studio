/**
 * Leaf constants shared across `src/map/` (honua-studio#23).
 *
 * They live in their own module for a bundling reason, not a stylistic one:
 * `./basemap.ts` imports 86 KB of vendored land geometry, so anything that
 * merely needs an id string must be able to reach it without dragging that
 * import along. `../elements/studio-app-element.ts` reaches
 * `./agent-map-kit.ts` eagerly (the AI map kit is a synchronous getter);
 * routing its `DEFAULT_MAP_PACKAGE_ID` through here is what keeps the
 * basemap and MapLibre in the lazy map chunk where they belong.
 *
 * @module
 */

/** Every basemap layer/source id starts with this — the projection reserves it so a composition layer can never collide with basemap furniture. */
export const BASEMAP_ID_PREFIX = "honua-basemap-";

/** Suffix of the companion `line` layer a polygon layer gets so shapes read as shapes. Never a composition target — the fill layer owns the layer's identity. */
export const OUTLINE_LAYER_SUFFIX = "__outline";

/** `mapPackageId` for the package a composition projects to when no host names one. */
export const DEFAULT_MAP_PACKAGE_ID = "honua-studio-composition";
