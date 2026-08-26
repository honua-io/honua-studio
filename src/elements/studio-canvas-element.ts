/**
 * `<honua-studio-canvas>` — the composition canvas surface.
 *
 * honua-studio#5 scaffolded a placeholder; #8 made it a structured *text
 * readout* of {@link CompositionState} and said plainly that real map
 * rendering was later work. honua-studio#23 is that later work: the primary
 * surface is now a real MapLibre GL map that mutates as tool calls stream in
 * (REQ-001), rendered through `../map/` — the composition state is projected
 * to a `HonuaMapPackage` and composed with the SDK's own `composeStyle`, so
 * there is no second renderer and no second reducer (REQ-002).
 *
 * **The readout did not go away, and it is not dead weight.** REQ-001 asks
 * for it to stay "as a debug/accessibility view", and it earns both words:
 *
 *  - *Accessibility.* A WebGL canvas is opaque to assistive technology. The
 *    readout is the map's accessible description — the map region carries
 *    `aria-describedby` pointing at it — and it is where keyboard users
 *    still select layers, widgets, and annotations. It is present in the DOM
 *    in both surface modes for exactly this reason; the Details mode simply
 *    gives it the whole panel.
 *  - *Debug.* It shows what the map structurally cannot: widgets, pins,
 *    annotations, and layers whose source did not resolve to anything
 *    renderable. That last one matters most — a layer the map cannot draw is
 *    still a layer the composition holds, and silently dropping it from both
 *    surfaces would be the worst possible outcome.
 *
 * Consequently every `data-testid` #8 introduced (`studio-canvas-readout`,
 * `-layers`, `-view`, `-widgets`, `-annotations`, `-pins`, `-row`, `-pin`)
 * is unchanged and still asserted against — those tests kept their meaning
 * rather than being retargeted at the map. The map adds its own
 * (`studio-canvas-map`, `-map-status`, `-mode-map`, `-mode-details`).
 *
 * Rendering discipline: a WebGL map cannot survive `innerHTML =`. The shell
 * is therefore built **once** per connection, and every subsequent
 * composition change re-renders only the readout subtree and syncs
 * attributes — the map container node is never replaced while connected. Get
 * this wrong and the map silently re-mounts (losing camera, sources, and the
 * whole point) on every single tool call.
 *
 * Still honors honua-studio#5's original scope: the `ResizeObserver`
 * leak-detection probe (`instanceCount`) and cleanup discipline are
 * unchanged.
 */
import type { CompositionController } from "../composition/controller.js";
import type {
  CompositionAnnotation,
  CompositionControl,
  CompositionLayer,
  CompositionTarget,
  CompositionWidget,
} from "../composition/model.js";
import { type ControlStatus, describeControl } from "../controls/control-config.js";
// Imported from the concrete modules, NOT `../map/index.js`. The barrel
// re-exports `agent-map-kit`, which `studio-app-element.ts` also imports
// *statically* — so a dynamic `import("../map/index.js")` makes the lazy map
// chunk import back into the entry chunk, and that circularity is not
// harmless: under ASP.NET Core's `MapStaticAssets` the entry is served both
// un-fingerprinted (the host's own `<script src>`) and fingerprinted (the
// import map rewrites the chunk's back-import), so the SAME module evaluates
// **twice** under two URLs. Two copies of every element class: the first
// wins `customElements.define`, the second overwrites the exports a host
// reads. honua-studio#23 hit exactly this — the Blazor harness's leak probe
// read a class whose instances were being counted on the other copy.
import type { LngLat } from "../controls/geodesy.js";
import type { StudioInteractionRuntime } from "../interactions/studio-interactions.js";
import type { BasemapStyle } from "../map/basemap.js";
import type { CompositionMapFactory, CompositionMapView } from "../map/composition-map-view.js";
import type { UnresolvedCompositionLayer } from "../map/map-package-projection.js";
import type { CompositionSourceDescriptor } from "../map/source-resolution.js";
import { runtimeServerBaseUrl } from "../runtime-config.js";
import type { WidgetDataLoader } from "../widgets/widget-data.js";
import { HonuaStudioElementBase } from "./base-element.js";
import { resolveInjectedAuth } from "./session.js";
// Type-only, same reasoning as the widget deck below: the control bar is
// composed in by tag name and upgraded, never `instanceof`-checked.
import type { ControlBarMapBridge, HonuaStudioControlBarElement } from "./studio-control-bar-element.js";
// Type-only: the deck is composed into this shadow root **by tag name**, and
// `registry.ts` defines it alongside this element (see its
// STUDIO_ELEMENT_DEPENDENCIES). Importing the class for an `instanceof` check
// would be a worse guarantee than it looks — under the double-module-URL
// hazard the class doc describes, `instanceof` compares against the wrong
// copy — so the wiring below upgrades the node and assigns properties instead.
import type { HonuaStudioWidgetDeckElement } from "./studio-widget-deck-element.js";
import { baseElementStyles, canvasStyles } from "./styles.js";
import type {
  AuthSession,
  HonuaStudioCanvasResizeDetail,
  HonuaStudioCommandDispatch,
  HonuaStudioSelectionChangeDetail,
} from "./types.js";

