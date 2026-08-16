/**
 * `CompositionState` → `HonuaMapPackage` (honua-studio#23 REQ-001/REQ-002).
 *
 * This is the whole binding between the composition engine and the map, and
 * it is a **pure function**. That is the load-bearing design decision here,
 * for three reasons:
 *
 *  1. **No second reducer.** REQ-002 forbids a parallel reducer path. This
 *     module never holds state, never queues commands, and never decides
 *     what changed — `../composition/reducer.ts` remains the only thing that
 *     mutates composition state, and this projects whatever that produced.
 *     Diffing is not our job either: `./composition-map-view.ts` hands the
 *     composed style to MapLibre's own style differ (and, on the
 *     `HonuaClient` path, to the SDK's `HonuaMapRuntime.updatePackage`).
 *  2. **It is the ejectable artifact.** `HonuaMapPackage` is the SDK's own
 *     `honua_map_package.v1` shape, not a Studio-private render config. The
 *     same value this returns is what `loadMapPackage` consumes, what an
 *     "eject" would write, and what console can open (#1 REQ-006). Rendering
 *     through it means the preview and the artifact cannot drift apart.
 *  3. **It is testable in `environment: "node"`.** No DOM, no WebGL, no
 *     MapLibre import. `canonicalCompositionJson` over the result gives a
 *     byte-stable snapshot, which is how REQ-005's fixture determinism is
 *     actually enforced rather than asserted.
 *
 * Layer identity: a composed MapLibre layer keeps the composition layer's
 * own id. That is what makes a click on the map resolve straight back to a
 * `{ kind: "layer", id }` deictic target, and what lets a style-ref body
 * (keyed by MapLibre layer id, per the SDK's `applyStyleRefs`) address it.
 * Basemap furniture is namespaced under {@link BASEMAP_ID_PREFIX} so the two
 * can never collide.
 *
 * @module
 */

import type { HonuaMapPackage, HonuaMapPackageSourceBinding, HonuaStyleRefBody } from "@honua/sdk-js/runtime";
import type { HonuaLayerSpecification, HonuaStyleSpecification } from "@honua/sdk-js/style";

import type { CompositionLayer, CompositionState } from "../composition/model.js";
import { type BasemapStyle, createOfflineBasemapStyle } from "./basemap.js";
import { BASEMAP_ID_PREFIX, DEFAULT_MAP_PACKAGE_ID, OUTLINE_LAYER_SUFFIX } from "./constants.js";
import {
  type CompositionLayerType,
  type CompositionSourceDescriptor,
  isCompositionSourceResolution,
  resolveCompositionSource,
} from "./source-resolution.js";
import { defaultPaintFor, outlinePaintFor, paletteColorFor, styleRefFallbackOverride } from "./style-presets.js";

export { DEFAULT_MAP_PACKAGE_ID, OUTLINE_LAYER_SUFFIX };

export interface CompositionMapProjectionOptions {
  /** Sources the server advertises — in practice `StudioClient.listCatalog()`. Without it, only layers carrying a `metadata.honua.source` override can resolve. */
  readonly catalog?: readonly CompositionSourceDescriptor[];
  /** Server root for source URLs. Default `/api`. */
  readonly baseUrl?: string;
  /** Bounded page size for feature requests (#1 REQ-005). */
  readonly featureLimit?: number;
  /** Basemap to compose on top of. Default: the vendored offline basemap (REQ-003). */
  readonly basemap?: BasemapStyle;
  /** Real style-ref bodies keyed by `styleId`, when the caller could fetch them. A styleId absent here falls back to a deterministic preset — see `./style-presets.ts`. */
  readonly styleRefBodies?: Readonly<Record<string, HonuaStyleRefBody>>;
  readonly mapPackageId?: string;
}

/** One layer the map could not render, and why. Surfaced in the UI — never swallowed. */
export interface UnresolvedCompositionLayer {
  readonly layerId: string;
  readonly sourceId: string;
  readonly reason: string;
}

export interface CompositionMapProjection {
  readonly mapPackage: HonuaMapPackage;
  /** Composition layer ids that made it into the style, in draw order. */
  readonly renderedLayerIds: readonly string[];
  readonly unresolved: readonly UnresolvedCompositionLayer[];
}

function cloneStyle(style: BasemapStyle): HonuaStyleSpecification {
  return {
    ...style,
    sources: { ...style.sources },
    layers: style.layers.map((layer) => ({ ...layer })),
  };
}

/** The MapLibre layer type a composed layer renders as. Kept separate from the archetype so `raster` can never reach a vector paint helper. */
function maplibreLayerType(layerType: CompositionLayerType): string {
  return layerType;
}

function buildComposedLayer(
  layer: CompositionLayer,
  layerType: CompositionLayerType,
  sourceId: string,
): HonuaLayerSpecification {
  const color = paletteColorFor(layer.id);
  const spec: HonuaLayerSpecification = {
    id: layer.id,
    type: maplibreLayerType(layerType),
    source: sourceId,
    paint: defaultPaintFor(layerType, color),
    metadata: {
      "honua:compositionLayerId": layer.id,
      "honua:compositionSourceId": layer.sourceId,
      ...(layer.title ? { "honua:title": layer.title } : {}),
    },
  };
  // `visible: false` hides the layer without removing it — the composition
  // still holds it, the readout still lists it, and re-showing it is a
  // layout flip rather than a source reload.
  if (!layer.visible) spec.layout = { visibility: "none" };
  return spec;
}

