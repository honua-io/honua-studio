/**
 * `<honua-studio-widget-deck>` — the chrome the agent composes around the map
 * (honua-studio#24).
 *
 * honua-studio#8 put `table | chart | compare | time | legend` in the
 * composition model and #23 put a real map on the canvas, but nothing ever
 * *drew* a widget: they existed as rows in the text readout. This element is
 * that missing surface, plus the one kind the vocabulary was missing
 * entirely — `toc`, the layer list (REQ-002).
 *
 * ## How it binds to state
 *
 * It subscribes to one {@link CompositionController} and re-renders from
 * `controller.state`. That single subscription is the whole of REQ-002:
 * a TOC does not hold a layer list, it *reads* `state.layers`, so a layer
 * added by a tool call five turns later appears in it with no re-authoring
 * and no binding to maintain. The same is true of the legend, the compare
 * switch, and the time stepper — every one of them is a projection of
 * composition state, never a copy of it.
 *
 * ## Intrinsic interactions (REQ-003)
 *
 * A TOC's visibility checkboxes, the compare switch, and the time stepper are
 * **intrinsic to the widget kind**. An agent writes
 * `addWidget({ kind: "toc" })` and gets working toggles; it never writes
 * chrome boilerplate wiring a checkbox to a layer. They are not, however, a
 * side door: every one of them is a `setVisibility` **command**, and it
 * travels the route the host gives it through {@link commandDispatch} — in
 * the composed app, the same `ToolCallOrchestrator` an agent's tool call
 * goes through, which in live mode calls `honua_studio_set_layer_visibility`
 * and re-reads the returned draft (honua-studio#31). So an intrinsic toggle
 * and an agent's authored `setVisibility` are the same write path, with the
 * same validation, the same pin enforcement, the same generation threading,
 * and the same activity-log entry. That is not a tidiness argument: `visible`
 * IS part of the server's `StudioCompositionLayer`, so a toggle that only
 * mutated client state was silently reverted by the next draft sync.
 *
 * Unset (a standalone deck, or fixture/offline mode) the command applies
 * through this deck's own controller — the same reducer, one hop earlier.
 * A pinned layer's toggle is disabled rather than allowed to fail
 * (#1 REQ-003: pinned elements the agent must not alter).
 *
 * ## Selection (REQ-005)
 *
 * A grid row resolves to `{ kind: "feature", sourceId, featureId }` — the
 * same deictic target a map click produces (#23) — and is handed to the host
 * through {@link onSelection}, which `<honua-studio-canvas>` points at its own
 * `#applySelection`. So a row click, a map click, and a readout row all end in
 * exactly one place: `controller.select(...)` plus one
 * `honua-studio-selection-change` event. Used standalone, the deck does both
 * itself.
 *
 * ## Rendering discipline
 *
 * Unlike the canvas — which must never replace its map container — this
 * element holds nothing that cannot survive a repaint, so it re-renders whole
 * through {@link HonuaStudioElementBase.setShadowHtml} (focus- and
 * selection-preserving). Its listeners are **delegated**: three of them, bound
 * once per connection to the shadow root, dispatched by `data-action`. Binding
 * per-node after each repaint — the pattern the readout uses — would
 * accumulate abort registrations for the life of the session.
 *
 * Data-bound kinds (`table`, `chart`) fetch through the {@link dataLoader}
 * seam, so the whole pipeline is exercised in `environment: "node"` against a
 * fake loader, exactly like `mapFactory` does for the map.
 */
import type { CompositionCommand } from "../composition/commands.js";
import type { CompositionController } from "../composition/controller.js";
import type { CompositionLayer, CompositionTarget, CompositionWidget } from "../composition/model.js";
import { compositionLayerColor } from "../composition/palette.js";
import type { CompositionSourceDescriptor } from "../map/source-resolution.js";
import { runtimeServerBaseUrl } from "../runtime-config.js";
import type { chartSeriesFromSpec } from "../widgets/chart-data.js";
import type { renderChartSvg } from "../widgets/chart-render.js";
import type { compositionChartSpec } from "../widgets/chart-spec.js";
import {
  type CompositionCompareConfig,
  type CompositionTimeConfig,
  readCompareConfig,
  readLegendConfig,
  readTableConfig,
  readTimeConfig,
  readTocConfig,
} from "../widgets/widget-config.js";
import {
  type WidgetDataLoader,
  type WidgetDataResult,
  type WidgetFeatureRow,
  createCatalogWidgetDataLoader,
  formatCellValue,
  inferColumns,
} from "../widgets/widget-data.js";
import { HonuaStudioElementBase } from "./base-element.js";
import { baseElementStyles, widgetDeckStyles } from "./styles.js";
import type { HonuaStudioCommandDispatch, HonuaStudioSelectionChangeDetail } from "./types.js";

