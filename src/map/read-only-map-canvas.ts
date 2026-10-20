import { CompositionController } from "../composition/controller.js";
import type { CompositionTarget } from "../composition/model.js";
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

/** Internal seam for a read-only composition view: the map and widgets share this private controller. */
export interface ReadOnlyMapControllerOptions extends Omit<ReadOnlyMapCanvasOptions, "body"> {
  readonly controller: CompositionController;
  readonly onSelection?: (targets: readonly CompositionTarget[]) => void;
}

export interface StartedReadOnlyMapCanvas {
  readonly canvas: ReadOnlyMapCanvas;
  readonly ready: Promise<void>;
}

export function startReadOnlyMapCanvasForController(options: ReadOnlyMapControllerOptions): StartedReadOnlyMapCanvas {
  const state = options.controller.state;
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
  let disposed = false;
  const notify = () => {
    if (!disposed) options.onChange?.(canvas);
  };
  const renderer = new CompositionMapView({
    container: options.container,
    controller: options.controller,
    projection: { ...projection, sourceAuthority: "current-reader" },
    styleProvider: options.styleProvider,
    // Even anonymous viewers use the bounded feature transport. No session
    // means unauthenticated GETs with credentials omitted, never host authority.
    getAuth: options.getAuth ?? (() => undefined),
    sourceAuthBaseUrl: options.sourceAuthBaseUrl,
    sourceCatalogBaseUrl: options.sourceCatalogBaseUrl,
    mapFactory: options.mapFactory,
    onSelection: options.onSelection,
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
      const map = renderer.map;
      const projection = renderer.projection;
      if (!projection?.renderedLayerIds.length || !map?.queryRenderedFeatures) return 0;
      const owners = new Set(projection.renderedLayerIds);
      const styleLayers = map.getStyle ? map.getStyle()?.layers : projection.mapPackage.mapSpec.layers;
      const layers = (styleLayers ?? []).flatMap((layer) => {
        if (typeof layer.id !== "string") return [];
        const metadata = layer.metadata;
        const owner =
          metadata && typeof metadata === "object"
            ? (metadata as Readonly<Record<string, unknown>>)["honua:compositionLayerId"]
            : undefined;
        return owners.has(layer.id) || (typeof owner === "string" && owners.has(owner)) ? [layer.id] : [];
      });
      if (!layers.length) return 0;
      return map.queryRenderedFeatures(undefined, { layers }).length;
    },
    settled: () => renderer.settled(),
    resize: () => renderer.resize(),
    dispose: () => {
      disposed = true;
      renderer.map?.off?.("idle", notify);
      renderer.dispose();
    },
  });
  const ready = renderer.start().then(
    () => {
      // Construction completes before remote sources paint. Notify again after
      // every completed render, including camera changes that alter the count.
      if (!disposed) renderer.map?.on("idle", notify);
    },
    (error: unknown) => {
      renderer.dispose();
      throw error;
    },
  );
  return { canvas, ready };
}

export async function createReadOnlyMapCanvas(options: ReadOnlyMapCanvasOptions): Promise<ReadOnlyMapCanvas> {
  // Own the snapshot. An asynchronous render must not adopt later edits to the
  // caller's object or acquire the editor controller behind another tab.
  const controller = new CompositionController(readCompositionBody(structuredClone(options.body)));
  const { canvas, ready } = startReadOnlyMapCanvasForController({ ...options, controller });
  await ready;
  return canvas;
}