/** Which surface the canvas is showing. The readout stays in the DOM in both — see the class doc. */
export type HonuaStudioCanvasSurface = "map" | "details";

const SURFACES: readonly HonuaStudioCanvasSurface[] = ["map", "details"];
const SURFACE_LABELS: Record<HonuaStudioCanvasSurface, string> = { map: "Map", details: "Details" };

export class HonuaStudioCanvasElement extends HonuaStudioElementBase {
  static get observedAttributes(): string[] {
    return ["label", "surface"];
  }

  /** Live (connected) instance count — a leak-detection probe, not part of the public contract proper. See the class doc and test/elements/cleanup.test.ts. */
  static instanceCount = 0;

  #auth: AuthSession | undefined;
  #resizeObserver: ResizeObserver | undefined;
  #composition: CompositionController | undefined;
  #commandDispatch: HonuaStudioCommandDispatch | undefined;
  #compositionUnsubscribe: (() => void) | undefined;
  #sourceCatalog: readonly CompositionSourceDescriptor[] | undefined;
  #basemapStyle: BasemapStyle | undefined;
  #mapFactory: CompositionMapFactory | undefined;
  #sourceBaseUrl = runtimeServerBaseUrl();
  #viewTransitionMs: number | undefined;
  #mapView: CompositionMapView | undefined;
  #widgetDataLoader: WidgetDataLoader | undefined;
  /**
   * Bumped whenever a projection input changes. `#ensureMapView` captures it
   * and re-checks after every `await`, so a `.sourceCatalog` assignment that
   * lands mid-boot (the common case: the app element fetches the catalog
   * right after mounting the canvas) discards the in-flight map instead of
   * quietly finishing with the stale inputs.
   */
  #mapGeneration = 0;
  #mapPending = false;
  /** Last-rendered set of unrenderable layer ids — see `#onMapChanged`. */
  #unresolvedKey = "";
  #shellKind: "placeholder" | "composition" | undefined;
  /** The ADR-0030 interaction runtime (honua-studio#25), imported lazily — see `#ensureInteractionRuntime`. */
  #interactions: StudioInteractionRuntime | undefined;
  #interactionsPending = false;

  /** Direct `AuthSession` override — falls back to the nearest `<honua-studio-app>` ancestor's `.auth` when unset. See docs/embed-session.md. */
  public get auth(): AuthSession | undefined {
    return this.#auth;
  }

  public set auth(auth: AuthSession | undefined) {
    this.#auth = auth;
    this.render();
  }

  /** The composition engine controller (honua-studio#8) this canvas renders. `undefined` renders the honua-studio#5 placeholder. */
  public get composition(): CompositionController | undefined {
    return this.#composition;
  }