/** One layer the map could not draw, as `<honua-studio-canvas>` reports it. Shown as a TOC flag so the list never claims a layer is on the map when it is not. */
export interface UnrenderableLayerNote {
  readonly layerId: string;
  readonly reason: string;
}

type DeckDataState = { readonly status: "loading" } | { readonly status: "done"; readonly result: WidgetDataResult };

/**
 * The chart pipeline, loaded on demand.
 *
 * Charts are the only widget kind that needs a rendering pipeline —
 * spec conversion (which pulls the SDK's `chart-spec` module), aggregation,
 * and the SVG renderer add ~4 kB gzipped, and a composition with a layer
 * list and a legend should not pay for them. Keeping it dynamic is the same
 * discipline honua-studio#23 applied to MapLibre, at a much smaller scale:
 * the cost is paid by the composition that actually asked for a chart.
 */
interface ChartPipeline {
  readonly compositionChartSpec: typeof compositionChartSpec;
  readonly chartSeriesFromSpec: typeof chartSeriesFromSpec;
  readonly renderChartSvg: typeof renderChartSvg;
}

/** Human labels for the kind badge on each card. */
const KIND_LABELS: Readonly<Record<string, string>> = {
  toc: "Layers",
  table: "Grid",
  chart: "Chart",
  legend: "Legend",
  compare: "Compare",
  time: "Time",
};

export class HonuaStudioWidgetDeckElement extends HonuaStudioElementBase {
  static get observedAttributes(): string[] {
    return ["label"];
  }

  /** Live (connected) instance count — the same leak-detection probe the other Studio elements carry. */
  static instanceCount = 0;

  #composition: CompositionController | undefined;
  #compositionUnsubscribe: (() => void) | undefined;
  #sourceCatalog: readonly CompositionSourceDescriptor[] | undefined;
  #sourceBaseUrl = runtimeServerBaseUrl();
  #dataLoader: WidgetDataLoader | undefined;
  #defaultLoader: WidgetDataLoader | undefined;
  #onSelection: ((targets: readonly CompositionTarget[]) => void) | undefined;
  #commandDispatch: HonuaStudioCommandDispatch | undefined;
  #unrenderable: readonly UnrenderableLayerNote[] = [];
  #data = new Map<string, DeckDataState>();
  #page = new Map<string, number>();
  #chart: ChartPipeline | undefined;
  #chartPending = false;
  /** Last rejected intrinsic mutation, surfaced on the card rather than swallowed. */
  #commandError: string | undefined;

  /** The composition this deck renders. Assigning re-subscribes; `undefined` empties the deck. */
  public get composition(): CompositionController | undefined {
    return this.#composition;
  }

