/**
 * The live MapLibre surface (honua-studio#23 REQ-001) — the thing that makes
 * "the agent composes a running application" literally true instead of
 * merely described. It subscribes to one {@link CompositionController} and,
 * after every applied command, re-projects composition state into a
 * `HonuaMapPackage` (`./map-package-projection.ts`), composes the style
 * through the SDK's own `composeStyle`, and hands it to MapLibre's style
 * differ. Tool calls streaming in therefore *move the map*, one command at a
 * time, with no intermediate re-mount.
 *
 * Three deliberate constraints shape this file:
 *
 *  - **MapLibre is loaded dynamically, never imported at module scope.**
 *    Studio's unit tests run under `environment: "node"` and its offline
 *    default must not pay for a WebGL renderer it may not be able to
 *    construct. `defaultCompositionMapFactory` is the only code path that
 *    reaches `maplibre-gl`, and it is `await import(...)`.
 *  - **The map is injected, not assumed.** `options.mapFactory` means the
 *    whole update pipeline — projection, style composition, view
 *    application, selection — is exercised in node against a fake map, so
 *    the interesting logic is tested rather than screenshotted.
 *  - **Failure is a state, not an exception.** No WebGL, a refused context,
 *    an unresolvable source: each ends as `status === "unavailable"` (or an
 *    `unresolved` entry) with a reason the canvas can render, and the text
 *    readout stays as the working surface. Studio degrades to what it was
 *    before this issue rather than to a blank panel.
 *
 * Ordering: every update runs through `#queue`, a single promise chain.
 * Style composition is async, so two commands landing in the same tick
 * would otherwise race and apply out of order — the map would settle on
 * whichever composition finished last rather than the latest state. The
 * chain also drops superseded work: only the newest generation is applied.
 *
 * @module
 */

import { composeStyle } from "@honua/sdk-js/runtime";
import type { HonuaMapPackage } from "@honua/sdk-js/runtime";
import type { HonuaStyleSpecification } from "@honua/sdk-js/style";

import type { CompositionController } from "../composition/controller.js";
import type { CompositionTarget, CompositionView } from "../composition/model.js";
import {
  type CompositionMapProjection,
  type CompositionMapProjectionOptions,
  compositionToMapPackage,
  isBasemapLayerId,
} from "./map-package-projection.js";

/**
 * The structural slice of `maplibre-gl`'s `Map` this module uses. Declared
 * here rather than imported so nothing pulls MapLibre into a module graph
 * that only wanted the projection — and so a test double is a plain object
 * literal rather than a mock of a 900 KB class.
 */
export interface CompositionMapLike {
  setStyle(style: unknown, options?: { diff?: boolean }): unknown;
  jumpTo(options: Record<string, unknown>): unknown;
  easeTo(options: Record<string, unknown>): unknown;
  fitBounds(bounds: readonly [number, number, number, number], options?: Record<string, unknown>): unknown;
  on(type: string, listener: (event: unknown) => void): unknown;
  off?(type: string, listener: (event: unknown) => void): unknown;
  queryRenderedFeatures?(point: unknown, options?: { layers?: readonly string[] }): readonly unknown[];
  resize(): unknown;
  remove(): void;
}

export interface CompositionMapFactoryOptions {
  readonly container: HTMLElement;
  readonly style: HonuaStyleSpecification;
  readonly center: readonly [number, number];
  readonly zoom: number;
  readonly attributionText: string;
}

export type CompositionMapFactory = (options: CompositionMapFactoryOptions) => Promise<CompositionMapLike>;

export type CompositionMapStatus = "idle" | "starting" | "ready" | "unavailable";

export interface CompositionMapViewOptions {
  readonly container: HTMLElement;
  readonly controller: CompositionController;
  readonly projection?: CompositionMapProjectionOptions;
  /** Overrides the dynamic `maplibre-gl` import — the seam unit tests use. */
  readonly mapFactory?: CompositionMapFactory;
  /** Camera animation duration in ms. `0` jumps (what the browser suite uses so assertions are not racing an easing curve). Default 700. */
  readonly viewTransitionMs?: number;
  /** Called when a click resolves to a composed layer/feature — the deictic "THIS" (#1 REQ-012). */
  readonly onSelection?: (targets: readonly CompositionTarget[]) => void;
  /** Called after every applied update, and on failure. The canvas renders status from this. */
  readonly onChange?: (view: CompositionMapView) => void;
}