  public set composition(composition: CompositionController | undefined) {
    if (this.#composition === composition) return;
    this.#compositionUnsubscribe?.();
    this.#compositionUnsubscribe = undefined;
    this.#teardownMapView();
    this.#teardownInteractions();
    this.#composition = composition;
    if (composition && this.isConnected) {
      this.#compositionUnsubscribe = composition.subscribe(() => this.#syncComposition());
    }
    this.render();
  }

  /**
   * Where the composed widgets' **intrinsic** mutations go — a TOC checkbox,
   * a compare switch, a time stepper (honua-studio#24 REQ-003). `<honua-studio-app>`
   * points this at its one `ToolCallOrchestrator`, so a toggle takes the same
   * route an agent's `setVisibility` takes and, in live mode, round-trips
   * through `honua_studio_set_layer_visibility` instead of mutating state the
   * next draft sync overwrites (honua-studio#31).
   *
   * Unset, each widget applies through `.composition` directly — which is
   * what fixture/offline mode does regardless, one hop earlier.
   */
  public get commandDispatch(): HonuaStudioCommandDispatch | undefined {
    return this.#commandDispatch;
  }

  public set commandDispatch(dispatch: HonuaStudioCommandDispatch | undefined) {
    if (this.#commandDispatch === dispatch) return;
    this.#commandDispatch = dispatch;
    this.#syncWidgetDeck();
  }

  /**
   * Sources the server advertises (`StudioClient.listCatalog()`), used to
   * turn a composition layer's bare `sourceId` into something renderable —
   * see `../map/source-resolution.ts`. Without it, only layers carrying an
   * explicit `metadata.honua.source` can draw; the rest are reported as
   * unresolved rather than silently missing.
   */
  public get sourceCatalog(): readonly CompositionSourceDescriptor[] | undefined {
    return this.#sourceCatalog;
  }

  public set sourceCatalog(catalog: readonly CompositionSourceDescriptor[] | undefined) {
    this.#sourceCatalog = catalog;
    this.#syncWidgetDeck();
    this.#restartMapView();
  }

  /** Overrides the vendored offline basemap (REQ-003's default) with a deployment's own style document. */
  public get basemapStyle(): BasemapStyle | undefined {
    return this.#basemapStyle;
  }

  public set basemapStyle(style: BasemapStyle | undefined) {
    this.#basemapStyle = style;
    this.#restartMapView();
  }

  /** Server root for composed source URLs. Defaults to `/api`, matching `StudioClient`. */
  public get sourceBaseUrl(): string {
    return this.#sourceBaseUrl;
  }

  public set sourceBaseUrl(baseUrl: string) {
    this.#sourceBaseUrl = baseUrl;
    this.#syncWidgetDeck();
    this.#restartMapView();
  }

  /**
   * Replaces the widget deck's feature loader (honua-studio#24). The
   * injection seam `../widgets/widget-data.ts` documents — the grid/chart
   * analogue of `mapFactory`; production never sets it.
   */
  public get widgetDataLoader(): WidgetDataLoader | undefined {
    return this.#widgetDataLoader;
  }

  public set widgetDataLoader(loader: WidgetDataLoader | undefined) {
    this.#widgetDataLoader = loader;
    this.#syncWidgetDeck();
  }

  /** The composed widget surface, once the shell has built it. `undefined` in placeholder mode, or where the tag was never registered. */
  public get widgetDeck(): HonuaStudioWidgetDeckElement | undefined {
    return this.shadowRoot?.querySelector<HonuaStudioWidgetDeckElement>("honua-studio-widget-deck") ?? undefined;
  }

  /** The composed control surface (honua-studio#25), once the shell has built it. */
  public get controlBar(): HonuaStudioControlBarElement | undefined {
    return this.shadowRoot?.querySelector<HonuaStudioControlBarElement>("honua-studio-control-bar") ?? undefined;
  }

  /** The interaction runtime driving `control:{id}` bindings. `undefined` until a composition declares a control or a binding. */
  public get interactions(): StudioInteractionRuntime | undefined {
    return this.#interactions;
  }

  /** Camera animation duration in ms; `0` makes view changes instantaneous (what the browser suite uses). */
  public get viewTransitionMs(): number | undefined {
    return this.#viewTransitionMs;
  }

  public set viewTransitionMs(duration: number | undefined) {
    this.#viewTransitionMs = duration;
  }

  /** Replaces the `maplibre-gl` map constructor. The injection seam `../map/composition-map-view.ts` documents; production never sets it. */
  public get mapFactory(): CompositionMapFactory | undefined {
    return this.#mapFactory;
  }

  public set mapFactory(factory: CompositionMapFactory | undefined) {
    this.#mapFactory = factory;
    this.#restartMapView();
  }

  /** The live map binding, once started. `undefined` when the canvas is in placeholder mode or WebGL is unavailable. */
  public get mapView(): CompositionMapView | undefined {
    return this.#mapView;
  }

  /** Which surface is showing. Setting it mirrors to the `surface` attribute, so a host can drive it from markup too. */
  public get surface(): HonuaStudioCanvasSurface {
    return this.getAttribute("surface") === "details" ? "details" : "map";
  }

  public set surface(surface: HonuaStudioCanvasSurface) {
    this.setAttribute("surface", surface);
  }

  public attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (!this.isConnected || oldValue === newValue) return;
    if (name === "surface") {
      this.#syncSurface();
      return;
    }
    this.render();
  }

  protected onConnect(): void {
    HonuaStudioCanvasElement.instanceCount += 1;
    if (!this.#auth) {
      const inherited = resolveInjectedAuth(this);
      if (inherited) this.#auth = inherited;
      else this.dispatchTypedEvent("honua-studio-session-required", { reason: "honua-studio-canvas has no session" });
    }
    if (this.#composition && !this.#compositionUnsubscribe) {
      this.#compositionUnsubscribe = this.#composition.subscribe(() => this.#syncComposition());
    }
    if (typeof ResizeObserver !== "undefined") {
      this.#resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        // The map measures its own container, and the container only changes
        // size when this element does — so the same observer #5 added for
        // leak detection is also what keeps the map from rendering into a
        // stale viewport.
        this.#mapView?.resize();
        this.dispatchTypedEvent<HonuaStudioCanvasResizeDetail>("honua-studio-canvas-resize", {
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      });
      this.#resizeObserver.observe(this);
    }
  }

  protected onDisconnect(): void {
    HonuaStudioCanvasElement.instanceCount -= 1;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.#compositionUnsubscribe?.();
    this.#compositionUnsubscribe = undefined;
    this.#teardownMapView();
    this.#teardownInteractions();
    this.#shellKind = undefined;
  }

  /**
   * Builds the shell when its KIND changes (placeholder <-> composition) and
   * otherwise only syncs. Never rebuilds the shell for a composition change:
   * that would replace the map container node and re-mount MapLibre — see
   * the class doc.
   */
  protected render(): void {
    const kind = this.#composition ? "composition" : "placeholder";
    if (this.#shellKind !== kind || !this.shadowRoot?.querySelector(".canvas")) {
      this.#buildShell(kind);
      this.#shellKind = kind;
    }
    this.#syncTitle();
    if (kind === "composition") {
      void this.#ensureInteractionRuntime();
      this.#syncControlBar();
      this.#syncWidgetDeck();
      this.#syncReadout();
      this.#syncSurface();
      void this.#ensureMapView();
    }
  }

  #buildShell(kind: "placeholder" | "composition"): void {
    const label = this.getAttribute("label") ?? "Canvas";
    this.setShadowHtml(`
      <style>${baseElementStyles()}${canvasStyles()}</style>
      <section class="canvas hn-panel" part="panel" aria-label="${escapeHtml(label)}" data-testid="studio-canvas">
        <div class="canvas-head">
          <h2 class="hn-panel-title" data-testid="studio-canvas-title">${escapeHtml(label)}</h2>
          ${
            kind === "composition"
              ? `<div class="canvas-surfaces" role="group" aria-label="Canvas surface">
                   ${SURFACES.map(
                     (surface) =>
                       `<button type="button" class="hn-btn hn-btn--sm" data-surface-option="${surface}" data-testid="studio-canvas-mode-${surface}">${SURFACE_LABELS[surface]}</button>`,
                   ).join("")}
                 </div>`
              : ""
          }
        </div>
        ${
          kind === "placeholder"
            ? `<div class="canvas-surface" data-testid="studio-canvas-surface" tabindex="0">
                 <span>Composition canvas placeholder — honua-studio#8.</span>
               </div>`
            : `<honua-studio-control-bar
                 class="canvas-controls"
                 data-testid="studio-canvas-control-bar"
                 label="Composed controls"
               ></honua-studio-control-bar>
               <div
                 class="canvas-map"
                 data-testid="studio-canvas-map"
                 role="region"
                 aria-label="Composition map"
                 aria-describedby="composition-readout"
               ></div>
               <p class="canvas-map-status hn-muted" data-testid="studio-canvas-map-status" role="status"></p>
               <honua-studio-widget-deck
                 class="canvas-widgets"
                 data-testid="studio-canvas-widget-deck"
                 label="Composed widgets"
               ></honua-studio-widget-deck>
               <div class="composition-readout" id="composition-readout" data-testid="studio-canvas-readout"></div>`
        }
      </section>
    `);
    if (kind !== "composition") return;
    this.#syncControlBar();
    this.#syncWidgetDeck();
    const signal = this.connectedSignal;
    for (const button of this.shadowRoot?.querySelectorAll<HTMLButtonElement>("[data-surface-option]") ?? []) {
      button.addEventListener(
        "click",
        () => {
          this.surface = (button.dataset.surfaceOption as HonuaStudioCanvasSurface) ?? "map";
        },
        { signal },
      );
    }
  }