  public set composition(composition: CompositionController | undefined) {
    if (this.#composition === composition) return;
    this.#compositionUnsubscribe?.();
    this.#compositionUnsubscribe = undefined;
    this.#composition = composition;
    this.#page.clear();
    if (composition && this.isConnected) {
      this.#compositionUnsubscribe = composition.subscribe(() => this.render());
    }
    this.render();
  }

  /** Sources the server advertises — used to resolve a widget's `sourceId` to the route its rows come from. */
  public get sourceCatalog(): readonly CompositionSourceDescriptor[] | undefined {
    return this.#sourceCatalog;
  }

  public set sourceCatalog(catalog: readonly CompositionSourceDescriptor[] | undefined) {
    // Identity-guarded: the canvas re-syncs its deck on every render, and
    // dropping the row cache each time would re-fetch every grid and chart on
    // every streamed tool call.
    if (this.#sourceCatalog === catalog) return;
    this.#sourceCatalog = catalog;
    this.#resetData();
  }

  /** Server root for resolved source URLs. Defaults to `/api`, matching `StudioClient`. */
  public get sourceBaseUrl(): string {
    return this.#sourceBaseUrl;
  }

  public set sourceBaseUrl(baseUrl: string) {
    if (this.#sourceBaseUrl === baseUrl) return;
    this.#sourceBaseUrl = baseUrl;
    this.#resetData();
  }

  /** Replaces the feature loader. The injection seam `../widgets/widget-data.ts` documents; production leaves it unset. */
  public get dataLoader(): WidgetDataLoader | undefined {
    return this.#dataLoader;
  }

  public set dataLoader(loader: WidgetDataLoader | undefined) {
    if (this.#dataLoader === loader) return;
    this.#dataLoader = loader;
    this.#resetData();
  }

  /** Layers the map reported as unrenderable, so the TOC can flag them instead of implying they are drawn. */
  public get unrenderableLayers(): readonly UnrenderableLayerNote[] {
    return this.#unrenderable;
  }

  public set unrenderableLayers(notes: readonly UnrenderableLayerNote[]) {
    const key = (list: readonly UnrenderableLayerNote[]): string => list.map((note) => note.layerId).join("|");
    if (key(notes) === key(this.#unrenderable)) return;
    this.#unrenderable = notes;
    this.render();
  }

  /**
   * Where a selection goes. `<honua-studio-canvas>` sets this to its own
   * dispatcher so the composed app has exactly one selection path; left
   * unset (a standalone deck), the element selects and dispatches itself.
   */
  public get onSelection(): ((targets: readonly CompositionTarget[]) => void) | undefined {
    return this.#onSelection;
  }

  public set onSelection(handler: ((targets: readonly CompositionTarget[]) => void) | undefined) {
    this.#onSelection = handler;
  }

  /**
   * Where an intrinsic mutation goes — see {@link HonuaStudioCommandDispatch}.
   * `<honua-studio-canvas>` sets this so a TOC toggle travels the same route
   * an agent's `setVisibility` travels and reaches
   * `honua_studio_set_layer_visibility` in live mode (honua-studio#31). Left
   * unset (a standalone deck), the element applies through its own
   * controller.
   */
  public get commandDispatch(): HonuaStudioCommandDispatch | undefined {
    return this.#commandDispatch;
  }

  public set commandDispatch(dispatch: HonuaStudioCommandDispatch | undefined) {
    this.#commandDispatch = dispatch;
  }

  public attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (!this.isConnected || oldValue === newValue || name !== "label") return;
    this.render();
  }

  protected onConnect(): void {
    HonuaStudioWidgetDeckElement.instanceCount += 1;
    if (this.#composition && !this.#compositionUnsubscribe) {
      this.#compositionUnsubscribe = this.#composition.subscribe(() => this.render());
    }
    // Delegated once per connection — see the class doc's rendering note.
    const root = this.ensureShadowRoot();
    this.listen(root, "click", (event) => this.#onClick(event));
    this.listen(root, "change", (event) => this.#onChange(event));
    this.listen(root, "keydown", (event) => this.#onKeydown(event));
  }

  protected onDisconnect(): void {
    HonuaStudioWidgetDeckElement.instanceCount -= 1;
    this.#compositionUnsubscribe?.();
    this.#compositionUnsubscribe = undefined;
  }

  protected render(): void {
    const controller = this.#composition;
    const widgets = controller?.state.widgets ?? [];
    // An empty deck takes no space rather than leaving an empty box under the
    // map; the host's layout should not have to know whether widgets exist.
    if (widgets.length === 0) this.dataset.empty = "true";
    else delete this.dataset.empty;

    const label = this.getAttribute("label") ?? "Widgets";
    const cards = controller ? widgets.map((widget) => this.#renderWidget(controller, widget)).join("") : "";
    this.setShadowHtml(`
      <style>${baseElementStyles()}${widgetDeckStyles()}</style>
      <section class="widget-deck" part="deck" aria-label="${escapeHtml(label)}" data-testid="studio-widget-deck">
        ${cards}
      </section>
    `);
  }

  // -------------------------------------------------------------------------
  // Per-kind rendering
  // -------------------------------------------------------------------------

  #renderWidget(controller: CompositionController, widget: CompositionWidget): string {
    const body = this.#renderWidgetBody(controller, widget);
    const pinned = controller.state.pins.some((pin) => pin.kind === "component" && pin.id === widget.id);
    return `
      <article
        class="widget"
        data-testid="studio-widget"
        data-widget-id="${escapeHtml(widget.id)}"
        data-widget-kind="${escapeHtml(widget.kind)}"
        aria-label="${escapeHtml(widget.title ?? widget.id)}"
      >
        <header class="widget-head">
          <h4 class="widget-title" data-testid="studio-widget-title">${escapeHtml(widget.title ?? widget.id)}${
            pinned ? ' <span aria-label="pinned">📌</span>' : ""
          }</h4>
          <span class="hn-badge widget-kind">${escapeHtml(KIND_LABELS[widget.kind] ?? widget.kind)}</span>
        </header>
        <div class="widget-body">${body.html}</div>
        ${
          body.status
            ? `<p class="widget-status hn-muted" data-testid="studio-widget-status" role="status">${escapeHtml(body.status)}</p>`
            : ""
        }
      </article>
    `;
  }

  #renderWidgetBody(controller: CompositionController, widget: CompositionWidget): { html: string; status?: string } {
    switch (widget.kind) {
      case "toc":
        return this.#renderToc(controller, widget);
      case "legend":
        return this.#renderLegend(controller, widget);
      case "compare":
        return this.#renderCompare(controller, widget);
      case "time":
        return this.#renderTime(controller, widget);
      case "table":
        return this.#renderTable(controller, widget);
      case "chart":
        return this.#renderChart(widget);
      default:
        // Unreachable while the union is exhaustive; kept so a kind added to
        // the vocabulary without a renderer is reported, not blank.
        return { html: "", status: `No renderer for widget kind "${String(widget.kind)}" yet.` };
    }
  }

  /** REQ-002/REQ-003: the layer list, read live off `state.layers`, with intrinsic visibility toggles. */
  #renderToc(controller: CompositionController, widget: CompositionWidget): { html: string; status?: string } {
    const normalized = readTocConfig(widget);
    if (!normalized.ok) return { html: "", status: normalized.reason };
    const state = controller.state;
    const unrenderable = new Map(this.#unrenderable.map((note) => [note.layerId, note.reason] as const));
    const selection = new Set(controller.selection.map(targetKey));
    const layers = normalized.config.layerIds.length
      ? normalized.config.layerIds
          .map((id) => state.layers.find((layer) => layer.id === id))
          .filter((layer): layer is CompositionLayer => layer !== undefined)
      : state.layers;
    const visible = normalized.config.showUnrenderable ? layers : layers.filter((layer) => !unrenderable.has(layer.id));

    if (visible.length === 0) {
      return {
        html: `<p class="widget-empty hn-muted" data-testid="studio-widget-toc-empty">No layers yet — this list fills in as layers are added.</p>`,
      };
    }

    const rows = visible
      .map((layer) => {
        const pinned = state.pins.some((pin) => pin.kind === "layer" && pin.id === layer.id);
        const reason = unrenderable.get(layer.id);
        const selected = selection.has(`layer:${layer.id}`);
        const title = layer.title ?? layer.id;
        const controlId = `toc-${widget.id}--${layer.id}`;
        return `
          <li class="widget-toc-row" data-testid="studio-widget-toc-row" data-layer-id="${escapeHtml(layer.id)}" data-visible="${layer.visible}">
            <input
              type="checkbox"
              id="${escapeHtml(controlId)}"
              class="widget-toc-toggle"
              data-testid="studio-widget-toc-toggle"
              data-action="toggle-visibility"
              data-layer-id="${escapeHtml(layer.id)}"
              ${layer.visible ? "checked" : ""}
              ${pinned ? 'disabled title="This layer is pinned — unpin it to change its visibility."' : ""}
              aria-label="Show ${escapeHtml(title)}"
            />
            <button
              type="button"
              class="widget-toc-label"
              data-action="select-layer"
              data-layer-id="${escapeHtml(layer.id)}"
              aria-pressed="${selected}"
            >
              <span class="widget-swatch" style="background:${escapeHtml(compositionLayerColor(layer))}" aria-hidden="true"></span>
              <span class="widget-toc-name">${escapeHtml(title)}${pinned ? ' <span aria-label="pinned">📌</span>' : ""}</span>
              ${
                reason
                  ? `<span class="widget-flag" data-testid="studio-widget-toc-unrendered" title="${escapeHtml(reason)}">not on map</span>`
                  : ""
              }
            </button>
          </li>
        `;
      })
      .join("");

    return {
      html: `<ul class="widget-toc" data-testid="studio-widget-toc">${rows}</ul>`,
      ...(this.#commandError ? { status: this.#commandError } : {}),
    };
  }

  /** The map's own key: one swatch per layer, in the colour the map paints it. */
  #renderLegend(controller: CompositionController, widget: CompositionWidget): { html: string; status?: string } {
    const normalized = readLegendConfig(widget);
    if (!normalized.ok) return { html: "", status: normalized.reason };
    const state = controller.state;
    const scoped = normalized.config.layerIds.length
      ? normalized.config.layerIds
          .map((id) => state.layers.find((layer) => layer.id === id))
          .filter((layer): layer is CompositionLayer => layer !== undefined)
      : state.layers;
    const layers = normalized.config.includeHidden ? scoped : scoped.filter((layer) => layer.visible);
    if (layers.length === 0) {
      return { html: `<p class="widget-empty hn-muted">Nothing to key yet.</p>` };
    }
    const items = layers
      .map(
        (layer) => `
          <li class="widget-legend-item" data-testid="studio-widget-legend-item" data-hidden="${!layer.visible}">
            <span class="widget-swatch" style="background:${escapeHtml(compositionLayerColor(layer))}" aria-hidden="true"></span>
            <span>${escapeHtml(layer.title ?? layer.id)}</span>
            ${layer.styleRef ? `<span class="hn-muted widget-legend-style">${escapeHtml(layer.styleRef.styleId)}</span>` : ""}
          </li>
        `,
      )
      .join("");
    return { html: `<ul class="widget-legend" data-testid="studio-widget-legend">${items}</ul>` };
  }

  /** A/both/B over two layers — a comparison expressed in the only vocabulary composition has for it: visibility. */
  #renderCompare(controller: CompositionController, widget: CompositionWidget): { html: string; status?: string } {
    const normalized = readCompareConfig(widget);
    if (!normalized.ok) return { html: "", status: normalized.reason };
    const config = normalized.config;
    const left = controller.state.layers.find((layer) => layer.id === config.left);
    const right = controller.state.layers.find((layer) => layer.id === config.right);
    if (!left || !right) {
      const missing = [!left ? config.left : undefined, !right ? config.right : undefined].filter(Boolean).join(", ");
      return { html: "", status: `Compare "${widget.id}" references layers not in the composition: ${missing}.` };
    }
    const mode = compareMode(left.visible, right.visible);
    const option = (value: "left" | "both" | "right", label: string): string => `
      <button
        type="button"
        class="hn-btn hn-btn--sm widget-compare-option"
        data-testid="studio-widget-compare-option"
        data-action="compare"
        data-widget-id="${escapeHtml(widget.id)}"
        data-mode="${value}"
        aria-pressed="${mode === value}"
      >${escapeHtml(label)}</button>
    `;
    return {
      html: `
        <div class="widget-compare" role="group" aria-label="Compare layers" data-testid="studio-widget-compare" data-mode="${mode}">
          ${option("left", config.leftLabel ?? left.title ?? left.id)}
          ${option("both", "Both")}
          ${option("right", config.rightLabel ?? right.title ?? right.id)}
        </div>
      `,
      ...(this.#commandError ? { status: this.#commandError } : {}),
    };
  }

  /** A stepper over a layer stack. See `readTimeConfig` for why it is layers, not a field filter. */
  #renderTime(controller: CompositionController, widget: CompositionWidget): { html: string; status?: string } {
    const normalized = readTimeConfig(widget);
    if (!normalized.ok) return { html: "", status: normalized.reason };
    const config = normalized.config;
    const known = config.steps.filter((step) => controller.state.layers.some((layer) => layer.id === step.layerId));
    if (known.length === 0) {
      return { html: "", status: `Time "${widget.id}" steps through layers that are not in the composition yet.` };
    }
    const index = currentTimeIndex(controller, config);
    const current = known[index] ?? known[0];
    return {
      html: `
        <div class="widget-time" data-testid="studio-widget-time">
          <input
            type="range"
            class="widget-time-slider"
            data-testid="studio-widget-time-slider"
            data-action="time-step"
            data-widget-id="${escapeHtml(widget.id)}"
            id="time-${escapeHtml(widget.id)}"
            min="0"
            max="${known.length - 1}"
            step="1"
            value="${index}"
            aria-label="Time step"
            aria-valuetext="${escapeHtml(current?.label ?? "")}"
          />
          <output class="widget-time-label" data-testid="studio-widget-time-label">${escapeHtml(current?.label ?? "")}</output>
        </div>
      `,
      ...(this.#commandError ? { status: this.#commandError } : {}),
    };
  }

  /** REQ-005: the data grid. Rows are selectable, and a selection is a `feature` deictic target. */
  #renderTable(controller: CompositionController, widget: CompositionWidget): { html: string; status?: string } {
    const normalized = readTableConfig(widget);
    if (!normalized.ok) return { html: "", status: normalized.reason };
    const sourceId = widget.sourceId;
    if (!sourceId) return { html: "", status: `Grid "${widget.id}" has no sourceId to read rows from.` };
    const data = this.#requireData(sourceId);
    if (data.status === "loading") return { html: "", status: `Loading ${sourceId}…` };
    if (!data.result.ok) return { html: "", status: data.result.reason };

    const config = normalized.config;
    const rows = data.result.rows;
    if (rows.length === 0) return { html: "", status: `${sourceId} returned no features.` };
    const columns = config.fields.length > 0 ? config.fields : inferColumns(rows);
    const pageCount = Math.max(Math.ceil(rows.length / config.pageSize), 1);
    const page = Math.min(this.#page.get(widget.id) ?? 0, pageCount - 1);
    const start = page * config.pageSize;
    const pageRows = rows.slice(start, start + config.pageSize);
    const selection = new Set(controller.selection.map(targetKey));

    const head = columns.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join("");
    const body = pageRows
      .map((row) => {
        const featureId = rowFeatureId(row, config.primaryKey);
        const selected = featureId !== undefined && selection.has(`feature:${sourceId}:${String(featureId)}`);
        const cells = columns
          .map((column) => `<td role="gridcell">${escapeHtml(formatCellValue(row.properties[column]))}</td>`)
          .join("");
        const selectable = featureId !== undefined;
        return `
          <tr
            role="row"
            data-testid="studio-widget-grid-row"
            ${
              selectable
                ? `tabindex="0" data-action="select-feature" data-source-id="${escapeHtml(sourceId)}" data-feature-id="${escapeHtml(String(featureId))}"`
                : 'aria-disabled="true"'
            }
            aria-selected="${selected}"
          >${cells}</tr>
        `;
      })
      .join("");

    const pager =
      pageCount > 1
        ? `
      <nav class="widget-pager" aria-label="Grid pages">
        <button type="button" class="hn-btn hn-btn--sm" data-action="page" data-widget-id="${escapeHtml(widget.id)}" data-page="${page - 1}" data-testid="studio-widget-grid-prev" ${page === 0 ? "disabled" : ""}>Previous</button>
        <span class="hn-muted" data-testid="studio-widget-grid-range">${start + 1}–${start + pageRows.length} of ${rows.length}</span>
        <button type="button" class="hn-btn hn-btn--sm" data-action="page" data-widget-id="${escapeHtml(widget.id)}" data-page="${page + 1}" data-testid="studio-widget-grid-next" ${page >= pageCount - 1 ? "disabled" : ""}>Next</button>
      </nav>`
        : "";

    const truncated = data.result.truncated
      ? `Showing the first ${rows.length}${data.result.total !== undefined ? ` of ${data.result.total}` : ""} features — the request is bounded.`
      : undefined;

    return {
      html: `
        <div class="widget-grid-scroll">
          <table class="widget-grid" role="grid" data-testid="studio-widget-grid">
            <thead><tr>${head}</tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
        ${pager}
      `,
      ...(truncated ? { status: truncated } : {}),
    };
  }

  /** REQ-004: spec from the SDK's converter, series from that spec, SVG from that series. */
  #renderChart(widget: CompositionWidget): { html: string; status?: string } {
    const sourceId = widget.sourceId;
    if (!sourceId) return { html: "", status: `Chart "${widget.id}" has no sourceId to read rows from.` };
    const pipeline = this.#requireChartPipeline();
    const data = this.#requireData(sourceId);
    if (data.status === "loading") return { html: "", status: `Loading ${sourceId}…` };
    if (!data.result.ok) return { html: "", status: data.result.reason };
    if (!pipeline) return { html: "", status: "Preparing the chart…" };

    const spec = pipeline.compositionChartSpec(
      widget,
      data.result.rows.map((row) => row.properties as Record<string, unknown>),
    );
    if (!spec.ok) return { html: "", status: spec.reason };
    const series = pipeline.chartSeriesFromSpec(spec.spec);
    const chart = pipeline.renderChartSvg(spec.spec, series);
    return {
      html: `
        <figure class="widget-chart" data-testid="studio-widget-chart" data-mark="${escapeHtml(markOf(spec.spec))}">
          ${chart.svg}
          <figcaption class="hn-muted" data-testid="studio-widget-chart-summary">${escapeHtml(chart.summary)}</figcaption>
        </figure>
      `,
      ...(series.reason ? { status: series.reason } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  /** Returns the chart pipeline, importing it the first time a chart widget asks — see {@link ChartPipeline}. */
  #requireChartPipeline(): ChartPipeline | undefined {
    if (this.#chart || this.#chartPending) return this.#chart;
    this.#chartPending = true;
    void Promise.all([
      import("../widgets/chart-spec.js"),
      import("../widgets/chart-data.js"),
      import("../widgets/chart-render.js"),
    ])
      .then(([spec, data, render]) => {
        this.#chart = {
          compositionChartSpec: spec.compositionChartSpec,
          chartSeriesFromSpec: data.chartSeriesFromSpec,
          renderChartSvg: render.renderChartSvg,
        };
        if (this.isConnected) this.render();
      })
      .catch(() => {
        // The card keeps its "Preparing the chart…" state rather than the deck
        // failing as a whole — one unloadable chunk must not take the layer
        // list down with it.
        this.#chartPending = false;
      });
    return undefined;
  }

  /** Reads cached rows, kicking off one bounded load the first time a source is asked for. */
  #requireData(sourceId: string): DeckDataState {
    const existing = this.#data.get(sourceId);
    if (existing) return existing;
    const loading: DeckDataState = { status: "loading" };
    this.#data.set(sourceId, loading);
    const loader = this.#resolveLoader();
    void loader(sourceId)
      .then((result) => {
        if (!this.isConnected || this.#data.get(sourceId) !== loading) return;
        this.#data.set(sourceId, { status: "done", result });
        this.render();
      })
      .catch((error: unknown) => {
        if (!this.isConnected || this.#data.get(sourceId) !== loading) return;
        this.#data.set(sourceId, {
          status: "done",
          result: { ok: false, reason: error instanceof Error ? error.message : String(error) },
        });
        this.render();
      });
    return loading;
  }

  #resolveLoader(): WidgetDataLoader {
    if (this.#dataLoader) return this.#dataLoader;
    this.#defaultLoader ??= createCatalogWidgetDataLoader({
      baseUrl: this.#sourceBaseUrl,
      ...(this.#sourceCatalog !== undefined ? { catalog: this.#sourceCatalog } : {}),
    });
    return this.#defaultLoader;
  }

  /** A loader input changed; everything already fetched was fetched against the old one. */
  #resetData(): void {
    this.#data.clear();
    this.#defaultLoader = undefined;
    if (this.isConnected) this.render();
  }

  // -------------------------------------------------------------------------
  // Delegated interaction
  // -------------------------------------------------------------------------

  #onClick(event: Event): void {
    const target = actionElement(event, ["select-layer", "select-feature", "compare", "page"]);
    if (!target) return;
    switch (target.dataset.action) {
      case "select-layer":
        if (target.dataset.layerId) this.#select([{ kind: "layer", id: target.dataset.layerId }]);
        return;
      case "select-feature":
        this.#selectFeatureRow(target);
        return;
      case "compare":
        this.#applyCompare(target.dataset.widgetId, target.dataset.mode);
        return;
      case "page": {
        const widgetId = target.dataset.widgetId;
        const page = Number(target.dataset.page);
        if (!widgetId || !Number.isFinite(page)) return;
        this.#page.set(widgetId, Math.max(page, 0));
        this.render();
      }
    }
  }

  #onChange(event: Event): void {
    const target = actionElement(event, ["toggle-visibility", "time-step"]);
    if (!target) return;
    if (target.dataset.action === "toggle-visibility") {
      const layerId = target.dataset.layerId;
      if (!layerId) return;
      this.#applyIntrinsic({
        name: "setVisibility",
        target: { kind: "layer", id: layerId },
        visible: (target as HTMLInputElement).checked,
      });
      return;
    }
    this.#applyTimeStep(target.dataset.widgetId, Number((target as HTMLInputElement).value));
  }

  /** Grid rows are focusable `role="row"` elements, so Enter/Space must select them the way a click does. */
  #onKeydown(event: Event): void {
    if (!(event instanceof KeyboardEvent) || (event.key !== "Enter" && event.key !== " ")) return;
    const target = actionElement(event, ["select-feature"]);
    if (!target) return;
    event.preventDefault();
    this.#selectFeatureRow(target);
  }

