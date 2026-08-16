// @vitest-environment happy-dom
/**
 * The canvas side of honua-studio#24: `<honua-studio-canvas>` composes the
 * widget deck, feeds it, and keeps its single selection path.
 *
 * Two regressions this file exists to prevent:
 *
 *  1. The readout losing its job. honua-studio#23's readout is still the
 *     map's accessible description and still the only surface listing pins
 *     and annotations; adding a widget deck must not quietly retire it. Every
 *     `data-testid` it introduced is re-asserted here alongside the deck.
 *  2. A selection from a grid row escaping as a *second* dispatch. The canvas
 *     is the app's one selection dispatcher, and a widget row must go through
 *     it rather than around it.
 */
import { afterEach, describe, expect, it } from "vitest";

import { CompositionController } from "../../src/composition/controller.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioCanvasElement } from "../../src/elements/studio-canvas-element.js";
import type { HonuaStudioSelectionChangeDetail } from "../../src/elements/types.js";
import type { WidgetDataLoader } from "../../src/widgets/widget-data.js";

registerAllStudioElements();

const loader: WidgetDataLoader = async () => ({
  ok: true,
  rows: [{ featureId: 7, properties: { parcel_id: "TMK-0007", zoning_code: "R-5" } }],
  truncated: false,
});

function mount(): HonuaStudioCanvasElement {
  const el = document.createElement("honua-studio-canvas") as HonuaStudioCanvasElement;
  document.body.appendChild(el);
  return el;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

describe("<honua-studio-canvas> + widget deck (honua-studio#24)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("has no deck in placeholder mode and one in composition mode", () => {
    const el = mount();
    expect(el.widgetDeck).toBeUndefined();
    el.composition = new CompositionController(createEmptyCompositionState());
    expect(el.widgetDeck).toBeTruthy();
  });

  it("keeps every readout test id alongside the deck", () => {
    const el = mount();
    el.composition = new CompositionController(createEmptyCompositionState());
    for (const testId of [
      "studio-canvas-readout",
      "studio-canvas-layers",
      "studio-canvas-view",
      "studio-canvas-widgets",
      "studio-canvas-annotations",
      "studio-canvas-pins",
      "studio-canvas-map",
      "studio-canvas-map-status",
      "studio-canvas-widget-deck",
    ]) {
      expect(el.shadowRoot?.querySelector(`[data-testid="${testId}"]`), testId).toBeTruthy();
    }
  });

  it("the readout keeps listing widgets the deck also draws — they answer different questions", () => {
    const el = mount();
    const controller = new CompositionController(createEmptyCompositionState());
    el.composition = controller;
    controller.apply({ name: "addLayer", layer: { id: "parcels", sourceId: "hi-parcels", title: "Parcels" } });
    controller.apply({ name: "addWidget", widget: { id: "layers", kind: "toc", title: "Layers" } });

    // The readout names the widget; the deck draws it. Neither replaces the other.
    expect(el.shadowRoot?.querySelector('[data-testid="studio-canvas-widgets"]')?.textContent).toContain("Layers");
    const tocRows = el.widgetDeck?.shadowRoot?.querySelectorAll('[data-testid="studio-widget-toc-row"]');
    expect(tocRows).toHaveLength(1);
  });

  it("passes catalog, base url, and loader down to the deck", () => {
    const el = mount();
    el.composition = new CompositionController(createEmptyCompositionState());
    el.sourceBaseUrl = "/proxy";
    el.sourceCatalog = [{ id: "hi-parcels", protocol: "ogc-features", geometryType: "Polygon" }];
    el.widgetDataLoader = loader;

    expect(el.widgetDeck?.sourceBaseUrl).toBe("/proxy");
    expect(el.widgetDeck?.sourceCatalog).toHaveLength(1);
    expect(el.widgetDeck?.dataLoader).toBe(loader);
  });

  it("a grid row selection reaches the host exactly once, dispatched by the canvas", async () => {
    const el = mount();
    const controller = new CompositionController(createEmptyCompositionState());
    el.widgetDataLoader = loader;
    el.composition = controller;
    controller.apply({ name: "addWidget", widget: { id: "grid", kind: "table", sourceId: "hi-parcels" } });
    await settle();

    const events: { target: EventTarget | null; detail: HonuaStudioSelectionChangeDetail }[] = [];
    document.addEventListener("honua-studio-selection-change", (event) => {
      const custom = event as CustomEvent<HonuaStudioSelectionChangeDetail>;
      events.push({ target: custom.target, detail: custom.detail });
    });

    el.widgetDeck?.shadowRoot?.querySelector<HTMLTableRowElement>('[data-testid="studio-widget-grid-row"]')?.click();

    expect(events).toHaveLength(1);
    expect(events[0]?.target).toBe(el);
    expect(events[0]?.detail.targets).toEqual([{ kind: "feature", sourceId: "hi-parcels", featureId: 7 }]);
    expect(controller.selection).toEqual([{ kind: "feature", sourceId: "hi-parcels", featureId: 7 }]);
  });

  it("swapping the composition re-points the deck rather than leaving it on the old one", () => {
    const el = mount();
    const first = new CompositionController(createEmptyCompositionState());
    el.composition = first;
    first.apply({ name: "addWidget", widget: { id: "layers", kind: "toc" } });
    expect(el.widgetDeck?.shadowRoot?.querySelectorAll('[data-testid="studio-widget"]')).toHaveLength(1);

    const second = new CompositionController(createEmptyCompositionState());
    el.composition = second;
    expect(el.widgetDeck?.composition).toBe(second);
    expect(el.widgetDeck?.shadowRoot?.querySelectorAll('[data-testid="studio-widget"]')).toHaveLength(0);
  });

  it("does not leak deck instances when the canvas is torn down", () => {
    const el = mount();
    el.composition = new CompositionController(createEmptyCompositionState());
    const deckClass = customElements.get("honua-studio-widget-deck") as unknown as { instanceCount: number };
    const before = deckClass.instanceCount;
    expect(before).toBeGreaterThan(0);
    el.remove();
    expect(deckClass.instanceCount).toBe(before - 1);
  });
});