/** Where the camera sits before a composition says otherwise: the whole world, so an empty composition still reads as a map. */
const WORLD_VIEW: { center: readonly [number, number]; zoom: number } = { center: [0, 20], zoom: 1 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Constructs a real `maplibre-gl` map. The dynamic import is the point —
 * see this module's doc. Attribution is on and non-compact so the vendored
 * basemap's credit is actually visible (REQ-003's data provenance).
 */
export const defaultCompositionMapFactory: CompositionMapFactory = async (options) => {
  const maplibre = await import("maplibre-gl");
  const namespace = (maplibre as { default?: Record<string, unknown> }).default ?? maplibre;
  const MapConstructor = (namespace as { Map?: unknown }).Map as
    | (new (
        constructorOptions: Record<string, unknown>,
      ) => CompositionMapLike)
    | undefined;
  if (typeof MapConstructor !== "function") {
    throw new Error("maplibre-gl did not export a Map constructor.");
  }
  return new MapConstructor({
    container: options.container,
    style: options.style,
    center: [...options.center],
    zoom: options.zoom,
    attributionControl: { compact: false, customAttribution: options.attributionText },
  });
};

/**
 * Cheap, synchronous "can this environment render WebGL at all?" probe.
 *
 * The canvas calls this *before* touching the map module's dynamic import,
 * which is the whole point: under `happy-dom` (every element unit test) and
 * in a browser with WebGL disabled, importing and constructing MapLibre
 * costs a megabyte and a thrown error to learn what one `getContext` call
 * answers immediately. A negative answer is not a failure — the canvas falls
 * back to the text readout, which is exactly the surface it had before this
 * issue.
 */
export function isWebglAvailable(): boolean {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return false;
  try {
    const canvas = document.createElement("canvas");
    if (typeof canvas.getContext !== "function") return false;
    return canvas.getContext("webgl2") !== null || canvas.getContext("webgl") !== null;
  } catch {
    return false;
  }
}

export class CompositionMapView {
  readonly #options: CompositionMapViewOptions;
  #map: CompositionMapLike | undefined;
  #unsubscribe: (() => void) | undefined;
  #status: CompositionMapStatus = "idle";
  #statusDetail: string | undefined;
  #projection: CompositionMapProjection | undefined;
  #queue: Promise<void> = Promise.resolve();
  #generation = 0;
  #appliedView: CompositionView | undefined;
  #disposed = false;

  public constructor(options: CompositionMapViewOptions) {
    this.#options = options;
  }

  public get status(): CompositionMapStatus {
    return this.#status;
  }

  /** Human-readable detail for the current status — the unavailability reason, or the last failure. */
  public get statusDetail(): string | undefined {
    return this.#statusDetail;
  }

  public get map(): CompositionMapLike | undefined {
    return this.#map;
  }

  /** The most recent projection — `mapPackage` is the ejectable artifact, `unresolved` is what the canvas warns about. */
  public get projection(): CompositionMapProjection | undefined {
    return this.#projection;
  }

  public get mapPackage(): HonuaMapPackage | undefined {
    return this.#projection?.mapPackage;
  }