  #selectFeatureRow(target: HTMLElement): void {
    const sourceId = target.dataset.sourceId;
    const rawId = target.dataset.featureId;
    if (!sourceId || rawId === undefined) return;
    // A numeric feature id must stay numeric: `{ featureId: 1 }` and
    // `{ featureId: "1" }` are different deictic targets, and the map's own
    // click path produces the numeric one.
    const featureId = /^-?\d+$/.test(rawId) ? Number(rawId) : rawId;
    this.#select([{ kind: "feature", sourceId, featureId }]);
  }

  /** The one selection path — see the class doc (REQ-005). */
  #select(targets: readonly CompositionTarget[]): void {
    if (this.#onSelection) {
      this.#onSelection(targets);
      return;
    }
    this.#composition?.select(targets);
    this.dispatchTypedEvent<HonuaStudioSelectionChangeDetail>("honua-studio-selection-change", {
      targets: [...targets],
    });
  }

  #applyCompare(widgetId: string | undefined, mode: string | undefined): void {
    const controller = this.#composition;
    const widget = controller?.state.widgets.find((entry) => entry.id === widgetId);
    if (!controller || !widget) return;
    const normalized = readCompareConfig(widget);
    if (!normalized.ok) return;
    const { left, right } = normalized.config;
    this.#applyIntrinsic(
      { name: "setVisibility", target: { kind: "layer", id: left }, visible: mode !== "right" },
      { name: "setVisibility", target: { kind: "layer", id: right }, visible: mode !== "left" },
    );
  }

  #applyTimeStep(widgetId: string | undefined, index: number): void {
    const controller = this.#composition;
    const widget = controller?.state.widgets.find((entry) => entry.id === widgetId);
    if (!controller || !widget || !Number.isFinite(index)) return;
    const normalized = readTimeConfig(widget);
    if (!normalized.ok) return;
    const steps = normalized.config.steps.filter((step) =>
      controller.state.layers.some((layer) => layer.id === step.layerId),
    );
    const selected = steps[Math.max(Math.min(Math.trunc(index), steps.length - 1), 0)];
    if (!selected) return;
    this.#applyIntrinsic(
      ...steps.map(
        (step) =>
          ({
            name: "setVisibility",
            target: { kind: "layer", id: step.layerId },
            visible: step.layerId === selected.layerId,
          }) as const,
      ),
    );
  }

  /**
   * Runs an intrinsic mutation. When a {@link commandDispatch} is wired the
   * command goes there — the same route an agent's command takes, so in live
   * mode it round-trips through `honua_studio_set_layer_visibility` rather
   * than mutating state the next draft sync would overwrite
   * (honua-studio#31). Without one, it applies through this deck's own
   * controller, which is what fixture/offline mode does anyway.
   *
   * Either way the deck re-renders from whatever state the write actually
   * settled on, so a refused toggle snaps back rather than leaving the
   * checkbox lying — a native checkbox flips itself on the gesture, and only
   * a repaint from real state can put it back. Every rejection — a pin
   * violation above all, or a server `failed_precondition` the orchestrator
   * could not recover from — becomes a message on the card instead of an
   * unhandled rejection.
   */
  #applyIntrinsic(...commands: readonly CompositionCommand[]): void {
    const controller = this.#composition;
    const dispatch = this.#commandDispatch;
    if (!controller && !dispatch) return;
    this.#commandError = undefined;

    if (dispatch) {
      // The round trip is asynchronous, so the repaint has to be too: the
      // checkbox is already showing the user's intent, and composition state
      // does not carry it until the server (or the reducer) says so.
      void dispatch(commands).then(
        (outcome) => {
          if (outcome.ok) return;
          this.#commandError = outcome.reason ?? "The composition refused that change.";
          this.render();
        },
        (error: unknown) => {
          this.#commandError = error instanceof Error ? error.message : String(error);
          this.render();
        },
      );
      return;
    }

    try {
      for (const command of commands) (controller as CompositionController).apply(command);
    } catch (error) {
      this.#commandError = error instanceof Error ? error.message : String(error);
      this.render();
    }
  }
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

