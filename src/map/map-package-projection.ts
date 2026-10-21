import { compositionStyleOverride } from "../styles/composition-style-override.js";
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

import { type CompositionLayer, type CompositionState, canonicalCompositionJson } from "../composition/model.js";
import type { BoundAuthoritativeStyle } from "../styles/authoritative-style-provider.js";
import { type BasemapStyle, createOfflineBasemapStyle } from "./basemap.js";
import { BASEMAP_ID_PREFIX, DEFAULT_MAP_PACKAGE_ID, OUTLINE_LAYER_SUFFIX } from "./constants.js";
import {
  type CompositionLayerType,
  type CompositionSourceDescriptor,
  findCompositionSourceDescriptor,
  hasCompositionSourceOverride,
  isAnonymousMapAssetSource,
  isCompositionSourceResolution,
  isStaticInlineCompositionSource,
  resolveCompositionSource,
  usesHonuaStyleCatalog,
} from "./source-resolution.js";
import {
  defaultPaintFor,
  opacityPaintFor,
  outlinePaintFor,
  paletteColorFor,
  styleRefFallbackOverride,
} from "./style-presets.js";

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
  /** When supplied, a missing/failed canonical style is visible instead of a preset fallback. */
  readonly authoritativeStyles?: Readonly<Record<string, BoundAuthoritativeStyle | { reason: string }>>;
  /**
   * Runtime appearance a control produced (honua-studio#25): per composition
   * layer id, a MapLibre filter expression and/or an opacity multiplier.
   *
   * These are **projection inputs, not composition state**. Applying them
   * imperatively (`map.setFilter`) would be reverted by the next
   * `setStyle(…, { diff: true })` — composition correct, readout correct,
   * nothing thrown, and the filter silently gone. And they are not stored in
   * the document because `StudioCompositionBody` has no member for them; they
   * are session state, and the SDK's exploration context owns them (see
   * `../interactions/studio-interactions.ts`).
   */
  readonly appearance?: CompositionLayerAppearance;
  /** Read-only rendering resolves live sources against the current reader's catalog, even in full map specs. */
  readonly sourceAuthority?: "authored" | "current-reader";
}