  /**
   * Creates the map and binds it to the controller. Resolves once the first
   * composition has been applied (or once the map has been declared
   * unavailable) — it never rejects, because a canvas that cannot render a
   * map still has to render its readout.
   */
  public async start(): Promise<void> {
    if (this.#disposed || this.#status !== "idle") return;
    this.#status = "starting";
    const projection = this.#project();
    const initialView = projection.mapPackage.initialView;
    const style = await this.#composeSafely(projection.mapPackage);
    try {
      const factory = this.#options.mapFactory ?? defaultCompositionMapFactory;
      this.#map = await factory({
        container: this.#options.container,
        style,
        center: (initialView?.center ?? WORLD_VIEW.center) as readonly [number, number],
        zoom: initialView?.zoom ?? WORLD_VIEW.zoom,
        attributionText: "Honua Studio",
      });
    } catch (error) {
      this.#status = "unavailable";
      this.#statusDetail = error instanceof Error ? error.message : String(error);
      this.#notify();
      return;
    }
    if (this.#disposed) {
      this.#map.remove();
      this.#map = undefined;
      return;
    }
    this.#bindClicks(this.#map);
    this.#appliedView = this.#options.controller.state.view;
    // A bbox view cannot be expressed as construction-time center/zoom —
    // apply it (and any pitch/bearing) once the map exists.
    this.#applyView(this.#map, this.#options.controller.state.view, true);
    this.#status = "ready";
    this.#unsubscribe = this.#options.controller.subscribe(() => this.#scheduleUpdate());
    this.#notify();
  }

  /** Re-measures the map after its container changed size — the canvas calls this when it switches back from the readout view. */
  public resize(): void {
    try {
      this.#map?.resize();
    } catch {
      // A map whose container is detached (or mid-teardown) refuses to
      // measure; that is not a failure worth surfacing.
    }
  }

  public dispose(): void {
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    try {
      this.#map?.remove();
    } catch {
      // MapLibre throws when removed twice or after its context is gone.
    }
    this.#map = undefined;
    this.#status = "idle";
  }

  #project(): CompositionMapProjection {
    const projection = compositionToMapPackage(this.#options.controller.state, this.#options.projection ?? {});
    this.#projection = projection;
    return projection;
  }

  /**
   * Runs the SDK's style composition (style-ref overrides + theme tokens
   * merged onto `mapSpec`). On failure the un-composed `mapSpec` is used:
   * a bad style ref should cost the map its styling, not its layers.
   */
  async #composeSafely(mapPackage: HonuaMapPackage): Promise<HonuaStyleSpecification> {
    try {
      return pruneUndefinedStyleProperties(await composeStyle(mapPackage, mapPackage.mapSpec, {}));
    } catch (error) {
      this.#statusDetail = `Style composition fell back to the base style: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return pruneUndefinedStyleProperties(mapPackage.mapSpec);
    }
  }

  #scheduleUpdate(): void {
    this.#generation += 1;
    const generation = this.#generation;
    this.#queue = this.#queue.then(async () => {
      if (this.#disposed || generation !== this.#generation) return;
      await this.#update();
    });
  }

  /** Exposed for tests and for the canvas's "the map is behind" recovery — awaits every queued update. */
  public settled(): Promise<void> {
    return this.#queue;
  }

  async #update(): Promise<void> {
    const map = this.#map;
    if (!map) return;
    const projection = this.#project();
    const style = await this.#composeSafely(projection.mapPackage);
    if (this.#disposed) return;
    try {
      map.setStyle(style, { diff: true });
    } catch (error) {
      this.#statusDetail = `The map could not apply the latest composition: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.#notify();
      return;
    }
    const view = this.#options.controller.state.view;
    if (!viewsEqual(view, this.#appliedView)) {
      this.#appliedView = view;
      this.#applyView(map, view, false);
    }
    this.#notify();
  }

  /** Applies a {@link CompositionView}. `bbox` wins over `center`/`zoom` — it is the more specific statement of intent. */
  #applyView(map: CompositionMapLike, view: CompositionView, immediate: boolean): void {
    const duration = immediate ? 0 : (this.#options.viewTransitionMs ?? 700);
    try {
      if (view.bbox) {
        map.fitBounds(view.bbox, {
          duration,
          ...(view.pitch !== undefined ? { pitch: view.pitch } : {}),
          ...(view.bearing !== undefined ? { bearing: view.bearing } : {}),
        });
        return;
      }
      const camera: Record<string, unknown> = {};
      if (view.center) camera.center = [...view.center];
      if (view.zoom !== undefined) camera.zoom = view.zoom;
      if (view.pitch !== undefined) camera.pitch = view.pitch;
      if (view.bearing !== undefined) camera.bearing = view.bearing;
      if (Object.keys(camera).length === 0) return;
      if (duration === 0) map.jumpTo(camera);
      else map.easeTo({ ...camera, duration });
    } catch (error) {
      this.#statusDetail = `The map could not move to the composed view: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  /**
   * One click listener for the whole map, filtered to composed layers, so
   * layers appearing and disappearing mid-conversation never leaves a stale
   * per-layer handler behind.
   */
  #bindClicks(map: CompositionMapLike): void {
    map.on("click", (event) => {
      const onSelection = this.#options.onSelection;
      if (!onSelection || !isRecord(event)) return;
      const layerIds = this.#projection?.renderedLayerIds ?? [];
      if (layerIds.length === 0) return;
      const features = map.queryRenderedFeatures?.(event.point, { layers: [...layerIds] }) ?? [];
      const targets = compositionTargetsFromFeatures(features);
      if (targets.length > 0) onSelection(targets);
    });
  }

  #notify(): void {
    this.#options.onChange?.(this);
  }
}

