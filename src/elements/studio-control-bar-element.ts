/**
 * `<honua-studio-control-bar>` — the controls collection, rendered
 * (honua-studio#25).
 *
 * honua-studio#24 gave the agent widgets: surfaces that *display*. This gives
 * it controls: affordances that *input*. The distinction is the whole reason
 * ADR-0031 puts them in a separate collection — controls are chrome, docked
 * around the map, and deliberately not `layout` grid items — and it is why
 * this is a separate element from the widget deck rather than another kind
 * inside it.
 *
 * ## Two halves, from the standard's own split
 *
 *  - **Map affordances** (`navigation`, `scale`, `fullscreen`, `geolocate`,
 *    `attribution`, `basemapSwitcher`, `bookmarks`, `measure`) behave
 *    *intrinsically* (REQ-003). An agent writes
 *    `addControl({ kind: "navigation" })` and gets working zoom buttons; it
 *    never authors a binding to make a zoom button zoom. Where the behavior
 *    is a composition mutation (a bookmark's camera move) it goes through
 *    `controller.apply(...)` — the same reducer, pins, history and draft sync
 *    every other write uses, exactly as honua-studio#24 made TOC toggles
 *    intrinsic without giving them a side door.
 *  - **Data-binding affordances** (`timeSlider`, `filterSelect`,
 *    `filterSlider`, `filterDateRange`, `opacity`) emit `change` — the ADR-0030
 *    event this issue exists to make reachable. They publish through
 *    {@link StudioInteractionRuntime}, i.e. through the SDK's own
 *    `bindFilterControlsToExploration` primitive on a shared exploration
 *    context. **This element never calls the map directly to filter
 *    anything** and never invents an event bus: it writes one clause, and the
 *    compiler and the map's appearance both read it.
 *
 * ## Nothing is silently dropped
 *
 * REQ-001: every kind either renders or reports. `search` is the one kind
 * that always reports (no provider vocabulary exists upstream — see
 * `../controls/control-config.ts`), and any control whose config or `sourceId`
 * cannot be resolved reports its own specific reason on its own card. A
 * kind's reason appears where the control would have been, never in a console
 * and never nowhere.
 *
 * Rendering discipline mirrors the widget deck: whole-subtree repaint through
 * the focus-preserving {@link HonuaStudioElementBase.setShadowHtml}, with
 * **delegated** listeners bound once per connection and dispatched by
 * `data-action` — per-node binding after every repaint would accumulate abort
 * registrations for the life of the session.
 */
import type { CompositionController } from "../composition/controller.js";
import type { CompositionControl, CompositionTarget } from "../composition/model.js";
import {
  type BasemapOption,
  CONTROL_KIND_LABELS,
  type CompositionControlConfig,
  type ControlStatus,
  describeControl,
} from "../controls/control-config.js";
import {
  type LngLat,
  type MeasurementUnit,
  computeScaleBar,
  formatArea,
  formatDistance,
  pathLengthMeters,
  ringAreaSquareMeters,
} from "../controls/geodesy.js";
// Concrete modules, never `../interactions/index.js` — honua-studio#23's
// lazy-chunk rule (see `./studio-canvas-element.ts`'s import block for the
// double-module-evaluation hazard a barrel round-trip creates under Blazor).
import type { StudioInteractionRuntime } from "../interactions/studio-interactions.js";
import type { WidgetDataLoader } from "../widgets/widget-data.js";
import { HonuaStudioElementBase } from "./base-element.js";
import { baseElementStyles, controlBarStyles } from "./styles.js";
import type { HonuaStudioControlChangeDetail } from "./types.js";

/** A live camera reading. Structurally identical to `CompositionMapCamera`, declared here so this element never imports the map chunk. */
export interface ControlBarCamera {
  readonly zoom: number;
  readonly center: readonly [number, number];
  readonly bearing: number;
}

/**
 * Everything a control needs from the map, as a narrow duck-typed seam.
 *
 * This element must not import `../map/composition-map-view.js`: it is
 * registered in the entry bundle, and the map is a lazily-loaded chunk. The
 * canvas adapts its `CompositionMapView` to this interface instead — which
 * also means every intrinsic map behavior is exercised in `environment:
 * "node"` against a plain object literal, the same seam `mapFactory` and
 * `dataLoader` already established.
 */
export interface ControlBarMapBridge {
  /** False before the map is ready or where WebGL is unavailable — map affordances render disabled with a reason rather than lying. */
  readonly available: boolean;
  camera(): ControlBarCamera | undefined;
  nudge(patch: { readonly zoomBy?: number; readonly bearing?: number }): void;
  container(): HTMLElement | undefined;
  attributions(): readonly string[];
  /** Applies the basemap a `basemapSwitcher` chose. `theme` selects one of the vendored offline palettes; `id` is the authored base's id. */
  setBasemap(option: BasemapOption): void;
}

