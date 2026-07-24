/**
 * `<honua-studio-canvas>` — the composition canvas surface (honua-studio#5
 * scaffolded a placeholder; honua-studio#8 realizes it here). Phase 1 scope
 * (honua-studio#8 build item 6): a structured readout of a
 * {@link CompositionState} — layers, view, widgets, pins — driven by a
 * {@link CompositionController}, NOT a map renderer (see #8's own scope
 * note: real map rendering is later work). Rows are clickable and emit
 * `honua-studio-selection-change` with the row's {@link CompositionTarget}
 * — the deictic reference the chat console (honua-studio#6) attaches to a
 * follow-up prompt as a "THIS" chip (REQ-012).
 *
 * Still honors honua-studio#5's original scope: the `ResizeObserver`
 * leak-detection probe (`instanceCount`) and cleanup discipline are
 * unchanged — see that issue's doc comment on the class, preserved below.
 */
import type { CompositionController } from "../composition/controller.js";
import type {
  CompositionAnnotation,
  CompositionLayer,
  CompositionTarget,
  CompositionWidget,
} from "../composition/model.js";
import { HonuaStudioElementBase } from "./base-element.js";
import { resolveInjectedAuth } from "./session.js";
import { baseElementStyles, canvasStyles } from "./styles.js";
import type { AuthSession, HonuaStudioCanvasResizeDetail, HonuaStudioSelectionChangeDetail } from "./types.js";

export class HonuaStudioCanvasElement extends HonuaStudioElementBase {
  static get observedAttributes(): string[] {
    return ["label"];
  }

  /** Live (connected) instance count — a leak-detection probe, not part of the public contract proper. See the class doc and test/elements/cleanup.test.ts. */
  static instanceCount = 0;

  #auth: AuthSession | undefined;
  #resizeObserver: ResizeObserver | undefined;
  #composition: CompositionController | undefined;
  #compositionUnsubscribe: (() => void) | undefined;

  /** Direct `AuthSession` override — falls back to the nearest `<honua-studio-app>` ancestor's `.auth` when unset. See docs/embed-session.md. */
  public get auth(): AuthSession | undefined {
    return this.#auth;
  }

  public set auth(auth: AuthSession | undefined) {
    this.#auth = auth;
    this.render();
  }

  /** The composition engine controller (honua-studio#8) this canvas renders a readout of. `undefined` renders the honua-studio#5 placeholder. */
  public get composition(): CompositionController | undefined {
    return this.#composition;
  }

  public set composition(composition: CompositionController | undefined) {
    if (this.#composition === composition) return;
    this.#compositionUnsubscribe?.();
    this.#compositionUnsubscribe = undefined;
    this.#composition = composition;
    if (composition && this.isConnected) {
      this.#compositionUnsubscribe = composition.subscribe(() => this.render());
    }
    this.render();
  }

  public attributeChangedCallback(): void {
    if (!this.isConnected) return;
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
      this.#compositionUnsubscribe = this.#composition.subscribe(() => this.render());
    }
    if (typeof ResizeObserver !== "undefined") {
      this.#resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
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
  }

  protected render(): void {
    const label = this.getAttribute("label") ?? "Canvas";
    const body = this.#composition ? this.#renderReadout(this.#composition) : this.#renderPlaceholder();
    this.setShadowHtml(`
      <style>${baseElementStyles()}${canvasStyles()}</style>
      <section class="canvas hn-panel" part="panel" aria-label="${escapeHtml(label)}" data-testid="studio-canvas">
        <h2 class="hn-panel-title">${escapeHtml(label)}</h2>
        ${body}
      </section>
    `);
    this.#bindRowListeners();
  }

  #renderPlaceholder(): string {
    return `
      <div class="canvas-surface" data-testid="studio-canvas-surface" tabindex="0">
        <span>Composition canvas placeholder — honua-studio#8.</span>
      </div>
    `;
  }

  #renderReadout(controller: CompositionController): string {
    const state = controller.state;
    const selectionKeys = new Set(controller.selection.map(targetKey));
    return `
      <div class="composition-readout" data-testid="studio-canvas-readout">
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
      </div>
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
          const target = { kind, id } as CompositionTarget;
          this.#composition?.select([target]);
          this.dispatchTypedEvent<HonuaStudioSelectionChangeDetail>("honua-studio-selection-change", {
            targets: [target],
          });
        },
        { signal },
      );
    }
  }
}

function targetKey(target: CompositionTarget): string {
  return target.kind === "feature"
    ? `feature:${target.sourceId}:${String(target.featureId)}`
    : `${target.kind}:${target.id}`;
}

function targetMatches(target: CompositionTarget, kind: "layer" | "component" | "region", id: string): boolean {
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

function renderLayerRow(layer: CompositionLayer, selectionKeys: Set<string>, pinned: boolean): string {
  const target: CompositionTarget = { kind: "layer", id: layer.id };
  const selected = selectionKeys.has(targetKey(target));
  const detail = [
    layer.sourceId,
    layer.visible ? "visible" : "hidden",
    layer.styleRef ? layer.styleRef.styleId : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return renderRow("layer", layer.id, layer.title ?? layer.id, detail, selected, pinned);
}

function renderWidgetRow(widget: CompositionWidget, selectionKeys: Set<string>, pinned: boolean): string {
  const target: CompositionTarget = { kind: "component", id: widget.id };
  const selected = selectionKeys.has(targetKey(target));
  const detail = [widget.kind, widget.sourceId].filter((part): part is string => Boolean(part)).join(" · ");
  return renderRow("component", widget.id, widget.title ?? widget.id, detail, selected, pinned);
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
    >
      <span>${escapeHtml(title)}${pinned ? ' <span aria-label="pinned">📌</span>' : ""}</span>
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
