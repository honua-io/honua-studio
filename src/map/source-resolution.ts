/**
 * Turns a {@link CompositionLayer}'s bare `sourceId` into something MapLibre
 * can actually draw (honua-studio#23 REQ-001).
 *
 * Composition state deliberately carries *only* a `sourceId` — it is a
 * projection of a Studio package draft, not a renderer configuration (see
 * `../composition/model.ts`'s AD-8 note). Something has to close the gap
 * between "the agent added layer `hi-parcels`" and "MapLibre needs a source
 * spec and a layer type", and that something is this module.
 *
 * It resolves in three steps, most specific first:
 *
 *  1. **The layer says so.** `layer.metadata.honua.source` (a raw MapLibre
 *     source spec) wins outright. This is the seam a GP output, a
 *     `StudioAgentSession` verb (sdk-js#1259, unmerged — see
 *     `./index.ts`'s note), or any future server-authored binding uses to
 *     hand us a fully-formed source without teaching this module a new
 *     protocol.
 *  2. **The catalog says so.** The `protocol`/`geometryType` a
 *     {@link CompositionSourceDescriptor} advertises (in practice
 *     `StudioClient.listCatalog()`'s `CatalogDataset`) is projected onto the
 *     server route that protocol is served at.
 *  3. **Nothing says so.** The layer resolves to `undefined` with a reason.
 *     It is NOT silently dropped: the projection records it in
 *     `unresolved[]`, the canvas surfaces it, and the readout still lists
 *     the layer. An unrenderable layer is a visible fact, not a missing row.
 *
 * Two shapes come out of a successful resolution because two different
 * consumers need them: `binding` is the durable
 * {@link HonuaMapPackageSourceBinding} that belongs on the map package (and
 * therefore in an ejected artifact), and `source` is the native MapLibre
 * source spec the offline/no-`HonuaClient` render path hands straight to
 * `map.setStyle`. When Studio runs against a real server with a
 * `HonuaClient`, the SDK's `loadMapPackage` consumes `binding` and produces
 * its own richer source — which is exactly why `binding` is emitted even
 * though today's render path does not read it.
 *
 * @module
 */

import type { CompositionLayer } from "../composition/model.js";

/** Wire-format protocol values on a `HonuaMapPackageSourceBinding` (snake_case, per the SDK's `HonuaMapPackageProtocol`). */
export type MapPackageProtocol =
  | "geoservices_feature_service"
  | "geoservices_map_service"
  | "ogc_features"
  | "ogc_tiles"
  | "wfs"
  | "wms"
  | "wmts"
  | "vector_tile"
  | "raster_tile"
  | "pmtiles";

/** A durable source binding — structurally the SDK's `HonuaMapPackageSourceBinding`. */
export interface CompositionSourceBinding {
  readonly sourceId: string;
  readonly protocol: MapPackageProtocol;
  readonly locator: Readonly<Record<string, unknown>>;
  readonly attribution?: string;
}

/** What the catalog advertises about a source. Mirrors `StudioClient`'s `CatalogDataset` so a catalog listing can be passed straight through. */
export interface CompositionSourceDescriptor {
  readonly id: string;
  readonly title?: string;
  /** Kebab-case SDK protocol id as the Studio catalog serves it (`ogc-features`, `geoservices-feature-service`, …). */
  readonly protocol?: string;
  readonly geometryType?: string;
}

/** The MapLibre layer archetype a source's geometry calls for. */
export type CompositionLayerType = "fill" | "line" | "circle" | "raster";

export interface CompositionSourceResolution {
  readonly binding?: CompositionSourceBinding;
  /** Native MapLibre source spec — what the offline render path actually uses. */
  readonly source: Readonly<Record<string, unknown>>;
  readonly layerType: CompositionLayerType;
}

export interface CompositionSourceResolutionFailure {
  readonly reason: string;
}

export interface ResolveCompositionSourceOptions {
  /** Server root the client already talks to. Default `/api`, matching `StudioClient`'s own default. */
  readonly baseUrl?: string;
  /** Bounded page size for feature requests — the data plane stays bounded (#1 REQ-005). Default 2000. */
  readonly featureLimit?: number;
  readonly catalog?: readonly CompositionSourceDescriptor[];
}

