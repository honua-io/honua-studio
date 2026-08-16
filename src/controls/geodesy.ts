/**
 * The geodesy two controls need: a `scale` bar's ground distance, and a
 * `measure` control's running length/area.
 *
 * Hand-rolled and spherical, for the same reason the rest of this app is
 * hand-rolled: adding a projection library to draw a scale bar and add up a
 * few great-circle segments would be a dependency bigger than the feature.
 * Spherical (R = 6 371 008.8 m, the WGS-84 mean radius) is accurate to about
 * 0.5% against the ellipsoid, which is well inside what a scale bar rounded
 * to a "nice" number or a measurement shown to three significant figures can
 * express.
 *
 * ADR-0031 admits `measure` precisely because it is transient and computes on
 * the client without persisting geometry anywhere — this module is that
 * computation, and it writes nothing.
 *
 * @module
 */

const EARTH_RADIUS_M = 6_371_008.8;
const DEG_TO_RAD = Math.PI / 180;

export interface LngLat {
  readonly lng: number;
  readonly lat: number;
}

/** Great-circle distance in metres between two points. */
export function haversineMeters(a: LngLat, b: LngLat): number {
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const dLat = lat2 - lat1;
  const dLng = (b.lng - a.lng) * DEG_TO_RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total length of a path in metres. A path of fewer than two points has no length. */
export function pathLengthMeters(points: readonly LngLat[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous && current) total += haversineMeters(previous, current);
  }
  return total;
}

/**
 * Spherical excess area of a closed ring, in square metres. The ring is
 * closed implicitly — the caller does not have to repeat the first point.
 * Fewer than three points enclose nothing.
 */
export function ringAreaSquareMeters(points: readonly LngLat[]): number {
  if (points.length < 3) return 0;
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (!current || !next) continue;
    total +=
      (next.lng - current.lng) *
      DEG_TO_RAD *
      (2 + Math.sin(current.lat * DEG_TO_RAD) + Math.sin(next.lat * DEG_TO_RAD));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

export type MeasurementUnit = "metric" | "imperial";

const FEET_PER_METER = 3.280839895;
const METERS_PER_MILE = 1609.344;
const SQUARE_METERS_PER_ACRE = 4046.8564224;
const SQUARE_METERS_PER_SQUARE_MILE = 2_589_988.110336;

/** Three significant figures, without scientific notation — the precision a measurement readout can honestly claim. */
function significant(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const decimals = Math.min(Math.max(0, 2 - magnitude), 3);
  const fixed = value.toFixed(decimals);
  // Trailing zeros are only noise AFTER a decimal point — stripping them
  // unconditionally turns 250 into 25, which is not a rounding error, it is a
  // wrong number on a scale bar.
  return decimals === 0 ? fixed : fixed.replace(/\.?0+$/, "");
}

/** Formats a distance in the unit system asked for, choosing the sensible sub-unit. */
export function formatDistance(meters: number, unit: MeasurementUnit): string {
  if (unit === "imperial") {
    const feet = meters * FEET_PER_METER;
    if (meters >= METERS_PER_MILE) return `${significant(meters / METERS_PER_MILE)} mi`;
    return `${significant(feet)} ft`;
  }
  if (meters >= 1000) return `${significant(meters / 1000)} km`;
  return `${significant(meters)} m`;
}

/** Formats an area in the unit system asked for. */
export function formatArea(squareMeters: number, unit: MeasurementUnit): string {
  if (unit === "imperial") {
    if (squareMeters >= SQUARE_METERS_PER_SQUARE_MILE) {
      return `${significant(squareMeters / SQUARE_METERS_PER_SQUARE_MILE)} sq mi`;
    }
    return `${significant(squareMeters / SQUARE_METERS_PER_ACRE)} acres`;
  }
  if (squareMeters >= 1_000_000) return `${significant(squareMeters / 1_000_000)} km²`;
  return `${significant(squareMeters)} m²`;
}

/**
 * Ground metres per screen pixel at a Web Mercator zoom and latitude — the
 * one number a scale bar is made of. MapLibre's tile size is 512 px, so a
 * zoom-0 tile spans the equator in 512 px.
 */
export function metersPerPixel(latitude: number, zoom: number): number {
  return (2 * Math.PI * EARTH_RADIUS_M * Math.cos(Math.min(Math.abs(latitude), 85) * DEG_TO_RAD)) / (512 * 2 ** zoom);
}

export interface ScaleBar {
  /** Bar width in CSS pixels — always ≤ the requested maximum. */
  readonly widthPx: number;
  /** The rounded ground distance the bar represents, already formatted. */
  readonly label: string;
}

/** Distances a scale bar is allowed to show: 1, 2, 3, 5 and their decades. Anything else reads as a measurement error. */
const NICE_STEPS = [1, 2, 3, 5, 10, 20, 30, 50, 100, 200, 300, 500];

/**
 * The largest "nice" distance whose bar fits in `maxWidthPx`. Returns
 * `undefined` when the camera cannot be read at all — a scale bar drawn from
 * a guessed camera is worse than no scale bar.
 */
export function computeScaleBar(
  camera: { readonly zoom: number; readonly center: readonly [number, number] } | undefined,
  maxWidthPx: number,
  unit: MeasurementUnit,
): ScaleBar | undefined {
  if (!camera || !Number.isFinite(camera.zoom)) return undefined;
  const perPixel = metersPerPixel(camera.center[1], camera.zoom);
  if (!Number.isFinite(perPixel) || perPixel <= 0) return undefined;
  const maxMeters = perPixel * Math.max(maxWidthPx, 24);

  if (unit === "imperial") {
    const maxFeet = maxMeters * FEET_PER_METER;
    if (maxMeters >= METERS_PER_MILE) {
      const miles = niceBelow(maxMeters / METERS_PER_MILE);
      return { widthPx: (miles * METERS_PER_MILE) / perPixel, label: `${significant(miles)} mi` };
    }
    const feet = niceBelow(maxFeet);
    return { widthPx: feet / FEET_PER_METER / perPixel, label: `${significant(feet)} ft` };
  }
  if (maxMeters >= 1000) {
    const km = niceBelow(maxMeters / 1000);
    return { widthPx: (km * 1000) / perPixel, label: `${significant(km)} km` };
  }
  const meters = niceBelow(maxMeters);
  return { widthPx: meters / perPixel, label: `${significant(meters)} m` };
}

/** The largest value of the form {1,2,3,5} x 10^n that is ≤ `value`. */
function niceBelow(value: number): number {
  if (!(value > 0)) return 0;
  const decade = 10 ** Math.floor(Math.log10(value));
  let best = decade;
  for (const step of NICE_STEPS) {
    const candidate = step * decade * 0.1;
    if (candidate <= value && candidate > best) best = candidate;
  }
  for (const step of NICE_STEPS) {
    const candidate = step * decade;
    if (candidate <= value && candidate > best) best = candidate;
  }
  return best;
}
