/**
 * The **vendored, offline** basemap the composition map draws on top of
 * (honua-studio#23 REQ-003: "no runtime CDN dependency" — honua-console#333
 * is the same bug in the other direction and this repo must not repeat it).
 *
 * Every byte this module needs is already in the bundle: the land geometry
 * is `./assets/natural-earth-land-110m.json` (public-domain Natural Earth
 * 1:110m, see that directory's README for provenance and how to re-vendor
 * it), and the graticule is *generated*, not stored. There is no tile
 * server, no sprite URL, and no glyph URL — which is also why the basemap
 * carries no labels: MapLibre cannot render text without a glyph endpoint,
 * and pointing at a public one would be exactly the CDN dependency REQ-003
 * forbids. A deployment with its own style/tile/glyph server overrides the
 * whole thing (`<honua-studio-canvas>.basemapStyle`).
 *
 * The palettes below are deliberately plain literals rather than reads of
 * the `--hn-*` theme custom properties: MapLibre paint values are resolved
 * inside a WebGL renderer that never sees CSS, so a `var(--hn-surface)`
 * string would simply fail to parse. `basemapPaletteFor()` maps the theme
 * mode Studio already knows about onto colours chosen to sit under the
 * Studio surface tokens rather than fight them.
 *
 * @module
 */

import type { HonuaLayerSpecification, HonuaStyleSpecification } from "@honua/sdk-js/style";

import landGeoJson from "./assets/natural-earth-land-110m.json";
import { BASEMAP_ID_PREFIX } from "./constants.js";

export { BASEMAP_ID_PREFIX };

/** Credited in the MapLibre attribution control. Natural Earth is public domain; we credit it because it is right, not because a licence compels it. */
export const OFFLINE_BASEMAP_ATTRIBUTION = "Natural Earth (public domain) · vendored offline";

export type BasemapTheme = "light" | "dark";

export interface BasemapPalette {
  /** Ocean / page ground. */
  readonly water: string;
  /** Land fill. */
  readonly land: string;
  /** Coastline stroke. */
  readonly coast: string;
  /** Graticule stroke. */
  readonly graticule: string;
}

// Land has to read as land against water at a glance, and the coastline has
// to survive being drawn under a composed layer — a basemap you have to
// squint at is not doing its job. These are deliberately a step more
// contrasted than Studio's surface tokens.
const LIGHT_PALETTE: BasemapPalette = {
  water: "#cfdfea",
  land: "#eeeade",
  coast: "#8b9a8f",
  graticule: "#bccbd6",
};

const DARK_PALETTE: BasemapPalette = {
  water: "#0b161d",
  land: "#212e26",
  coast: "#546a5b",
  graticule: "#243642",
};

export function basemapPaletteFor(theme: BasemapTheme): BasemapPalette {
  return theme === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
}

/** A MapLibre GeoJSON source spec carrying inline data — the only source kind a fully offline basemap can use. */
export interface InlineGeoJsonSource {
  readonly type: "geojson";
  readonly data: unknown;
  readonly attribution?: string;
  /** Widens the shape to the SDK's `HonuaStyleSpecification["sources"]` member, which is index-signature-open for forward compatibility. */
  readonly [extra: string]: unknown;
}

/**
 * The style document type used throughout `src/map` — the SDK's own
 * `HonuaStyleSpecification` (a MapLibre Style Spec v8 document widened with
 * Honua source types), imported **type-only** from `@honua/sdk-js/style`.
 * Type-only keeps `maplibre-gl` out of this module's runtime graph, which
 * matters: `./composition-map-view.ts` must be the single place that loads
 * MapLibre, and it loads it dynamically.
 */
export type BasemapStyle = HonuaStyleSpecification;

export interface OfflineBasemapOptions {
  readonly theme?: BasemapTheme;
  /** Graticule spacing in degrees. `0` omits the graticule entirely. Default 10. */
  readonly graticuleStepDegrees?: number;
}

/**
 * Builds the graticule as a GeoJSON `MultiLineString`. Meridians are drawn
 * as two-point segments (a great-circle meridian is a straight line in Web
 * Mercator); parallels are sampled every 10° of longitude so they stay
 * straight-ish under the projection MapLibre applies.
 *
 * Pure and deterministic — the same `step` always yields the identical
 * feature, which is what lets the projection's canonical JSON stay stable.
 */
export function createGraticule(stepDegrees = 10): {
  type: "Feature";
  geometry: { type: "MultiLineString"; coordinates: number[][][] };
  properties: Record<string, never>;
} {
  const step = Number.isFinite(stepDegrees) && stepDegrees > 0 ? stepDegrees : 10;
  const lines: number[][][] = [];
  // Web Mercator is undefined at the poles; MapLibre clamps at ±85.051129.
  const maxLatitude = 85;
  for (let longitude = -180; longitude <= 180; longitude += step) {
    lines.push([
      [longitude, -maxLatitude],
      [longitude, maxLatitude],
    ]);
  }
  for (let latitude = -80; latitude <= 80; latitude += step) {
    const parallel: number[][] = [];
    for (let longitude = -180; longitude <= 180; longitude += 10) parallel.push([longitude, latitude]);
    lines.push(parallel);
  }
  return { type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: lines } };
}

/**
 * The default composition basemap: an ocean background, vendored land with a
 * coastline stroke, and a generated graticule. No network access of any kind.
 */
export function createOfflineBasemapStyle(options: OfflineBasemapOptions = {}): BasemapStyle {
  const palette = basemapPaletteFor(options.theme ?? "light");
  const step = options.graticuleStepDegrees ?? 10;
  const sources: Record<string, InlineGeoJsonSource> = {
    [`${BASEMAP_ID_PREFIX}land`]: {
      type: "geojson",
      data: landGeoJson,
      attribution: OFFLINE_BASEMAP_ATTRIBUTION,
    },
  };
  const layers: HonuaLayerSpecification[] = [
    { id: `${BASEMAP_ID_PREFIX}water`, type: "background", paint: { "background-color": palette.water } },
    {
      id: `${BASEMAP_ID_PREFIX}land`,
      type: "fill",
      source: `${BASEMAP_ID_PREFIX}land`,
      paint: { "fill-color": palette.land },
    },
  ];
  if (step > 0) {
    sources[`${BASEMAP_ID_PREFIX}graticule`] = { type: "geojson", data: createGraticule(step) };
    layers.push({
      id: `${BASEMAP_ID_PREFIX}graticule`,
      type: "line",
      source: `${BASEMAP_ID_PREFIX}graticule`,
      paint: { "line-color": palette.graticule, "line-width": 0.6 },
    });
  }
  layers.push({
    id: `${BASEMAP_ID_PREFIX}coast`,
    type: "line",
    source: `${BASEMAP_ID_PREFIX}land`,
    paint: { "line-color": palette.coast, "line-width": 1 },
  });
  return { version: 8, name: "Honua Studio offline basemap", sources, layers };
}
