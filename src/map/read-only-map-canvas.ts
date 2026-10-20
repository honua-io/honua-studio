import { CompositionController } from "../composition/controller.js";
import { readCompositionBody } from "../lifecycle/composition-draft-store.js";
import {
  type CompositionMapStatus,
  CompositionMapView,
  type CompositionMapViewOptions,
} from "./composition-map-view.js";
import type { CompositionMapProjection } from "./map-package-projection.js";

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
  if (state.layers.some((layer) => layer.styleRef) && !options.styleProvider) {
    throw new Error("Published style references require an authoritative style reader; a preset is not a substitute.");
  }
  const controller = new CompositionController(state);
  const renderer = new CompositionMapView({
    container: options.container,
    controller,
    projection,
    styleProvider: options.styleProvider,
    // Even anonymous viewers use the bounded feature transport. No session
    // means unauthenticated GETs with credentials omitted, never host authority.
    getAuth: options.getAuth ?? (() => undefined),
    sourceAuthBaseUrl: options.sourceAuthBaseUrl,
    sourceCatalogBaseUrl: options.sourceCatalogBaseUrl,
    mapFactory: options.mapFactory,
    onChange: () => options.onChange?.(canvas),
  });
  const canvas: ReadOnlyMapCanvas = Object.freeze({
    get status() {
      return renderer.status;
    },
    get statusDetail() {
      return renderer.statusDetail;
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
    dispose: () => renderer.dispose(),
  });
  try {
    await renderer.start();
  } catch (error) {
    renderer.dispose();
    throw error;
  }
  return canvas;
}