/** Per-composition-layer runtime appearance. Mirrors `../interactions/studio-interactions.ts`'s `StudioLayerAppearance`, declared here so `src/map/` does not depend on the interaction runtime. */
export interface CompositionLayerAppearance {
  readonly filters?: Readonly<Record<string, unknown>>;
  readonly opacity?: Readonly<Record<string, number>>;
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

function ownedByCompositionLayer(renderLayer: HonuaLayerSpecification, layerId: string): boolean {
  return (
    renderLayer.id === layerId ||
    renderLayer.id === `${layerId}${OUTLINE_LAYER_SUFFIX}` ||
    renderLayer.metadata?.["honua:compositionLayerId"] === layerId
  );
}

// These options affect GeoJSON presentation or feature identity, never its
// network authority. The current-reader resolution alone supplies type/data.
const GEOJSON_SOURCE_OPTIONS = new Set([
  "attribution",
  "maxzoom",
  "buffer",
  "tolerance",
  "cluster",
  "clusterRadius",
  "clusterMaxZoom",
  "clusterMinPoints",
  "clusterProperties",
  "lineMetrics",
  "generateId",
  "promoteId",
  "filter",
]);

function rebindAudienceGeoJson(
  saved: HonuaStyleSpecification["sources"][string] | undefined,
  source: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (saved?.type !== "geojson" || source.type !== "geojson") return source;
  const options = Object.fromEntries(Object.entries(saved).filter(([key]) => GEOJSON_SOURCE_OPTIONS.has(key)));
  return { ...structuredClone(options), ...source };
}

/** Resolve an audience source without letting a saved URL in either source escape hatch authorize itself. */
function resolveAudienceSource(
  layer: CompositionLayer,
  savedSource: unknown,
  options: CompositionMapProjectionOptions,
): ReturnType<typeof resolveCompositionSource> {
  if ((options.catalog?.filter((entry) => entry.id === layer.sourceId).length ?? 0) > 1)
    return { reason: `Source "${layer.sourceId}" has ambiguous entries in the current-reader catalog.` };
  const metadata = layer.metadata?.honua;
  const honua =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : undefined;
  const override = honua?.source;
  const descriptor = findCompositionSourceDescriptor(layer.sourceId, options.catalog);
  const featureCatalogSource =
    descriptor?.protocol === "ogc-features" || descriptor?.protocol === "geoservices-feature-service";
  if (isStaticInlineCompositionSource(override) || (isAnonymousMapAssetSource(override) && !featureCatalogSource))
    return resolveCompositionSource(layer, options);

  // Feature catalog descriptors authorize their network sources; the saved
  // URL and URL override cannot replace them. Self-contained or anonymous
  // tile/image sources with no catalog identity retain authored semantics.
  if (!descriptor && override !== undefined)
    return {
      reason: `Source "${layer.sourceId}" has a network override without an audience-approved catalog source.`,
    };
  const source =
    !descriptor && (isStaticInlineCompositionSource(savedSource) || isAnonymousMapAssetSource(savedSource))
      ? savedSource
      : undefined;
  const resolvedLayer: CompositionLayer = {
    ...layer,
    metadata: {
      ...layer.metadata,
      honua: { ...honua, ...(source ? { source } : { source: undefined }) },
    },
  };
  return resolveCompositionSource(resolvedLayer, options);
}

/** The MapLibre layer type a composed layer renders as. Kept separate from the archetype so `raster` can never reach a vector paint helper. */
function maplibreLayerType(layerType: CompositionLayerType): string {
  return layerType;
}

function buildComposedLayer(
  layer: CompositionLayer,
  layerType: CompositionLayerType,
  sourceId: string,
  appearance: CompositionLayerAppearance | undefined,
): HonuaLayerSpecification {
  const color = paletteColorFor(layer.id);
  const opacity = appearance?.opacity?.[layer.id];
  const filter = appearance?.filters?.[layer.id];
  const spec: HonuaLayerSpecification = {
    id: layer.id,
    type: maplibreLayerType(layerType),
    source: sourceId,
    ...(filter !== undefined ? { filter } : {}),
    paint: {
      ...defaultPaintFor(layerType, color),
      ...(opacity !== undefined ? opacityPaintFor(layerType, opacity) : {}),
    },
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
  const mapSpec = cloneStyle(
    state.mapSpec
      ? (state.mapSpec as unknown as HonuaStyleSpecification)
      : (options.basemap ?? createOfflineBasemapStyle()),
  );
  const existingRenderIds = new Set(mapSpec.layers.map((layer) => layer.id));
  const inlineBodies = Object.fromEntries((state.styleRefs ?? []).map((ref) => [ref.styleId, ref.body]));
  const sourceBindings: HonuaMapPackageSourceBinding[] = [];
  const styleRefs: {
    styleId: string;
    body?: HonuaStyleRefBody;
    layerBindings?: readonly import("../styles/map-style-edit.js").CompositionStyleLayerBinding[];
  }[] = [];
  const emittedLiveRefs = new Set<string>();
  const unresolved: UnresolvedCompositionLayer[] = [];
  const renderedLayerIds: string[] = [];
  const boundSourceIds = new Set<string>();
  const deniedSourceIds = new Set<string>();
  const audience = options.sourceAuthority === "current-reader";

  for (const layer of state.layers) {
    const resolveOptions = {
      ...(options.catalog !== undefined ? { catalog: options.catalog } : {}),
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(options.featureLimit !== undefined ? { featureLimit: options.featureLimit } : {}),
    };
    const resolution = audience
      ? resolveAudienceSource(layer, mapSpec.sources[layer.sourceId], resolveOptions)
      : resolveCompositionSource(layer, resolveOptions);
    if (!isCompositionSourceResolution(resolution)) {
      unresolved.push({ layerId: layer.id, sourceId: layer.sourceId, reason: resolution.reason });
      if (audience && resolution.scope !== "layer") deniedSourceIds.add(layer.sourceId);
      continue;
    }
    const resolvedSource =
      audience && state.mapSpec && resolution.binding
        ? rebindAudienceGeoJson(mapSpec.sources[layer.sourceId], resolution.source)
        : resolution.source;
    if (
      audience &&
      boundSourceIds.has(layer.sourceId) &&
      canonicalCompositionJson(mapSpec.sources[layer.sourceId]) !== canonicalCompositionJson(resolvedSource)
    ) {
      deniedSourceIds.add(layer.sourceId);
      unresolved.push({
        layerId: layer.id,
        sourceId: layer.sourceId,
        reason: "Conflicting source definitions for the same map source.",
      });
      continue;
    }

    const authoritative = options.authoritativeStyles?.[layer.id];
    const requiresAuthoritative =
      !inlineBodies[layer.styleRef?.styleId ?? ""] &&
      options.authoritativeStyles !== undefined &&
      (authoritative !== undefined ||
        usesHonuaStyleCatalog(findCompositionSourceDescriptor(layer.sourceId, options.catalog)));
    if (layer.styleRef && requiresAuthoritative && hasCompositionSourceOverride(layer)) {
      unresolved.push({
        layerId: layer.id,
        sourceId: layer.sourceId,
        reason: "Authoritative styles cannot certify a renderer source override.",
      });
      continue;
    }
    if (
      layer.styleRef &&
      requiresAuthoritative &&
      (!authoritative ||
        "reason" in authoritative ||
        authoritative.definition.styleId !== layer.styleRef.styleId ||
        authoritative.sourceId !== layer.sourceId)
    ) {
      unresolved.push({
        layerId: layer.id,
        sourceId: layer.sourceId,
        reason:
          authoritative && "reason" in authoritative
            ? authoritative.reason
            : "Authoritative style binding is unavailable or stale.",
      });
      continue;
    }

    // Several composition layers may share one catalog source (the same
    // dataset styled two ways); the source is materialized once.
    const styleSourceId = layer.sourceId;
    if (!boundSourceIds.has(styleSourceId)) {
      boundSourceIds.add(styleSourceId);
      if (!state.mapSpec || audience)
        mapSpec.sources[styleSourceId] = resolvedSource as HonuaStyleSpecification["sources"][string];
      const durable = state.sourceBindings?.find((binding) => binding.sourceId === styleSourceId);
      if (durable && !audience) sourceBindings.push(structuredClone(durable));
      else if (resolution.binding) sourceBindings.push(resolution.binding as HonuaMapPackageSourceBinding);
    }

    if (!state.mapSpec && !existingRenderIds.has(layer.id))
      mapSpec.layers.push(buildComposedLayer(layer, resolution.layerType, styleSourceId, options.appearance));
    else
      mapSpec.layers = mapSpec.layers.map((renderLayer) => {
        if (!ownedByCompositionLayer(renderLayer, layer.id)) return renderLayer;
        const visible = layer.visible && renderLayer.layout?.visibility !== "none";
        const paint = { ...renderLayer.paint };
        const opacity = options.appearance?.opacity?.[layer.id];
        if (opacity !== undefined)
          for (const key of renderLayer.type === "symbol"
            ? ["text-opacity", "icon-opacity"]
            : [`${renderLayer.type}-opacity`]) {
            const current = paint[key] ?? 1;
            const multiplier = Math.min(1, Math.max(0, opacity));
            paint[key] = typeof current === "number" ? current * multiplier : ["*", current, multiplier];
          }
        const filter = options.appearance?.filters?.[layer.id];
        return {
          ...renderLayer,
          paint,
          layout: { ...renderLayer.layout, ...(!visible ? { visibility: "none" } : {}) },
          ...(filter !== undefined
            ? { filter: renderLayer.filter === undefined ? filter : ["all", renderLayer.filter, filter] }
            : {}),
        };
      });
    if (
      !state.mapSpec &&
      resolution.layerType === "fill" &&
      !existingRenderIds.has(`${layer.id}${OUTLINE_LAYER_SUFFIX}`)
    ) {
      // The outline carries the same filter, or a polygon would keep its
      // outline after its fill was filtered away — a ghost the user cannot
      // click and cannot explain.
      const outlineFilter = options.appearance?.filters?.[layer.id];
      const outlineOpacity = options.appearance?.opacity?.[layer.id];
      mapSpec.layers.push({
        id: `${layer.id}${OUTLINE_LAYER_SUFFIX}`,
        type: "line",
        source: styleSourceId,
        ...(outlineFilter !== undefined ? { filter: outlineFilter } : {}),
        paint: {
          ...outlinePaintFor(paletteColorFor(layer.id)),
          ...(outlineOpacity !== undefined ? { "line-opacity": Math.min(Math.max(outlineOpacity, 0), 1) } : {}),
        },
        ...(layer.visible ? {} : { layout: { visibility: "none" } }),
      });
    }
    renderedLayerIds.push(layer.id);

    if (layer.styleRef) {
      const canonicalReference = state.styleRefs?.find((ref) => ref.styleId === layer.styleRef?.styleId);
      if (authoritative && !("reason" in authoritative) && authoritative.mappedBody) {
        const body = Object.fromEntries(
          Object.entries(authoritative.mappedBody).map(([targetId, override]) => {
            const target = mapSpec.layers.find((render) => render.id === targetId);
            return [
              targetId,
              target
                ? compositionStyleOverride(override, target.type, layer.visible, {
                    filter: options.appearance?.filters?.[layer.id],
                    opacity: options.appearance?.opacity?.[layer.id],
                  })
                : override,
            ];
          }),
        );
        // This body is derived preview data only. Keep the exact bindings so
        // the SDK validates every target/type and rejects stale mappings.
        styleRefs.push({ styleId: layer.styleRef.styleId, body, layerBindings: authoritative.layerBindings });
        continue;
      }
      if (
        canonicalReference?.layerBindings &&
        canonicalReference.body === undefined &&
        options.authoritativeStyles === undefined
      ) {
        // Durable export keeps live references, never a hydrated catalog snapshot.
        if (!emittedLiveRefs.has(canonicalReference.styleId)) {
          emittedLiveRefs.add(canonicalReference.styleId);
          styleRefs.push({ ...canonicalReference, body: undefined });
        }
        continue;
      }
      const effective =
        authoritative && !("reason" in authoritative)
          ? compositionStyleOverride(authoritative.override, resolution.layerType, layer.visible, {
              filter: options.appearance?.filters?.[layer.id],
              opacity: options.appearance?.opacity?.[layer.id],
            })
          : undefined;
      const supplied = effective
        ? {
            [layer.id]: effective,
            ...(resolution.layerType === "fill"
              ? {
                  [`${layer.id}${OUTLINE_LAYER_SUFFIX}`]: {
                    ...(effective.filter !== undefined ? { filter: effective.filter } : {}),
                    ...(effective.layout?.visibility !== undefined
                      ? { layout: { visibility: effective.layout.visibility } }
                      : {}),
                    ...(effective.minzoom !== undefined ? { minzoom: effective.minzoom } : {}),
                    ...(effective.maxzoom !== undefined ? { maxzoom: effective.maxzoom } : {}),
                  },
                }
              : {}),
          }
        : (inlineBodies[layer.styleRef.styleId] ?? options.styleRefBodies?.[layer.styleRef.styleId]);
      const body: HonuaStyleRefBody = supplied ?? {
        [layer.id]: styleRefFallbackOverride(
          layer.styleRef.styleId,
          resolution.layerType,
          options.appearance?.opacity?.[layer.id],
        ),
      };
      styleRefs.push({ styleId: layer.styleRef.styleId, body });
    }
  }

  if (audience) {
    for (const renderLayer of mapSpec.layers) {
      if (renderLayer.source === undefined || renderLayer["source-layer"] === undefined) continue;
      if (mapSpec.sources[renderLayer.source]?.type !== "geojson") continue;
      const declaredOwner = renderLayer.metadata?.["honua:compositionLayerId"];
      const owner =
        typeof declaredOwner === "string" && state.layers.some((layer) => layer.id === declaredOwner)
          ? declaredOwner
          : (state.layers.find((layer) => ownedByCompositionLayer(renderLayer, layer.id))?.id ?? renderLayer.id);
      if (!unresolved.some((entry) => entry.layerId === owner))
        unresolved.push({
          layerId: owner,
          sourceId: renderLayer.source,
          reason: "An authored vector source-layer cannot render from a current-reader GeoJSON source.",
        });
    }
    // A failed layer can share its source with a successful layer. A source
    // authority/conflict failure taints that whole source; a presentation or
    // style failure only drops the failed layer's owned render layers.
    for (const [sourceId, source] of Object.entries(mapSpec.sources)) {
      if (boundSourceIds.has(sourceId) || isStaticInlineCompositionSource(source) || isAnonymousMapAssetSource(source))
        continue;
      deniedSourceIds.add(sourceId);
      for (const renderLayer of mapSpec.layers) {
        if (renderLayer.source !== sourceId) continue;
        const owner = renderLayer.metadata?.["honua:compositionLayerId"];
        const layerId = typeof owner === "string" ? owner : renderLayer.id;
        if (!unresolved.some((entry) => entry.layerId === layerId))
          unresolved.push({ layerId, sourceId, reason: "Source unavailable to this reader." });
      }
    }
    for (const sourceId of deniedSourceIds) delete mapSpec.sources[sourceId];
    const failedLayerIds = new Set(unresolved.map((entry) => entry.layerId));
    mapSpec.layers = mapSpec.layers.filter((renderLayer) => {
      if (typeof renderLayer.source === "string" && deniedSourceIds.has(renderLayer.source)) return false;
      for (const layerId of failedLayerIds) if (ownedByCompositionLayer(renderLayer, layerId)) return false;
      return true;
    });
    for (let index = renderedLayerIds.length - 1; index >= 0; index--)
      if (failedLayerIds.has(renderedLayerIds[index])) renderedLayerIds.splice(index, 1);
    const usedSourceIds = new Set(mapSpec.layers.map((layer) => layer.source).filter((id): id is string => !!id));
    for (const sourceId of boundSourceIds) if (!usedSourceIds.has(sourceId)) delete mapSpec.sources[sourceId];
    for (let index = sourceBindings.length - 1; index >= 0; index--)
      if (!usedSourceIds.has(sourceBindings[index].sourceId)) sourceBindings.splice(index, 1);
    for (let index = renderedLayerIds.length - 1; index >= 0; index--) {
      const rendered = state.layers.find((layer) => layer.id === renderedLayerIds[index]);
      if (rendered && deniedSourceIds.has(rendered.sourceId)) {
        renderedLayerIds.splice(index, 1);
        if (!failedLayerIds.has(rendered.id))
          unresolved.push({
            layerId: rendered.id,
            sourceId: rendered.sourceId,
            reason: "Source unavailable to this reader.",
          });
      }
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