interface MeasureState {
  readonly active: boolean;
  readonly points: readonly LngLat[];
}

type OptionsState =
  | { readonly status: "loading" }
  | { readonly status: "done"; readonly options: readonly string[]; readonly reason?: string };

const EMPTY_MEASURE: MeasureState = { active: false, points: [] };

export class HonuaStudioControlBarElement extends HonuaStudioElementBase {
  static get observedAttributes(): string[] {
    return ["label"];
  }

  /** Live (connected) instance count — the same leak-detection probe every other Studio element carries. */
  static instanceCount = 0;

  #composition: CompositionController | undefined;
  #compositionUnsubscribe: (() => void) | undefined;
  #interactions: StudioInteractionRuntime | undefined;
  #map: ControlBarMapBridge | undefined;
  #dataLoader: WidgetDataLoader | undefined;
  #measure = new Map<string, MeasureState>();
  #options = new Map<string, OptionsState>();
  #basemapChoice = new Map<string, string>();
  /** Last rejected intrinsic mutation, surfaced on the control rather than swallowed. */
  #commandError: string | undefined;

  public get composition(): CompositionController | undefined {
    return this.#composition;
  }

  public set composition(composition: CompositionController | undefined) {
    if (this.#composition === composition) return;
    this.#compositionUnsubscribe?.();
    this.#compositionUnsubscribe = undefined;
    this.#composition = composition;
    this.#options.clear();
    this.#measure.clear();
    if (composition && this.isConnected) {
      this.#compositionUnsubscribe = composition.subscribe(() => this.render());
    }
    this.render();
  }

  /** The interaction runtime a `change` is published through. Without it, change-emitting controls render disabled and say so. */
  public get interactions(): StudioInteractionRuntime | undefined {
    return this.#interactions;
  }

  public set interactions(runtime: StudioInteractionRuntime | undefined) {
    if (this.#interactions === runtime) return;
    this.#interactions = runtime;
    this.render();
  }

  /** The map seam the intrinsic affordances act on. */
  public get map(): ControlBarMapBridge | undefined {
    return this.#map;
  }

  public set map(bridge: ControlBarMapBridge | undefined) {
    this.#map = bridge;
    this.render();
  }

  /** Feature loader used to derive a `filterSelect`'s domain from its bound source. Same seam the widget deck uses. */
  public get dataLoader(): WidgetDataLoader | undefined {
    return this.#dataLoader;
  }

  public set dataLoader(loader: WidgetDataLoader | undefined) {
    if (this.#dataLoader === loader) return;
    this.#dataLoader = loader;
    this.#options.clear();
    this.render();
  }

  /** True while any `measure` control is collecting vertices — the canvas suppresses selection so a measuring click does not also select. */
  public isMeasuring(): boolean {
    for (const state of this.#measure.values()) if (state.active) return true;
    return false;
  }

  /** Feeds one map click into every active `measure` control. No-op when nothing is measuring. */
  public appendMeasurePoint(point: LngLat): void {
    let changed = false;
    for (const [controlId, state] of this.#measure) {
      if (!state.active) continue;
      this.#measure.set(controlId, { active: true, points: [...state.points, point] });
      changed = true;
    }
    if (changed) this.render();
  }

  /** Re-reads the camera (a `scale` control's only input). The canvas calls this when the map settles. */
  public refreshCamera(): void {
    if (this.isConnected) this.render();
  }

  public attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (!this.isConnected || oldValue === newValue || name !== "label") return;
    this.render();
  }

  protected onConnect(): void {
    HonuaStudioControlBarElement.instanceCount += 1;
    if (this.#composition && !this.#compositionUnsubscribe) {
      this.#compositionUnsubscribe = this.#composition.subscribe(() => this.render());
    }
    const root = this.ensureShadowRoot();
    this.listen(root, "click", (event) => this.#onClick(event));
    this.listen(root, "change", (event) => this.#onChange(event));
    this.listen(root, "input", (event) => this.#onChange(event));
  }

  protected onDisconnect(): void {
    HonuaStudioControlBarElement.instanceCount -= 1;
    this.#compositionUnsubscribe?.();
    this.#compositionUnsubscribe = undefined;
  }

  protected render(): void {
    const controller = this.#composition;
    const controls = controller?.state.controls ?? [];
    if (controls.length === 0) this.dataset.empty = "true";
    else delete this.dataset.empty;

    const label = this.getAttribute("label") ?? "Controls";
    const cards = controller ? controls.map((control) => this.#renderControl(control)).join("") : "";
    this.setShadowHtml(`
      <style>${baseElementStyles()}${controlBarStyles()}</style>
      <section class="control-bar" part="controls" aria-label="${escapeHtml(label)}" data-testid="studio-control-bar">
        ${cards}
      </section>
    `);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  #renderControl(control: CompositionControl): string {
    const controller = this.#composition;
    if (!controller) return "";
    const status: ControlStatus = describeControl(controller.state, control);
    const title = control.title ?? CONTROL_KIND_LABELS[control.kind];
    const pinned = controller.state.pins.some((pin) => pin.kind === "control" && pin.id === control.id);

    const body =
      status.state === "unsupported" ? { html: "", status: status.reason } : this.#renderBody(control, status.config);
    const note = status.state === "rendered" ? status.note : undefined;

    return `
      <article
        class="control"
        data-testid="studio-control"
        data-control-id="${escapeHtml(control.id)}"
        data-control-kind="${escapeHtml(control.kind)}"
        data-state="${status.state}"
        aria-label="${escapeHtml(title)}"
      >
        <header class="control-head">
          <h4 class="control-title" data-testid="studio-control-title">${escapeHtml(title)}${
            pinned ? ' <span aria-label="pinned">📌</span>' : ""
          }</h4>
          <span class="hn-badge control-kind">${escapeHtml(control.kind)}</span>
        </header>
        ${body.html ? `<div class="control-body">${body.html}</div>` : ""}
        ${
          body.status
            ? `<p class="control-status hn-muted" data-testid="studio-control-unsupported" role="status">${escapeHtml(body.status)}</p>`
            : ""
        }
        ${note ? `<p class="control-note hn-muted" data-testid="studio-control-note">${escapeHtml(note)}</p>` : ""}
        ${
          this.#commandError
            ? `<p class="control-status hn-error" data-testid="studio-control-error" role="status">${escapeHtml(this.#commandError)}</p>`
            : ""
        }
      </article>
    `;
  }

  #renderBody(control: CompositionControl, normalized: CompositionControlConfig): { html: string; status?: string } {
    switch (normalized.kind) {
      case "navigation":
        return this.#renderNavigation(control, normalized.config.showZoom, normalized.config.showCompass);
      case "scale":
        return this.#renderScale(normalized.config.unit, normalized.config.maxWidthPx);
      case "fullscreen":
        return this.#renderFullscreen(control);
      case "geolocate":
        return this.#renderGeolocate(control);
      case "attribution":
        return this.#renderAttribution();
      case "basemapSwitcher":
        return this.#renderBasemapSwitcher(control, normalized.config.bases);
      case "bookmarks":
        return this.#renderBookmarks(control, normalized.config.bookmarks);
      case "measure":
        return this.#renderMeasure(control, normalized.config.mode, normalized.config.unit);
      case "opacity":
        return this.#renderOpacity(control, normalized.config.value);
      case "filterSelect":
        return this.#renderFilterSelect(control, normalized.config);
      case "filterSlider":
        return this.#renderFilterSlider(control, normalized.config);
      case "filterDateRange":
        return this.#renderDateRange(control, normalized.config);
      case "timeSlider":
        return this.#renderTimeSlider(control, normalized.config);
    }
  }

  /** REQ-003: zoom and compass act on the camera directly. No binding, no composition write — a camera nudge is not a document edit. */
  #renderNavigation(
    control: CompositionControl,
    showZoom: boolean,
    showCompass: boolean,
  ): { html: string; status?: string } {
    if (!this.#map?.available) return { html: "", status: mapUnavailable("Navigation") };
    const bearing = this.#map.camera()?.bearing ?? 0;
    const button = (action: string, label: string, text: string): string => `
      <button type="button" class="hn-btn hn-btn--sm control-icon" data-action="${action}"
        data-control-id="${escapeHtml(control.id)}" aria-label="${escapeHtml(label)}"
        data-testid="studio-control-${action}">${text}</button>`;
    return {
      html: `
        <div class="control-row" role="group" aria-label="Navigation">
          ${showZoom ? button("zoom-in", "Zoom in", "+") : ""}
          ${showZoom ? button("zoom-out", "Zoom out", "−") : ""}
          ${showCompass ? button("reset-north", `Reset bearing (currently ${Math.round(bearing)}°)`, "◎") : ""}
        </div>
      `,
    };
  }

  #renderScale(unit: MeasurementUnit, maxWidthPx: number): { html: string; status?: string } {
    const bar = computeScaleBar(this.#map?.camera(), maxWidthPx, unit);
    if (!bar) return { html: "", status: mapUnavailable("Scale") };
    return {
      html: `
        <div class="control-scale" data-testid="studio-control-scale" aria-label="Map scale">
          <span class="control-scale-bar" style="width:${Math.round(bar.widthPx)}px" aria-hidden="true"></span>
          <span class="control-scale-label" data-testid="studio-control-scale-label">${escapeHtml(bar.label)}</span>
        </div>
      `,
    };
  }

  #renderFullscreen(control: CompositionControl): { html: string; status?: string } {
    if (typeof document === "undefined" || !("fullscreenEnabled" in document) || document.fullscreenEnabled !== true) {
      return { html: "", status: "Fullscreen is not permitted in this browsing context." };
    }
    const active = typeof document !== "undefined" && document.fullscreenElement !== null;
    return {
      html: `
        <button type="button" class="hn-btn hn-btn--sm" data-action="fullscreen"
          data-control-id="${escapeHtml(control.id)}" aria-pressed="${active}"
          data-testid="studio-control-fullscreen">${active ? "Exit fullscreen" : "Fullscreen"}</button>
      `,
    };
  }

  #renderGeolocate(control: CompositionControl): { html: string; status?: string } {
    const available =
      typeof navigator !== "undefined" && typeof navigator.geolocation?.getCurrentPosition === "function";
    if (!available) return { html: "", status: "This browser exposes no geolocation API." };
    if (!this.#map?.available) return { html: "", status: mapUnavailable("My location") };
    return {
      html: `
        <button type="button" class="hn-btn hn-btn--sm" data-action="geolocate"
          data-control-id="${escapeHtml(control.id)}" data-testid="studio-control-geolocate">Find me</button>
      `,
    };
  }

  #renderAttribution(): { html: string; status?: string } {
    const credits = this.#map?.attributions() ?? [];
    if (credits.length === 0) return { html: "", status: "No source in this composition declares an attribution." };
    return {
      html: `<ul class="control-attribution" data-testid="studio-control-attribution">${credits
        .map((credit) => `<li>${escapeHtml(credit)}</li>`)
        .join("")}</ul>`,
    };
  }

  /**
   * Options and change detail borrow the SDK control kit's vocabulary
   * (`HonuaBasemapDefinition`, `HonuaBasemapSwitcherChangeDetail` in
   * `@honua/sdk-js/controls`) rather than inventing a Studio spelling — see
   * this issue's PR body on the native-vs-delegate decision.
   */
  #renderBasemapSwitcher(
    control: CompositionControl,
    bases: readonly BasemapOption[],
  ): { html: string; status?: string } {
    if (!this.#map?.available) return { html: "", status: mapUnavailable("Basemap") };
    const current = this.#basemapChoice.get(control.id) ?? bases[0]?.id;
    return {
      html: `
        <div class="control-row" role="radiogroup" aria-label="Basemap" data-testid="studio-control-basemap">
          ${bases
            .map(
              (base) => `
            <button type="button" class="hn-btn hn-btn--sm" role="radio"
              data-action="basemap" data-control-id="${escapeHtml(control.id)}" data-base-id="${escapeHtml(base.id)}"
              data-kind="${escapeHtml(base.kind)}"
              aria-checked="${base.id === current}" aria-pressed="${base.id === current}"
              data-testid="studio-control-basemap-option">${escapeHtml(base.label)}</button>`,
            )
            .join("")}
        </div>
      `,
    };
  }

  /** A bookmark applies a `setView` COMMAND — the intrinsic behavior and an agent's authored `setView` are the same write path. */
  #renderBookmarks(
    control: CompositionControl,
    bookmarks: readonly { id: string; label: string }[],
  ): {
    html: string;
    status?: string;
  } {
    return {
      html: `
        <ul class="control-bookmarks" data-testid="studio-control-bookmarks">
          ${bookmarks
            .map(
              (bookmark) => `
            <li><button type="button" class="hn-btn hn-btn--sm" data-action="bookmark"
              data-control-id="${escapeHtml(control.id)}" data-bookmark-id="${escapeHtml(bookmark.id)}"
              data-testid="studio-control-bookmark">${escapeHtml(bookmark.label)}</button></li>`,
            )
            .join("")}
        </ul>
      `,
    };
  }

  /**
   * `measure` computes on the client and persists nothing — which is exactly
   * why ADR-0031 admits it while excluding a draw control. Vertices come from
   * map clicks the canvas forwards; the readout is the measurement.
   *
   * Scope note, stated rather than hidden: the vertices are **not drawn on
   * the map**. A transient overlay would have to be a style source, and the
   * next `setStyle(…, { diff: true })` would delete it — the projection would
   * need a first-class overlay input, which is worth doing and is not this
   * issue. The numbers are correct and the vertex list is shown.
   */
  #renderMeasure(
    control: CompositionControl,
    mode: "distance" | "area",
    unit: MeasurementUnit,
  ): {
    html: string;
    status?: string;
  } {
    if (!this.#map?.available) return { html: "", status: mapUnavailable("Measure") };
    const state = this.#measure.get(control.id) ?? EMPTY_MEASURE;
    const value =
      mode === "area"
        ? formatArea(ringAreaSquareMeters(state.points), unit)
        : formatDistance(pathLengthMeters(state.points), unit);
    const enough = mode === "area" ? state.points.length >= 3 : state.points.length >= 2;
    return {
      html: `
        <div class="control-measure" data-testid="studio-control-measure" data-active="${state.active}">
          <button type="button" class="hn-btn hn-btn--sm" data-action="measure-toggle"
            data-control-id="${escapeHtml(control.id)}" aria-pressed="${state.active}"
            data-testid="studio-control-measure-toggle">${state.active ? "Stop" : "Measure"}</button>
          <output class="control-measure-value" data-testid="studio-control-measure-value">${escapeHtml(
            enough ? value : "—",
          )}</output>
          <button type="button" class="hn-btn hn-btn--sm" data-action="measure-clear"
            data-control-id="${escapeHtml(control.id)}" ${state.points.length === 0 ? "disabled" : ""}
            data-testid="studio-control-measure-clear">Clear</button>
        </div>
      `,
      ...(state.active
        ? {
            status: `Click the map to add points (${state.points.length} so far). Measurements are transient — nothing is saved to the composition.`,
          }
        : {}),
    };
  }

  #renderOpacity(control: CompositionControl, authored: number): { html: string; status?: string } {
    const runtime = this.#interactions;
    if (!runtime) return { html: "", status: noRuntime("Opacity") };
    const clause = runtime.clauseFor(control.id);
    const value = typeof clause?.value === "number" ? clause.value : authored;
    return {
      html: `
        <div class="control-field">
          <input type="range" min="0" max="1" step="0.05" value="${value}"
            class="control-slider" data-action="opacity" data-control-id="${escapeHtml(control.id)}"
            id="opacity-${escapeHtml(control.id)}" aria-label="Opacity"
            data-testid="studio-control-opacity" />
          <output class="control-value" data-testid="studio-control-opacity-value">${Math.round(value * 100)}%</output>
        </div>
      `,
    };
  }

  #renderFilterSelect(
    control: CompositionControl,
    config: {
      field: string;
      options: readonly { value: string; label: string }[];
      multiple: boolean;
      includeAllOption: boolean;
    },
  ): { html: string; status?: string } {
    const runtime = this.#interactions;
    if (!runtime) return { html: "", status: noRuntime("Filter") };
    let options = config.options;
    let status: string | undefined;
    if (options.length === 0) {
      const derived = this.#deriveOptions(control, config.field);
      if (derived.status === "loading") return { html: "", status: `Reading ${control.sourceId} values…` };
      if (derived.reason) status = derived.reason;
      options = derived.options.map((value) => ({ value, label: value }));
    }
    if (options.length === 0) {
      return {
        html: "",
        status:
          status ??
          `Filter "${control.id}" has no options: config.options is empty and "${config.field}" appears on no feature of ${control.sourceId ?? "its source"}.`,
      };
    }
    const current = String(runtime.clauseFor(control.id)?.value ?? "");
    return {
      html: `
        <div class="control-field">
          <select class="control-select" data-action="filter-select" data-control-id="${escapeHtml(control.id)}"
            id="filter-${escapeHtml(control.id)}" aria-label="${escapeHtml(config.field)}"
            data-testid="studio-control-filter-select">
            ${config.includeAllOption ? `<option value="">All</option>` : ""}
            ${options
              .map(
                (option) =>
                  `<option value="${escapeHtml(option.value)}"${option.value === current ? " selected" : ""}>${escapeHtml(option.label)}</option>`,
              )
              .join("")}
          </select>
        </div>
      `,
      ...(status ? { status } : {}),
    };
  }

  #renderFilterSlider(
    control: CompositionControl,
    config: { field: string; min: number; max: number; step: number; operator: string },
  ): { html: string; status?: string } {
    const runtime = this.#interactions;
    if (!runtime) return { html: "", status: noRuntime("Range filter") };
    const clause = runtime.clauseFor(control.id);
    const value = typeof clause?.value === "number" ? clause.value : config.min;
    return {
      html: `
        <div class="control-field">
          <input type="range" min="${config.min}" max="${config.max}" step="${config.step}" value="${value}"
            class="control-slider" data-action="filter-slider" data-control-id="${escapeHtml(control.id)}"
            id="range-${escapeHtml(control.id)}" aria-label="${escapeHtml(config.field)} ${escapeHtml(config.operator)}"
            data-testid="studio-control-filter-slider" />
          <output class="control-value" data-testid="studio-control-filter-slider-value">${escapeHtml(
            `${config.operator} ${value}`,
          )}</output>
        </div>
      `,
    };
  }

  #renderDateRange(
    control: CompositionControl,
    config: { field: string; from?: string; to?: string },
  ): { html: string; status?: string } {
    const runtime = this.#interactions;
    if (!runtime) return { html: "", status: noRuntime("Date filter") };
    const clause = runtime.clauseFor(control.id);
    const range = Array.isArray(clause?.value) ? (clause?.value as unknown[]) : [];
    const from = typeof range[0] === "string" ? range[0] : (config.from ?? "");
    const to = typeof range[1] === "string" ? range[1] : (config.to ?? "");
    return {
      html: `
        <div class="control-field control-field--range">
          <label class="control-label" for="from-${escapeHtml(control.id)}">From</label>
          <input type="date" id="from-${escapeHtml(control.id)}" value="${escapeHtml(from)}"
            data-action="date-from" data-control-id="${escapeHtml(control.id)}"
            data-testid="studio-control-date-from" />
          <label class="control-label" for="to-${escapeHtml(control.id)}">To</label>
          <input type="date" id="to-${escapeHtml(control.id)}" value="${escapeHtml(to)}"
            data-action="date-to" data-control-id="${escapeHtml(control.id)}"
            data-testid="studio-control-date-to" />
        </div>
      `,
    };
  }

  #renderTimeSlider(
    control: CompositionControl,
    config: { field: string; from: string; to: string; stepDays: number },
  ): { html: string; status?: string } {
    const runtime = this.#interactions;
    if (!runtime) return { html: "", status: noRuntime("Time slider") };
    const start = Date.parse(`${config.from}T00:00:00Z`);
    const end = Date.parse(`${config.to}T00:00:00Z`);
    const dayMs = 86_400_000;
    const steps = Math.max(Math.floor((end - start) / (dayMs * config.stepDays)), 1);
    const clause = runtime.clauseFor(control.id);
    const currentIso = typeof clause?.value === "string" ? clause.value : config.from;
    const index = Math.min(
      Math.max(Math.round((Date.parse(`${currentIso}T00:00:00Z`) - start) / (dayMs * config.stepDays)), 0),
      steps,
    );
    return {
      html: `
        <div class="control-field">
          <input type="range" min="0" max="${steps}" step="1" value="${index}"
            class="control-slider" data-action="time-slider" data-control-id="${escapeHtml(control.id)}"
            data-start="${start}" data-step-days="${config.stepDays}"
            id="time-${escapeHtml(control.id)}" aria-label="${escapeHtml(config.field)}"
            aria-valuetext="${escapeHtml(currentIso)}"
            data-testid="studio-control-time-slider" />
          <output class="control-value" data-testid="studio-control-time-slider-value">${escapeHtml(currentIso)}</output>
        </div>
      `,
    };
  }

  // -------------------------------------------------------------------------
  // filterSelect domain derivation
  // -------------------------------------------------------------------------

  /**
   * ADR-0031 says `sourceId` names "the layer whose field values populate a
   * filterSelect", so a select with no authored options derives them — one
   * bounded fetch through the same loader the widget deck's grid uses, so
   * there is one data path, not two.
   */
  #deriveOptions(
    control: CompositionControl,
    field: string,
  ): { status: "loading" } | { status: "done"; options: readonly string[]; reason?: string } {
    const sourceId = control.sourceId;
    if (!sourceId) {
      return {
        status: "done",
        options: [],
        reason: `Filter "${control.id}" declares no sourceId and no config.options, so its domain is unknown.`,
      };
    }
    const cacheKey = `${control.id}|${field}`;
    const cached = this.#options.get(cacheKey);
    if (cached)
      return cached.status === "loading"
        ? { status: "loading" }
        : { status: "done", options: cached.options, ...(cached.reason ? { reason: cached.reason } : {}) };
    const loader = this.#dataLoader;
    if (!loader) {
      return {
        status: "done",
        options: [],
        reason: `Filter "${control.id}" needs config.options — this canvas has no feature loader to derive them from.`,
      };
    }
    this.#options.set(cacheKey, { status: "loading" });
    void loader(sourceId)
      .then((result) => {
        if (!this.isConnected) return;
        if (!result.ok) {
          this.#options.set(cacheKey, { status: "done", options: [], reason: result.reason });
        } else {
          const values = new Set<string>();
          for (const row of result.rows) {
            const value = row.properties[field];
            if (typeof value === "string" || typeof value === "number") values.add(String(value));
          }
          this.#options.set(cacheKey, {
            status: "done",
            options: [...values].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
            ...(result.truncated
              ? { reason: "Options derived from a bounded page of features — a value beyond it will not be listed." }
              : {}),
          });
        }
        this.render();
      })
      .catch((error: unknown) => {
        if (!this.isConnected) return;
        this.#options.set(cacheKey, {
          status: "done",
          options: [],
          reason: error instanceof Error ? error.message : String(error),
        });
        this.render();
      });
    return { status: "loading" };
  }

  // -------------------------------------------------------------------------
  // Delegated interaction
  // -------------------------------------------------------------------------

  #onClick(event: Event): void {
    const target = actionElement(event, [
      "zoom-in",
      "zoom-out",
      "reset-north",
      "fullscreen",
      "geolocate",
      "basemap",
      "bookmark",
      "measure-toggle",
      "measure-clear",
    ]);
    if (!target) return;
    const controlId = target.dataset.controlId ?? "";
    switch (target.dataset.action) {
      case "zoom-in":
        this.#map?.nudge({ zoomBy: 1 });
        return;
      case "zoom-out":
        this.#map?.nudge({ zoomBy: -1 });
        return;
      case "reset-north":
        this.#map?.nudge({ bearing: 0 });
        return;
      case "fullscreen":
        this.#toggleFullscreen();
        return;
      case "geolocate":
        this.#geolocate(controlId);
        return;
      case "basemap":
        this.#switchBasemap(controlId, target.dataset.baseId);
        return;
      case "bookmark":
        this.#applyBookmark(controlId, target.dataset.bookmarkId);
        return;
      case "measure-toggle": {
        const state = this.#measure.get(controlId) ?? EMPTY_MEASURE;
        this.#measure.set(controlId, { active: !state.active, points: state.points });
        this.render();
        return;
      }
      case "measure-clear":
        this.#measure.set(controlId, { active: this.#measure.get(controlId)?.active ?? false, points: [] });
        this.render();
    }
  }

  #onChange(event: Event): void {
    const target = actionElement(event, [
      "opacity",
      "filter-select",
      "filter-slider",
      "date-from",
      "date-to",
      "time-slider",
    ]);
    if (!target) return;
    const controlId = target.dataset.controlId;
    const runtime = this.#interactions;
    const control = this.#composition?.state.controls.find((entry) => entry.id === controlId);
    if (!controlId || !runtime || !control) return;
    const input = target as HTMLInputElement | HTMLSelectElement;

    switch (target.dataset.action) {
      case "opacity": {
        const value = Number(input.value);
        if (!Number.isFinite(value)) return;
        runtime.publishOpacity(controlId, value);
        this.#announce(control, value);
        return;
      }
      case "filter-select": {
        const field = fieldOf(control);
        if (!field) return;
        const value = input.value;
        runtime.publishControlChange(controlId, value === "" ? undefined : { field, operator: "=", value });
        this.#announce(control, value === "" ? undefined : value);
        return;
      }
      case "filter-slider": {
        const field = fieldOf(control);
        const value = Number(input.value);
        if (!field || !Number.isFinite(value)) return;
        const operator = operatorOf(control);
        runtime.publishControlChange(controlId, { field, operator, value });
        this.#announce(control, value);
        return;
      }
      case "date-from":
      case "date-to": {
        const field = fieldOf(control);
        if (!field) return;
        const root = this.shadowRoot;
        const from = root?.querySelector<HTMLInputElement>(`#from-${cssId(controlId)}`)?.value ?? "";
        const to = root?.querySelector<HTMLInputElement>(`#to-${cssId(controlId)}`)?.value ?? "";
        if (!from && !to) {
          runtime.publishControlChange(controlId, undefined);
          this.#announce(control, undefined);
          return;
        }
        // A half-open range is a legitimate thing to ask for, and `between`
        // cannot express it — so an open end becomes the matching one-sided
        // comparison rather than being silently completed with an invented bound.
        const clause =
          from && to
            ? { field, operator: "between" as const, value: [from, to] }
            : from
              ? { field, operator: ">=" as const, value: from }
              : { field, operator: "<=" as const, value: to };
        runtime.publishControlChange(controlId, clause);
        this.#announce(control, clause.value);
        return;
      }
      case "time-slider": {
        const field = fieldOf(control);
        const start = Number(target.dataset.start);
        const stepDays = Number(target.dataset.stepDays);
        const index = Number(input.value);
        if (!field || !Number.isFinite(start) || !Number.isFinite(index)) return;
        const iso = new Date(start + index * (stepDays || 1) * 86_400_000).toISOString().slice(0, 10);
        runtime.publishControlChange(controlId, { field, operator: "<=", value: iso });
        this.#announce(control, iso);
      }
    }
  }

  /**
   * The DOM-side announcement of the same gesture — for a host that wants to
   * observe controls without reaching into the exploration context. It is a
   * NOTIFICATION, not the transport: the authoritative publish already
   * happened through {@link StudioInteractionRuntime}, so nothing downstream
   * depends on anyone listening to this.
   */
  #announce(control: CompositionControl, value: unknown): void {
    this.dispatchTypedEvent<HonuaStudioControlChangeDetail>("honua-studio-control-change", {
      controlId: control.id,
      kind: control.kind,
      source: "adapter",
      value,
    });
  }

  #toggleFullscreen(): void {
    const container = this.#map?.container();
    if (typeof document === "undefined") return;
    void (document.fullscreenElement ? document.exitFullscreen?.() : container?.requestFullscreen?.())
      ?.then(() => this.render())
      .catch(() => {
        this.#commandError = "The browser refused the fullscreen request.";
        this.render();
      });
  }

  #geolocate(controlId: string): void {
    const control = this.#composition?.state.controls.find((entry) => entry.id === controlId);
    if (!control || typeof navigator === "undefined") return;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        // A located camera is a composed view: it goes through the reducer so
        // it lands in history and draft sync like every other view change.
        this.#applyIntrinsic({
          name: "setView",
          view: {
            center: [position.coords.longitude, position.coords.latitude],
            zoom: readZoom(control) ?? 13,
          },
        });
      },
      () => {
        this.#commandError = "Location is unavailable or was denied.";
        this.render();
      },
    );
  }

  #switchBasemap(controlId: string, baseId: string | undefined): void {
    const controller = this.#composition;
    const control = controller?.state.controls.find((entry) => entry.id === controlId);
    if (!controller || !control || !baseId) return;
    const normalized = describeControl(controller.state, control);
    if (normalized.state !== "rendered" || normalized.config.kind !== "basemapSwitcher") return;
    const base = normalized.config.config.bases.find((entry) => entry.id === baseId);
    if (!base) return;
    // Before the first switch the shown base is the first option, not
    // "nothing" — reporting `previousValue: undefined` there would be a lie.
    const previousValue = this.#basemapChoice.get(controlId) ?? normalized.config.config.bases[0]?.id;
    this.#basemapChoice.set(controlId, base.id);
    this.#map?.setBasemap(base);
    this.render();
    // Detail shape borrowed from the SDK kit's `HonuaBasemapSwitcherChangeDetail`.
    this.dispatchTypedEvent<HonuaStudioControlChangeDetail>("honua-studio-control-change", {
      controlId,
      kind: "basemapSwitcher",
      source: "adapter",
      value: { value: base.id, kind: base.kind, ...(previousValue ? { previousValue } : {}) },
    });
  }

  #applyBookmark(controlId: string, bookmarkId: string | undefined): void {
    const control = this.#composition?.state.controls.find((entry) => entry.id === controlId);
    if (!control || !bookmarkId || !this.#composition) return;
    const normalized = describeControl(this.#composition.state, control);
    if (normalized.state !== "rendered" || normalized.config.kind !== "bookmarks") return;
    const bookmark = normalized.config.config.bookmarks.find((entry) => entry.id === bookmarkId);
    if (!bookmark) return;
    this.#applyIntrinsic({ name: "setView", view: { ...bookmark.view } });
  }

  /** Runs an intrinsic mutation through the reducer — the same discipline honua-studio#24's TOC toggle established. */
  #applyIntrinsic(command: unknown): void {
    const controller = this.#composition;
    if (!controller) return;
    this.#commandError = undefined;
    try {
      controller.apply(command);
    } catch (error) {
      this.#commandError = error instanceof Error ? error.message : String(error);
      this.render();
    }
  }
}

