import { CompositionController } from "../composition/controller.js";
import { readCompositionBody } from "../lifecycle/composition-draft-store.js";
import {
  type CompositionMapStatus,
  CompositionMapView,
  type CompositionMapViewOptions,
} from "./composition-map-view.js";
import type { CompositionMapProjection } from "./map-package-projection.js";
import {
  findCompositionSourceDescriptor,
  hasCompositionSourceOverride,
  usesHonuaStyleCatalog,
} from "./source-resolution.js";

/**
 * The host supplies a canonical body and source/style reads authorized for the
 * current audience. Rendering a definition does not authorize its data sources,
 * verify publication, or grant the host's operator identity to its audience.
 */
export interface ReadOnlyMapCanvasOptions
  extends Pick<
    CompositionMapViewOptions,
    | "container"
    | "projection"
    | "getAuth"
    | "sourceAuthBaseUrl"
    | "sourceCatalogBaseUrl"
    | "mapFactory"
    | "styleProvider"
  > {
  readonly body: unknown;
  readonly onChange?: (canvas: ReadOnlyMapCanvas) => void;
}

/** A map canvas only: no editor, lifecycle client, agent session or save path. */
export interface ReadOnlyMapCanvas {
  readonly status: CompositionMapStatus;
  readonly statusDetail: string | undefined;
  readonly projection: CompositionMapProjection | undefined;
  readonly renderedFeatureCount: number;
  resize(): void;
  settled(): Promise<void>;
  dispose(): void;
}

export async function createReadOnlyMapCanvas(options: ReadOnlyMapCanvasOptions): Promise<ReadOnlyMapCanvas> {
  // Own the snapshot. An asynchronous render must not adopt later edits to the
  // caller's object or acquire the editor controller behind another tab.
  const state = readCompositionBody(structuredClone(options.body));
  const projection = options.projection ? structuredClone(options.projection) : undefined;
  for (const layer of state.layers) {
    if (!layer.styleRef) continue;
    const embedded = state.styleRefs?.some(
      (reference) => reference.styleId === layer.styleRef?.styleId && reference.body !== undefined,
    );
    if (embedded) continue;
    const source = findCompositionSourceDescriptor(layer.sourceId, projection?.catalog);
    if (hasCompositionSourceOverride(layer) || !options.styleProvider || !usesHonuaStyleCatalog(source)) {
      throw new Error(
        "Published style references require an embedded body or an authoritative style reader for their source; a preset is not a substitute.",
      );
    }
  }
  const controller = new CompositionController(state);
  let disposed = false;
  const notify = () => {
    if (!disposed) options.onChange?.(canvas);
  };
  const renderer = new CompositionMapView({
    container: options.container,
    controller,
    projection: { ...projection, sourceAuthority: "current-reader" },
    styleProvider: options.styleProvider,
    // Even anonymous viewers use the bounded feature transport. No session
    // means unauthenticated GETs with credentials omitted, never host authority.
    getAuth: options.getAuth ?? (() => undefined),
    sourceAuthBaseUrl: options.sourceAuthBaseUrl,
    sourceCatalogBaseUrl: options.sourceCatalogBaseUrl,
    mapFactory: options.mapFactory,
    onChange: notify,
  });
  const canvas: ReadOnlyMapCanvas = Object.freeze({
    get status() {
      return renderer.status;
    },
    get statusDetail() {
      const unresolved = renderer.projection?.unresolved ?? [];
      if (unresolved.length === 0) return renderer.statusDetail;
      const names = unresolved.slice(0, 3).map(({ layerId }) => layerId.slice(0, 64));
      const more = unresolved.length > names.length ? ` and ${unresolved.length - names.length} more` : "";
      const summary =
        `${unresolved.length} map layer${unresolved.length === 1 ? "" : "s"} unavailable to this reader: ` +
        `${names.join(", ")}${more}.`;
      return renderer.statusDetail ? `${renderer.statusDetail} ${summary}` : summary;
    },
    get projection() {
      return renderer.projection ? structuredClone(renderer.projection) : undefined;
    },
    get renderedFeatureCount() {
      const layers = renderer.projection?.renderedLayerIds;
      if (!layers?.length || !renderer.map?.queryRenderedFeatures) return 0;
      return renderer.map.queryRenderedFeatures(undefined, { layers: [...layers] }).length;
    },
    settled: () => renderer.settled(),
    resize: () => renderer.resize(),
    dispose: () => {
      disposed = true;
      renderer.map?.off?.("idle", notify);
      renderer.dispose();
    },
  });
  try {
    await renderer.start();
    // Construction completes before remote sources paint. Notify again after
    // every completed render, including camera changes that alter the count.
    renderer.map?.on("idle", notify);
  } catch (error) {
    renderer.dispose();
    throw error;
  }
  return canvas;
}