  /**
   * Hands the composed widget deck (honua-studio#24) everything it needs and
   * points its selections back at this element's single dispatcher.
   *
   * `customElements.upgrade` is called first for a real reason: the deck is
   * created **by tag name** inside this shadow root, and assigning a property
   * to a not-yet-upgraded custom element writes an own data property that
   * permanently shadows the accessor — the widgets would then never render,
   * with nothing thrown to explain it. `registry.ts` already defines the deck
   * alongside this element; the upgrade call makes the ordering irrelevant
   * rather than merely likely-correct.
   */
  #syncWidgetDeck(): void {
    const deck = this.shadowRoot?.querySelector<HonuaStudioWidgetDeckElement>("honua-studio-widget-deck");
    if (!deck) return;
    if (typeof customElements !== "undefined" && typeof customElements.upgrade === "function") {
      customElements.upgrade(deck);
    }
    // Never assigned before upgrade — see above. A host that registered only
    // `<honua-studio-canvas>` through some path registry.ts does not cover
    // still gets the map and the readout, which lists every widget.
    if (!("composition" in deck)) return;
    deck.sourceBaseUrl = this.#sourceBaseUrl;
    deck.sourceCatalog = this.#sourceCatalog;
    deck.dataLoader = this.#widgetDataLoader;
    deck.onSelection = (targets) => this.#applySelection(targets);
    deck.commandDispatch = this.#commandDispatch;
    deck.composition = this.#composition;
    deck.unrenderableLayers = (this.#mapView?.projection?.unresolved ?? []).map((entry) => ({
      layerId: entry.layerId,
      reason: entry.reason,
    }));
  }

  /**
   * Hands the control bar (honua-studio#25) its composition, the interaction
   * runtime a `change` publishes through, and the narrow map seam its
   * intrinsic affordances act on.
   *
   * The `customElements.upgrade` call is load-bearing for the same reason it
   * is on the deck: the bar is created **by tag name** in this shadow root,
   * and assigning a property to a not-yet-upgraded custom element writes an
   * own data property that permanently shadows the accessor — the controls
   * would then never render, with nothing thrown to explain it.
   */
  #syncControlBar(): void {
    const bar = this.shadowRoot?.querySelector<HonuaStudioControlBarElement>("honua-studio-control-bar");
    if (!bar) return;
    if (typeof customElements !== "undefined" && typeof customElements.upgrade === "function") {
      customElements.upgrade(bar);
    }
    if (!("composition" in bar)) return;
    bar.dataLoader = this.#widgetDataLoader;
    bar.map = this.#mapBridge();
    bar.interactions = this.#interactions;
    bar.composition = this.#composition;
  }

  /**
   * The map, narrowed to what a control needs. Built fresh on each sync so it
   * always closes over the current `CompositionMapView` — a bridge captured
   * once would keep pointing at a disposed map after a projection input
   * changed and `#restartMapView` rebuilt it.
   */
  #mapBridge(): ControlBarMapBridge {
    return {
      available: this.#mapUsable(),
      camera: () => this.#mapView?.camera(),
      nudge: (patch) => this.#mapView?.nudgeCamera(patch),
      container: () => this.#mapView?.container(),
      attributions: () => this.#mapView?.attributions() ?? [],
      setBasemap: (option) => {
        void this.#applyBasemapOption(option.theme ?? "light");
      },
    };
  }

  /**
   * Swaps the vendored offline basemap's palette. The import is dynamic
   * because `../map/basemap.js` carries the vendored Natural Earth geometry —
   * a composition with no basemap switcher must not pay for a second copy of
   * it in the entry bundle (it already lives in the lazy map chunk).
   */
  async #applyBasemapOption(theme: "light" | "dark"): Promise<void> {
    const view = this.#mapView;
    if (!view) return;
    const { createOfflineBasemapStyle } = await import("../map/basemap.js");
    if (this.#mapView !== view) return;
    view.setBasemap(createOfflineBasemapStyle({ theme }));
  }

  /**
   * Creates the interaction runtime the first time a composition declares a
   * control or a binding.
   *
   * Lazy for the same reason the chart pipeline and MapLibre are: the SDK's
   * exploration context and interaction bindings are dead weight for a
   * composition that is only a map and a legend. The import names the two
   * concrete modules rather than `../interactions/index.js` — honua-studio#23's
   * lazy-chunk rule (see this file's import block).
   */
  async #ensureInteractionRuntime(): Promise<void> {
    const controller = this.#composition;
    if (this.#interactions || this.#interactionsPending || !controller) return;
    if (controller.state.controls.length === 0 && controller.state.interactions.length === 0) return;
    this.#interactionsPending = true;
    try {
      const { StudioInteractionRuntime: RuntimeClass } = await import("../interactions/studio-interactions.js");
      if (this.#composition !== controller || !this.isConnected) return;
      this.#interactions = new RuntimeClass({
        controller,
        onAppearanceChange: (appearance) => {
          this.#mapView?.setAppearance(appearance);
          this.#syncControlBar();
        },
      });
      this.#mapView?.setAppearance(this.#interactions.appearance);
      this.#syncControlBar();
    } catch (error) {
      this.dispatchTypedEvent("honua-studio-error", {
        message: `Controls could not be wired to interactions: ${error instanceof Error ? error.message : String(error)}`,
        error,
      });
    } finally {
      this.#interactionsPending = false;
    }
  }

  #teardownInteractions(): void {
    this.#interactions?.dispose();
    this.#interactions = undefined;
    this.#interactionsPending = false;
  }

  #syncTitle(): void {
    const label = this.getAttribute("label") ?? "Canvas";
    const section = this.shadowRoot?.querySelector<HTMLElement>(".canvas");
    section?.setAttribute("aria-label", label);
    const title = this.shadowRoot?.querySelector<HTMLElement>('[data-testid="studio-canvas-title"]');
    if (title) title.textContent = label;
  }

  /** One composition change: readout + map status. The map itself is driven by `CompositionMapView`'s own subscription, not from here. */
  #syncComposition(): void {
    void this.#ensureInteractionRuntime();
    this.#syncControlBar();
    this.#syncReadout();
    this.#syncMapStatus();
  }

  #syncSurface(): void {
    const root = this.shadowRoot;
    if (!root) return;
    // Falling back to Details when the map cannot render is what keeps this
    // element useful (and its tests meaningful) under happy-dom, in a
    // WebGL-less browser, and before the map has started.
    const surface = this.#mapUsable() ? this.surface : "details";
    const map = root.querySelector<HTMLElement>('[data-testid="studio-canvas-map"]');
    if (map) map.hidden = surface !== "map";
    // The readout is never hidden — it is the map's accessible description
    // (`aria-describedby`) and its keyboard-reachable layer/widget list, so
    // "Map" mode means map *plus* a compact readout below it (a table of
    // contents, the way a real GIS surface pairs them), and "Details" mode
    // just gives the readout the whole panel. Hiding it in map mode would
    // trade an accessible surface for nothing.
    root.querySelector<HTMLElement>(".canvas")?.setAttribute("data-surface", surface);
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-surface-option]")) {
      button.setAttribute("aria-pressed", String(button.dataset.surfaceOption === surface));
      button.disabled = button.dataset.surfaceOption === "map" && !this.#mapUsable();
    }
    if (surface === "map") this.#mapView?.resize();
    this.#syncMapStatus();
  }

  #mapUsable(): boolean {
    return this.#mapView?.status === "ready";
  }

  /**
   * The map finished applying an update. Which layers turned out to be
   * unrenderable is only known *after* the projection runs, and the readout
   * renders that flag — so repaint it, but only when the flagged set actually
   * changed. Repainting on every update would replace the readout's DOM on
   * every streamed tool call and could steal focus from a row mid-keyboard
   * navigation.
   */
  #onMapChanged(): void {
    const key = (this.#mapView?.projection?.unresolved ?? []).map((entry) => entry.layerId).join("|");
    if (key !== this.#unresolvedKey) {
      this.#unresolvedKey = key;
      this.#syncReadout();
      // The TOC carries the same "not on map" flag the readout does — a layer
      // list that implies every row is drawn would be the same silent lie.
      this.#syncWidgetDeck();
    }
    // A `scale` control reads the live camera and a `navigation` control reads
    // the bearing — both only become correct once the map has settled.
    this.#syncControlBar();
    this.#syncSurface();
  }

  #syncMapStatus(): void {
    const status = this.shadowRoot?.querySelector<HTMLElement>('[data-testid="studio-canvas-map-status"]');
    if (!status) return;
    status.textContent = this.#mapStatusText();
  }

  #mapStatusText(): string {
    const view = this.#mapView;
    if (!view || view.status === "idle" || view.status === "starting") return "Preparing the map…";
    if (view.status === "unavailable") {
      return `Map unavailable — showing the composition details instead.${
        view.statusDetail ? ` (${view.statusDetail})` : ""
      }`;
    }
    const unresolved = view.projection?.unresolved ?? [];
    if (unresolved.length > 0) return unresolvedSummary(unresolved);
    return view.statusDetail ?? "";
  }

  /**
   * Lazily creates the map binding. The `../map/` import is dynamic so
   * MapLibre and the vendored basemap stay out of Studio's entry bundle, and
   * the WebGL probe runs first so environments that cannot render one never
   * pay for the import at all.
   */
  async #ensureMapView(): Promise<void> {
    if (this.#mapView || this.#mapPending) return;
    const controller = this.#composition;
    const container = this.shadowRoot?.querySelector<HTMLElement>('[data-testid="studio-canvas-map"]');
    if (!controller || !container || !this.isConnected) return;
    const generation = this.#mapGeneration;
    const stale = (): boolean =>
      this.#mapGeneration !== generation || !this.isConnected || this.#composition !== controller;
    this.#mapPending = true;
    try {
      // Two concrete modules rather than the barrel — see the import block at
      // the top of this file for why the barrel would be a correctness bug
      // here, not just a bundling preference.
      const [{ CompositionMapView: MapViewClass, isWebglAvailable }, { MAPLIBRE_CSS }] = await Promise.all([
        import("../map/composition-map-view.js"),
        import("../map/maplibre-styles.js"),
      ]);
      if (stale()) return;
      if (!this.#mapFactory && !isWebglAvailable()) {
        this.#setMapUnavailable("This browser has no WebGL context available.");
        return;
      }
      this.#injectMapStyles(MAPLIBRE_CSS);
      const view = new MapViewClass({
        container,
        controller,
        projection: {
          baseUrl: this.#sourceBaseUrl,
          ...(this.#sourceCatalog !== undefined ? { catalog: this.#sourceCatalog } : {}),
          ...(this.#basemapStyle !== undefined ? { basemap: this.#basemapStyle } : {}),
        },
        ...(this.#mapFactory !== undefined ? { mapFactory: this.#mapFactory } : {}),
        ...(this.#viewTransitionMs !== undefined ? { viewTransitionMs: this.#viewTransitionMs } : {}),
        ...(this.#interactions !== undefined ? { appearance: this.#interactions.appearance } : {}),
        onSelection: (targets) => {
          // A measuring click is a measuring click. Letting it also select
          // would fire a deictic "THIS" the user never asked for, mid-measure.
          if (this.controlBar?.isMeasuring()) return;
          this.#applySelection(targets);
        },
        onMapClick: (point: LngLat) => this.controlBar?.appendMeasurePoint(point),
        onChange: () => this.#onMapChanged(),
      });
      await view.start();
      if (stale()) {
        view.dispose();
        return;
      }
      this.#mapView = view;
      this.#syncSurface();
      // The readout's "not on map" flags come from the projection, which only
      // exists once the view has run — repaint it now that it does.
      this.#onMapChanged();
    } catch (error) {
      if (!stale()) this.#setMapUnavailable(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.#mapGeneration === generation) this.#mapPending = false;
    }
  }

  /** Records an unavailable map without a `CompositionMapView` to hold the state — the import itself may be what failed. */
  #setMapUnavailable(detail: string): void {
    const status = this.shadowRoot?.querySelector<HTMLElement>('[data-testid="studio-canvas-map-status"]');
    if (status) status.textContent = `Map unavailable — showing the composition details instead. (${detail})`;
    const map = this.shadowRoot?.querySelector<HTMLElement>('[data-testid="studio-canvas-map"]');
    if (map) map.hidden = true;
    this.shadowRoot?.querySelector<HTMLElement>(".canvas")?.setAttribute("data-surface", "details");
    for (const button of this.shadowRoot?.querySelectorAll<HTMLButtonElement>("[data-surface-option]") ?? []) {
      button.disabled = button.dataset.surfaceOption === "map";
      button.setAttribute("aria-pressed", String(button.dataset.surfaceOption === "details"));
    }
  }

  /** MapLibre's stylesheet, injected once per shell build (shadow DOM does not inherit document styles). */
  #injectMapStyles(css: string): void {
    const root = this.shadowRoot;
    if (!root || root.querySelector('style[data-honua-maplibre="true"]')) return;
    const style = document.createElement("style");
    style.setAttribute("data-honua-maplibre", "true");
    style.textContent = css;
    root.appendChild(style);
  }

  #teardownMapView(): void {
    this.#mapView?.dispose();
    this.#mapView = undefined;
  }

  /** A projection input changed; the map has to be rebuilt around it. No-op while the canvas has never had one. */
  #restartMapView(): void {
    if (!this.#mapView && !this.#mapPending) return;
    this.#mapGeneration += 1;
    this.#mapPending = false;
    this.#teardownMapView();
    if (this.isConnected && this.#composition) void this.#ensureMapView();
  }

  #applySelection(targets: readonly CompositionTarget[]): void {
    if (targets.length === 0) return;
    this.#composition?.select(targets);
    this.dispatchTypedEvent<HonuaStudioSelectionChangeDetail>("honua-studio-selection-change", {
      targets: [...targets],
    });
  }

  #syncReadout(): void {
    const readout = this.shadowRoot?.querySelector<HTMLElement>('[data-testid="studio-canvas-readout"]');
    const controller = this.#composition;
    if (!readout || !controller) return;
    readout.innerHTML = this.#renderReadout(controller);
    this.#bindRowListeners();
  }

  #renderReadout(controller: CompositionController): string {
    const state = controller.state;
    const selectionKeys = new Set(controller.selection.map(targetKey));
    const unresolved = new Map(
      (this.#mapView?.projection?.unresolved ?? []).map((entry) => [entry.layerId, entry.reason] as const),
    );
    return `
        ${renderSection(
          "Layers",
          "layers",
          state.layers,
          (layer) => layer.id,
          (layer) =>
            renderLayerRow(
              layer,
              selectionKeys,
              state.pins.some((pin) => targetMatches(pin, "layer", layer.id)),
              unresolved.get(layer.id),
            ),
        )}
        ${renderViewSection(state.view)}
        ${renderSection(
          "Widgets",
          "widgets",
          state.widgets,
          (widget) => widget.id,
          (widget) =>
            renderWidgetRow(
              widget,
              selectionKeys,
              state.pins.some((pin) => targetMatches(pin, "component", widget.id)),
            ),
        )}
        ${renderSection(
          "Controls",
          "controls",
          state.controls,
          (control) => control.id,
          (control) =>
            renderControlRow(
              control,
              selectionKeys,
              state.pins.some((pin) => targetMatches(pin, "control", control.id)),
              describeControl(state, control),
            ),
        )}
        ${renderSection(
          "Annotations",
          "annotations",
          state.annotations,
          (annotation) => annotation.id,
          (annotation) =>
            renderAnnotationRow(
              annotation,
              selectionKeys,
              state.pins.some((pin) => targetMatches(pin, "region", annotation.id)),
            ),
        )}
        ${renderPinsSection(state.pins)}
    `;
  }

  #bindRowListeners(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const signal = this.connectedSignal;
    for (const row of root.querySelectorAll<HTMLButtonElement>("[data-target-kind][data-target-id]")) {
      row.addEventListener(
        "click",
        () => {
          const kind = row.dataset.targetKind;
          const id = row.dataset.targetId;
          if (!kind || !id) return;
          this.#applySelection([{ kind, id } as CompositionTarget]);
        },
        { signal },
      );
    }
  }
}