function mapUnavailable(label: string): string {
  return `${label} needs a live map — this canvas has not started one (no WebGL, or the map is still loading).`;
}

function noRuntime(label: string): string {
  return `${label} emits change, but no interaction runtime is attached to publish it to.`;
}

/** The attribute a filter control filters on, read back off the authored config. */
function fieldOf(control: CompositionControl): string | undefined {
  const config = control.config as Record<string, unknown> | undefined;
  for (const name of ["field", "attribute", "property", "dateField", "timeField"]) {
    const value = config?.[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function operatorOf(control: CompositionControl): ">=" | "<=" | "=" {
  const raw = (control.config as { operator?: unknown } | undefined)?.operator;
  return raw === "<=" || raw === "=" ? raw : ">=";
}

function readZoom(control: CompositionControl): number | undefined {
  const value = (control.config as { zoom?: unknown } | undefined)?.zoom;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Ids are agent-authored, so they reach `querySelector` escaped. */
function cssId(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/[^\w-]/g, "\\$&");
}

/** Walks up from the event target to the nearest element carrying one of `actions`, staying inside this shadow root. */
function actionElement(event: Event, actions: readonly string[]): HTMLElement | undefined {
  for (const node of event.composedPath()) {
    if (!(node instanceof HTMLElement)) continue;
    const action = node.dataset.action;
    if (action && actions.includes(action)) return node;
  }
  return undefined;
}

/** Kept local, exactly as the canvas and the deck do — this file must not depend on another element's internals. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export type { CompositionTarget };