function withoutUndefinedValues<T extends Record<string, unknown>>(value: T): T {
  const pruned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) if (entry !== undefined) pruned[key] = entry;
  return pruned as T;
}

/**
 * Strips explicitly-`undefined` properties out of a composed style before it
 * reaches MapLibre.
 *
 * This is not defensive tidying — without it the map does not update at all.
 * The SDK's `composeStyle` clones every layer through a helper that writes
 * `paint: undefined` / `layout: undefined` / `metadata: undefined` onto
 * layers that simply did not have them. `{ layout: undefined }` and "no
 * `layout` key" are the same thing to `JSON.stringify` but *not* to
 * MapLibre's style validator, which rejects the former outright
 * (`layers[n].layout: object expected, undefined found`). A rejected diff
 * leaves the previous style in place, so the symptom is the worst kind:
 * composition state is correct, the readout is correct, no exception is
 * thrown, and the map silently stops changing.
 *
 * Normalizing at this boundary is deliberate — it keeps Studio on the
 * published SDK rather than forking style composition. Worth fixing in
 * `@honua/sdk-js`'s `cloneLayer` so every SDK consumer gets it; until then,
 * one pass here.
 */
export function pruneUndefinedStyleProperties(style: HonuaStyleSpecification): HonuaStyleSpecification {
  return {
    ...withoutUndefinedValues(style as unknown as Record<string, unknown>),
    layers: style.layers.map((layer) => withoutUndefinedValues(layer as unknown as Record<string, unknown>)),
  } as unknown as HonuaStyleSpecification;
}

/**
 * Turns MapLibre's rendered-feature hit into composition targets. The
 * feature target comes first when the feature carries an id: "this parcel"
 * is a more precise deictic reference than "this layer", and #1 REQ-012's
 * chip wants the most specific one available.
 */
export function compositionTargetsFromFeatures(features: readonly unknown[]): CompositionTarget[] {
  const first = features[0];
  if (!isRecord(first)) return [];
  const layerId = isRecord(first.layer) && typeof first.layer.id === "string" ? first.layer.id : undefined;
  if (!layerId || isBasemapLayerId(layerId)) return [];
  const targets: CompositionTarget[] = [];
  const sourceId = typeof first.source === "string" ? first.source : undefined;
  const featureId = first.id;
  if (sourceId && (typeof featureId === "string" || typeof featureId === "number")) {
    targets.push({ kind: "feature", sourceId, featureId });
  }
  targets.push({ kind: "layer", id: layerId });
  return targets;
}

function viewsEqual(a: CompositionView, b: CompositionView | undefined): boolean {
  if (!b) return false;
  return (
    a.zoom === b.zoom &&
    a.pitch === b.pitch &&
    a.bearing === b.bearing &&
    coordinatesEqual(a.center, b.center) &&
    coordinatesEqual(a.bbox, b.bbox)
  );
}

function coordinatesEqual(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}