const DEFAULT_BASE_URL = "/api";
const DEFAULT_FEATURE_LIMIT = 2000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Reads `layer.metadata.honua` — the per-layer renderer escape hatch described in this module's doc. */
function honuaMetadata(layer: CompositionLayer): Record<string, unknown> | undefined {
  const honua = layer.metadata?.honua;
  return isPlainObject(honua) ? honua : undefined;
}

/**
 * Geometry type -> MapLibre layer archetype. Deliberately generous about
 * spelling: a Honua catalog may report GeoJSON (`Polygon`, `MultiPolygon`),
 * OGC (`multipolygon`), or Esri (`esriGeometryPolyline`) vocabulary depending
 * on which adapter published the source, and a layer that fails to render
 * because its catalog entry said "polyline" instead of "LineString" would be
 * an infuriating and entirely avoidable bug.
 */
export function layerTypeForGeometry(geometryType: string | undefined): CompositionLayerType | undefined {
  if (!geometryType) return undefined;
  const normalized = geometryType
    .toLowerCase()
    .replace(/[^a-z]/g, "")
    .replace(/^esrigeometry/, "")
    .replace(/^multi/, "");
  if (normalized === "polygon") return "fill";
  if (normalized === "linestring" || normalized === "line" || normalized === "polyline") return "line";
  if (normalized === "point") return "circle";
  if (normalized === "raster" || normalized === "image") return "raster";
  return undefined;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * Resolves one composition layer. Returns either a resolution or a failure
 * with a human-readable reason — never throws, because one unrenderable
 * layer must not take the rest of the map down with it (the same tolerance
 * the SDK's own `sourceErrorPolicy: "tolerant"` default encodes).
 */
export function resolveCompositionSource(
  layer: CompositionLayer,
  options: ResolveCompositionSourceOptions = {},
): CompositionSourceResolution | CompositionSourceResolutionFailure {
  const baseUrl = trimTrailingSlash(options.baseUrl ?? DEFAULT_BASE_URL);
  const limit = options.featureLimit ?? DEFAULT_FEATURE_LIMIT;

  const metadata = honuaMetadata(layer);
  const inlineSource = metadata?.source;
  if (isPlainObject(inlineSource)) {
    const declaredType = typeof metadata?.layerType === "string" ? metadata.layerType : undefined;
    const layerType =
      (declaredType as CompositionLayerType | undefined) ??
      layerTypeForGeometry(typeof metadata?.geometryType === "string" ? metadata.geometryType : undefined);
    return { source: inlineSource, layerType: layerType ?? "fill" };
  }

  const descriptor = options.catalog?.find((entry) => entry.id === layer.sourceId);
  if (!descriptor) {
    return {
      reason: `Source "${layer.sourceId}" is not in the catalog, and the layer carries no metadata.honua.source override.`,
    };
  }

  const geometryLayerType = layerTypeForGeometry(descriptor.geometryType);
  if (geometryLayerType === "raster") {
    return {
      reason: `Source "${layer.sourceId}" is raster (${descriptor.geometryType}); the composition map renders vector sources only so far.`,
    };
  }

  const protocol = descriptor.protocol;
  if (protocol === "ogc-features") {
    return {
      binding: {
        sourceId: layer.sourceId,
        protocol: "ogc_features",
        locator: { url: `${baseUrl}/ogc`, collectionId: layer.sourceId },
      },
      source: {
        type: "geojson",
        data: `${baseUrl}/ogc/collections/${encodeURIComponent(layer.sourceId)}/items?f=json&limit=${limit}`,
      },
      layerType: geometryLayerType ?? "fill",
    };
  }
  if (protocol === "geoservices-feature-service") {
    const serviceUrl = `${baseUrl}/rest/services/${encodeURIComponent(layer.sourceId)}/FeatureServer/0`;
    return {
      binding: {
        sourceId: layer.sourceId,
        protocol: "geoservices_feature_service",
        locator: { url: serviceUrl, layerId: 0 },
      },
      source: {
        type: "geojson",
        data: `${serviceUrl}/query?where=1%3D1&outFields=*&f=geojson&resultRecordCount=${limit}`,
      },
      layerType: geometryLayerType ?? "fill",
    };
  }

  return {
    reason: `Source "${layer.sourceId}" advertises protocol "${protocol ?? "unknown"}", which the composition map cannot render yet.`,
  };
}

export function isCompositionSourceResolution(
  value: CompositionSourceResolution | CompositionSourceResolutionFailure,
): value is CompositionSourceResolution {
  return (value as CompositionSourceResolution).source !== undefined;
}