function unresolvedSummary(unresolved: readonly UnresolvedCompositionLayer[]): string {
  const first = unresolved[0];
  if (unresolved.length === 1 && first) return `1 layer is not renderable: ${first.reason}`;
  return `${unresolved.length} layers are not renderable — see Details.`;
}

function targetKey(target: CompositionTarget): string {
  return target.kind === "feature"
    ? `feature:${target.sourceId}:${String(target.featureId)}`
    : `${target.kind}:${target.id}`;
}

function targetMatches(
  target: CompositionTarget,
  kind: "layer" | "component" | "region" | "control",
  id: string,
): boolean {
  return target.kind === kind && (target as { readonly id?: string }).id === id;
}

function renderSection<T>(
  title: string,
  testIdSuffix: string,
  items: readonly T[],
  keyOf: (item: T) => string,
  rowOf: (item: T) => string,
): string {
  return `
    <div class="composition-section" data-testid="studio-canvas-${testIdSuffix}">
      <h3>${escapeHtml(title)}</h3>
      ${
        items.length === 0
          ? `<p class="composition-empty hn-muted">None yet.</p>`
          : `<ul class="composition-list">${items
              .map((item) => `<li data-key="${escapeHtml(keyOf(item))}">${rowOf(item)}</li>`)
              .join("")}</ul>`
      }
    </div>
  `;
}