/**
 * Projects composition state onto a `honua_map_package.v1` package whose
 * `mapSpec` is a ready-to-render MapLibre style. Never throws: a layer whose
 * source cannot be resolved is reported in `unresolved` and omitted from the
 * style, exactly like the SDK loader's default tolerant policy.
 */
export function compositionToMapPackage(
  state: CompositionState,
  options: CompositionMapProjectionOptions = {},
): CompositionMapProjection {
  const mapSpec = cloneStyle(options.basemap ?? createOfflineBasemapStyle());
  const sourceBindings: HonuaMapPackageSourceBinding[] = [];
  const styleRefs: { styleId: string; body?: HonuaStyleRefBody }[] = [];
  const unresolved: UnresolvedCompositionLayer[] = [];
  const renderedLayerIds: string[] = [];
  const boundSourceIds = new Set<string>();

  for (const layer of state.layers) {
    const resolution = resolveCompositionSource(layer, {
      ...(options.catalog !== undefined ? { catalog: options.catalog } : {}),
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(options.featureLimit !== undefined ? { featureLimit: options.featureLimit } : {}),
    });
    if (!isCompositionSourceResolution(resolution)) {
      unresolved.push({ layerId: layer.id, sourceId: layer.sourceId, reason: resolution.reason });
      continue;
    }

    // Several composition layers may share one catalog source (the same
    // dataset styled two ways); the source is materialized once.
    const styleSourceId = layer.sourceId;
    if (!boundSourceIds.has(styleSourceId)) {
      boundSourceIds.add(styleSourceId);
      mapSpec.sources[styleSourceId] = resolution.source as HonuaStyleSpecification["sources"][string];
      if (resolution.binding) sourceBindings.push(resolution.binding as HonuaMapPackageSourceBinding);
    }

    mapSpec.layers.push(buildComposedLayer(layer, resolution.layerType, styleSourceId));
    if (resolution.layerType === "fill") {
      mapSpec.layers.push({
        id: `${layer.id}${OUTLINE_LAYER_SUFFIX}`,
        type: "line",
        source: styleSourceId,
        paint: outlinePaintFor(paletteColorFor(layer.id)),
        ...(layer.visible ? {} : { layout: { visibility: "none" } }),
      });
    }
    renderedLayerIds.push(layer.id);

    if (layer.styleRef) {
      const supplied = options.styleRefBodies?.[layer.styleRef.styleId];
      const body: HonuaStyleRefBody = supplied ?? {
        [layer.id]: styleRefFallbackOverride(layer.styleRef.styleId, resolution.layerType),
      };
      styleRefs.push({ styleId: layer.styleRef.styleId, body });
    }
  }

  const initialView = projectInitialView(state);
  const mapPackage: HonuaMapPackage = {
    mapPackageId: options.mapPackageId ?? DEFAULT_MAP_PACKAGE_ID,
    format: "honua_map_package.v1",
    sourceBindings,
    mapSpec,
    ...(styleRefs.length > 0 ? { styleRefs } : {}),
    ...(initialView ? { initialView } : {}),
    ...(renderedLayerIds.length > 0
      ? {
          legend: renderedLayerIds.map((layerId) => ({
            label: state.layers.find((layer) => layer.id === layerId)?.title ?? layerId,
            color: paletteColorFor(layerId),
          })),
        }
      : {}),
  };

  return { mapPackage, renderedLayerIds, unresolved };
}

/** `CompositionView` → `HonuaMapPackageInitialView`. Returns `undefined` for an entirely unset view so the package omits the field rather than carrying an empty object. */
function projectInitialView(state: CompositionState): HonuaMapPackage["initialView"] | undefined {
  const { bbox, center, zoom, pitch, bearing } = state.view;
  if (
    bbox === undefined &&
    center === undefined &&
    zoom === undefined &&
    pitch === undefined &&
    bearing === undefined
  ) {
    return undefined;
  }
  return {
    ...(bbox !== undefined ? { bbox } : {}),
    ...(center !== undefined ? { center } : {}),
    ...(zoom !== undefined ? { zoom } : {}),
    ...(pitch !== undefined ? { pitch } : {}),
    ...(bearing !== undefined ? { bearing } : {}),
  };
}

/** True when `layerId` names basemap furniture rather than a composed layer — used by the click handler to ignore basemap hits. */
export function isBasemapLayerId(layerId: string): boolean {
  return layerId.startsWith(BASEMAP_ID_PREFIX);
}

/** True when `layerId` is a companion outline rather than a composition layer proper. */
export function isOutlineLayerId(layerId: string): boolean {
  return layerId.endsWith(OUTLINE_LAYER_SUFFIX);
}
