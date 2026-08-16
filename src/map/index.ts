/**
 * The composition map surface (honua-studio#23).
 *
 * Import shape matters here. `<honua-studio-canvas>` reaches this module
 * through a **dynamic** `import("../map/index.js")`, and nothing in this
 * barrel imports `maplibre-gl` at module scope — only
 * `defaultCompositionMapFactory` does, and only when it is actually called.
 * The consequence is that the vendored basemap geometry and the WebGL
 * renderer land in a lazy chunk instead of Studio's entry bundle, and that
 * `environment: "node"` unit tests can exercise the projection, the source
 * resolution, the presets, and the whole update pipeline (against an
 * injected fake map) without a browser.
 *
 * Layering, outermost first:
 *
 *   composition state ──> map-package-projection ──> composition-map-view
 *                            │        │                      │
 *                    source-resolution│               MapLibre GL JS
 *                            style-presets / basemap
 *
 * `agent-map-kit` sits beside all of it: same composition controller, but
 * projected onto the SDK's `HonuaAgentRuntime` so `createHonuaAiMapKit` can
 * serve the tool plane (REQ-002). See that module for the sdk-js#1259
 * `StudioAgentSession` seam.
 *
 * @module
 */

export {
  BASEMAP_ID_PREFIX,
  OFFLINE_BASEMAP_ATTRIBUTION,
  basemapPaletteFor,
  createGraticule,
  createOfflineBasemapStyle,
} from "./basemap.js";
export type { BasemapPalette, BasemapStyle, BasemapTheme, OfflineBasemapOptions } from "./basemap.js";

export {
  DEFAULT_MAP_PACKAGE_ID,
  OUTLINE_LAYER_SUFFIX,
  compositionToMapPackage,
  isBasemapLayerId,
  isOutlineLayerId,
} from "./map-package-projection.js";
export type {
  CompositionMapProjection,
  CompositionMapProjectionOptions,
  UnresolvedCompositionLayer,
} from "./map-package-projection.js";

export {
  isCompositionSourceResolution,
  layerTypeForGeometry,
  resolveCompositionSource,
} from "./source-resolution.js";
export type {
  CompositionLayerType,
  CompositionSourceBinding,
  CompositionSourceDescriptor,
  CompositionSourceResolution,
  CompositionSourceResolutionFailure,
  MapPackageProtocol,
  ResolveCompositionSourceOptions,
} from "./source-resolution.js";

export {
  COMPOSITION_LAYER_PALETTE,
  defaultPaintFor,
  outlinePaintFor,
  paletteColorFor,
  stableHash,
  styleRefColorFor,
  styleRefFallbackOverride,
} from "./style-presets.js";

export {
  CompositionMapView,
  compositionTargetsFromFeatures,
  defaultCompositionMapFactory,
  isWebglAvailable,
} from "./composition-map-view.js";
export type {
  CompositionMapFactory,
  CompositionMapFactoryOptions,
  CompositionMapLike,
  CompositionMapStatus,
  CompositionMapViewOptions,
} from "./composition-map-view.js";

export { MAPLIBRE_CSS } from "./maplibre-styles.js";

export { createCompositionAgentRuntime, createStudioAiMapKit } from "./agent-map-kit.js";
export type { CompositionAgentRuntimeOptions, StudioAiMapKitOptions } from "./agent-map-kit.js";