function renderLayerRow(
  layer: CompositionLayer,
  selectionKeys: Set<string>,
  pinned: boolean,
  unresolvedReason: string | undefined,
): string {
  const target: CompositionTarget = { kind: "layer", id: layer.id };
  const selected = selectionKeys.has(targetKey(target));
  const detail = [
    layer.sourceId,
    layer.visible ? "visible" : "hidden",
    layer.styleRef ? layer.styleRef.styleId : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return renderRow("layer", layer.id, layer.title ?? layer.id, detail, selected, pinned, unresolvedReason);
}

function renderWidgetRow(widget: CompositionWidget, selectionKeys: Set<string>, pinned: boolean): string {
  const target: CompositionTarget = { kind: "component", id: widget.id };
  const selected = selectionKeys.has(targetKey(target));
  const detail = [widget.kind, widget.sourceId].filter((part): part is string => Boolean(part)).join(" · ");
  return renderRow("component", widget.id, widget.title ?? widget.id, detail, selected, pinned);
}

/**
 * A control in the readout. It carries the same "not on map" style flag a
 * layer does, for the same reason: a control the canvas could not render is
 * still a control the composition holds, and a readout that lists it as if it
 * were working would be the silent lie honua-studio#23's class doc rules out.
 */
function renderControlRow(
  control: CompositionControl,
  selectionKeys: Set<string>,
  pinned: boolean,
  status: ControlStatus,
): string {
  const target: CompositionTarget = { kind: "control", id: control.id };
  const selected = selectionKeys.has(targetKey(target));
  const detail = [control.kind, control.sourceId].filter((part): part is string => Boolean(part)).join(" · ");
  return renderRow(
    "control",
    control.id,
    control.title ?? control.id,
    detail,
    selected,
    pinned,
    status.state === "unsupported" ? status.reason : undefined,
    "not rendered",
  );
}

function renderAnnotationRow(annotation: CompositionAnnotation, selectionKeys: Set<string>, pinned: boolean): string {
  const target: CompositionTarget = { kind: "region", id: annotation.id };
  const selected = selectionKeys.has(targetKey(target));
  const detail = [annotation.kind, annotation.text].filter((part): part is string => Boolean(part)).join(" · ");
  return renderRow("region", annotation.id, annotation.label ?? annotation.id, detail, selected, pinned);
}

function renderRow(
  kind: string,
  id: string,
  title: string,
  detail: string,
  selected: boolean,
  pinned: boolean,
  unresolvedReason?: string,
  flagLabel = "not on map",
): string {
  return `
    <button
      type="button"
      class="composition-row"
      data-testid="studio-canvas-row"
      data-target-kind="${escapeHtml(kind)}"
      data-target-id="${escapeHtml(id)}"
      aria-pressed="${selected}"
      data-pinned="${pinned}"
      ${unresolvedReason ? `data-unrendered="true" title="${escapeHtml(unresolvedReason)}"` : ""}
    >
      <span>${escapeHtml(title)}${pinned ? ' <span aria-label="pinned">📌</span>' : ""}${
        unresolvedReason
          ? ` <span class="composition-flag" data-testid="studio-canvas-unrendered">${escapeHtml(flagLabel)}</span>`
          : ""
      }</span>
      ${detail ? `<span class="hn-muted">${escapeHtml(detail)}</span>` : ""}
    </button>
  `;
}

function renderViewSection(view: {
  readonly zoom?: number;
  readonly center?: readonly [number, number];
  readonly pitch?: number;
  readonly bearing?: number;
  readonly bbox?: readonly [number, number, number, number];
}): string {
  const fields: string[] = [];
  if (view.center) fields.push(`center [${view.center[0]}, ${view.center[1]}]`);
  if (view.zoom !== undefined) fields.push(`zoom ${view.zoom}`);
  if (view.pitch !== undefined) fields.push(`pitch ${view.pitch}`);
  if (view.bearing !== undefined) fields.push(`bearing ${view.bearing}`);
  if (view.bbox) fields.push(`bbox [${view.bbox.join(", ")}]`);
  return `
    <div class="composition-section" data-testid="studio-canvas-view">
      <h3>View</h3>
      ${
        fields.length === 0
          ? `<p class="composition-empty hn-muted">Unset.</p>`
          : `<ul class="composition-view-fields">${fields.map((field) => `<li>${escapeHtml(field)}</li>`).join("")}</ul>`
      }
    </div>
  `;
}

function renderPinsSection(pins: readonly CompositionTarget[]): string {
  return `
    <div class="composition-section" data-testid="studio-canvas-pins">
      <h3>Pins</h3>
      ${
        pins.length === 0
          ? `<p class="composition-empty hn-muted">Nothing pinned.</p>`
          : `<ul class="composition-list">${pins
              .map((pin) => `<li class="hn-badge" data-testid="studio-canvas-pin">${escapeHtml(targetKey(pin))}</li>`)
              .join("")}</ul>`
      }
    </div>
  `;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