function markOf(spec: { readonly mark: string | { readonly type: string } }): string {
  return typeof spec.mark === "string" ? spec.mark : spec.mark.type;
}

function targetKey(target: CompositionTarget): string {
  return target.kind === "feature"
    ? `feature:${target.sourceId}:${String(target.featureId)}`
    : `${target.kind}:${target.id}`;
}

/** The feature id a grid row selects by: the feature's own id, else the configured primary-key property. */
function rowFeatureId(row: WidgetFeatureRow, primaryKey: string | undefined): string | number | undefined {
  if (row.featureId !== undefined) return row.featureId;
  if (!primaryKey) return undefined;
  const value = row.properties[primaryKey];
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function compareMode(leftVisible: boolean, rightVisible: boolean): "left" | "right" | "both" | "none" {
  if (leftVisible && rightVisible) return "both";
  if (leftVisible) return "left";
  if (rightVisible) return "right";
  return "none";
}

/** Which step the composition is currently on: the first step whose layer is the visible one. */
function currentTimeIndex(controller: CompositionController, config: CompositionTimeConfig): number {
  const steps = config.steps.filter((step) => controller.state.layers.some((layer) => layer.id === step.layerId));
  const index = steps.findIndex((step) =>
    controller.state.layers.some((layer) => layer.id === step.layerId && layer.visible),
  );
  return index === -1 ? 0 : index;
}

/** Kept local, exactly as `studio-canvas-element.ts` does — this file must not depend on another element's internals. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export type { CompositionCompareConfig };
