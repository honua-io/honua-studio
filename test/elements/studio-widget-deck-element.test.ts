// @vitest-environment happy-dom
/**
 * `<honua-studio-widget-deck>` — honua-studio#24's acceptance criteria, at the
 * element level:
 *
 *  - each bounded widget kind renders and updates from composition state,
 *  - a TOC reflects layers added **before and after** it, with working
 *    toggles and no authored bindings,
 *  - charts render from an agent-authored widget with no hand-written spec,
 *  - grid row selection drives a feature selection through the normal path.
 *
 * The deck is exercised against a fake {@link WidgetDataLoader}, the grid/chart
 * analogue of the `mapFactory` seam honua-studio#23 established — so the whole
 * pipeline (config -> spec -> aggregate -> render -> select) runs without a
 * network or a renderer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompositionController } from "../../src/composition/controller.js";
import { type CompositionTarget, createEmptyCompositionState } from "../../src/composition/model.js";
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioWidgetDeckElement } from "../../src/elements/studio-widget-deck-element.js";
import type { HonuaStudioSelectionChangeDetail } from "../../src/elements/types.js";
import type { WidgetDataLoader, WidgetDataResult } from "../../src/widgets/widget-data.js";

registerAllStudioElements();

const PARCEL_ROWS = [
  { featureId: 1, properties: { parcel_id: "TMK-0001", district: "Honolulu", zoning_code: "R-5" } },
  { featureId: 2, properties: { parcel_id: "TMK-0002", district: "ʻEwa", zoning_code: "R-5" } },
  { featureId: 3, properties: { parcel_id: "TMK-0003", district: "ʻEwa", zoning_code: "B-2" } },
];

function loaderFor(result: WidgetDataResult = { ok: true, rows: PARCEL_ROWS, truncated: false }): WidgetDataLoader {
  return vi.fn(async () => result);
}

function mount(controller: CompositionController, loader?: WidgetDataLoader): HonuaStudioWidgetDeckElement {
  const el = document.createElement("honua-studio-widget-deck") as HonuaStudioWidgetDeckElement;
  document.body.appendChild(el);
  if (loader) el.dataLoader = loader;
  el.composition = controller;
  return el;
}

/**
 * Lets the deck's async work land: the fake data loader resolves on a
 * microtask, but the chart pipeline is a real dynamic `import()`, so a fixed
 * number of microtask turns is not enough. Polls the macrotask queue instead.
 */
async function settle(until?: () => boolean): Promise<void> {
  if (!until) {
    for (let attempt = 0; attempt < 5; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    return;
  }
  // Deadline rather than a turn count: the chart pipeline is a real dynamic
  // import, and the first one in a run pays for module transform.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (until()) return;
  }
}

function query<T extends Element>(el: HonuaStudioWidgetDeckElement, selector: string): T | null {
  return el.shadowRoot?.querySelector<T>(selector) ?? null;
}

function queryAll<T extends Element>(el: HonuaStudioWidgetDeckElement, selector: string): T[] {
  return [...(el.shadowRoot?.querySelectorAll<T>(selector) ?? [])];
}

describe("<honua-studio-widget-deck> — layer list (REQ-002/REQ-003)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("takes no space at all until the composition holds a widget", () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const el = mount(controller);
    expect(el.dataset.empty).toBe("true");
    controller.apply({ name: "addWidget", widget: { id: "layers", kind: "toc" } });
    expect(el.dataset.empty).toBeUndefined();
  });

  it("lists layers added BEFORE and AFTER the TOC, with nothing authored in between", () => {
    const controller = new CompositionController(createEmptyCompositionState());
    controller.apply({ name: "addLayer", layer: { id: "parcels", sourceId: "hi-parcels", title: "Parcels" } });
    const el = mount(controller);
    controller.apply({ name: "addWidget", widget: { id: "layers", kind: "toc" } });

    expect(queryAll(el, '[data-testid="studio-widget-toc-row"]')).toHaveLength(1);

    // The whole of REQ-002: a later tool call, no re-authoring, no binding.
    controller.apply({ name: "addLayer", layer: { id: "roads", sourceId: "hi-roads", title: "Roads" } });
    const rows = queryAll(el, '[data-testid="studio-widget-toc-row"]');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.getAttribute("data-layer-id"))).toEqual(["parcels", "roads"]);
    expect(el.shadowRoot?.textContent).toContain("Roads");
  });

  it("says so when there are no layers yet rather than rendering a blank box", () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const el = mount(controller);
    controller.apply({ name: "addWidget", widget: { id: "layers", kind: "toc" } });
    expect(query(el, '[data-testid="studio-widget-toc-empty"]')?.textContent).toContain("fills in as layers are added");
  });

  it("toggling a checkbox applies a setVisibility COMMAND — the intrinsic path is the same write path", () => {
    const controller = new CompositionController(createEmptyCompositionState());
    controller.apply({ name: "addLayer", layer: { id: "parcels", sourceId: "hi-parcels" } });
    const el = mount(controller);
    controller.apply({ name: "addWidget", widget: { id: "layers", kind: "toc" } });

    const toggle = query<HTMLInputElement>(el, '[data-testid="studio-widget-toc-toggle"]');
    expect(toggle?.checked).toBe(true);

    toggle!.checked = false;
    toggle!.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    expect(controller.state.layers[0]?.visible).toBe(false);
    // It went through history, which a direct mutation never would.
    expect(controller.canUndo()).toBe(true);
    controller.undo();
    expect(query<HTMLInputElement>(el, '[data-testid="studio-widget-toc-toggle"]')?.checked).toBe(true);
  });

  it("routes the toggle to commandDispatch when the host wires one (honua-studio#31)", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    controller.apply({ name: "addLayer", layer: { id: "parcels", sourceId: "hi-parcels" } });
    const el = mount(controller);
    const dispatched: unknown[][] = [];
    el.commandDispatch = async (commands) => {
      dispatched.push([...commands]);
      return { ok: true };
    };
    controller.apply({ name: "addWidget", widget: { id: "layers", kind: "toc" } });

    const toggle = query<HTMLInputElement>(el, '[data-testid="studio-widget-toc-toggle"]');
    toggle!.checked = false;
    toggle!.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await settle();

    // The command left through the host's dispatcher — the route that reaches
    // `honua_studio_set_layer_visibility` in live mode…
    expect(dispatched).toEqual([[{ name: "setVisibility", target: { kind: "layer", id: "parcels" }, visible: false }]]);
    // …and the deck did NOT also write it locally. Local state follows the
    // draft the dispatcher comes back with, not the gesture.
    expect(controller.state.layers[0]?.visible).toBe(true);
  });

  it("snaps a refused toggle back and puts the reason on the card", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    controller.apply({ name: "addLayer", layer: { id: "parcels", sourceId: "hi-parcels" } });
    const el = mount(controller);
    el.commandDispatch = async () => ({ ok: false, reason: "Stale draft generation; refresh and retry." });
    controller.apply({ name: "addWidget", widget: { id: "layers", kind: "toc" } });

    const toggle = query<HTMLInputElement>(el, '[data-testid="studio-widget-toc-toggle"]');
    toggle!.checked = false;
    toggle!.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await settle();

    // A native checkbox flips itself on the gesture; only a repaint from real
    // state can put it back, and the reason has to be visible, not swallowed.
    expect(query<HTMLInputElement>(el, '[data-testid="studio-widget-toc-toggle"]')?.checked).toBe(true);
    expect(query(el, '[data-testid="studio-widget-status"]')?.textContent).toContain("Stale draft generation");
  });

  it("surfaces a rejected dispatch promise instead of leaving an unhandled rejection", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    controller.apply({ name: "addLayer", layer: { id: "parcels", sourceId: "hi-parcels" } });
    const el = mount(controller);
    el.commandDispatch = async () => {
      throw new Error("the tool plane is unreachable");
    };
    controller.apply({ name: "addWidget", widget: { id: "layers", kind: "toc" } });

    const toggle = query<HTMLInputElement>(el, '[data-testid="studio-widget-toc-toggle"]');
    toggle!.checked = false;
    toggle!.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await settle();

    expect(query(el, '[data-testid="studio-widget-status"]')?.textContent).toContain("tool plane is unreachable");
  });

  it("disables the toggle for a pinned layer and explains why", () => {
    const controller = new CompositionController(createEmptyCompositionState());
    controller.apply({ name: "addLayer", layer: { id: "parcels", sourceId: "hi-parcels" } });
    controller.apply({ name: "pin", target: { kind: "layer", id: "parcels" } });
    const el = mount(controller);
    controller.apply({ name: "addWidget", widget: { id: "layers", kind: "toc" } });

    const toggle = query<HTMLInputElement>(el, '[data-testid="studio-widget-toc-toggle"]');
    expect(toggle?.disabled).toBe(true);
    expect(toggle?.getAttribute("title")).toContain("pinned");
  });

  it("flags a layer the map could not draw instead of implying it is on the map", () => {
    const controller = new CompositionController(createEmptyCompositionState());
    controller.apply({ name: "addLayer", layer: { id: "imagery", sourceId: "hi-imagery" } });
    const el = mount(controller);
    controller.apply({ name: "addWidget", widget: { id: "layers", kind: "toc" } });
    el.unrenderableLayers = [{ layerId: "imagery", reason: "raster is not renderable yet" }];

    const flag = query(el, '[data-testid="studio-widget-toc-unrendered"]');
    expect(flag?.textContent).toContain("not on map");
    expect(flag?.getAttribute("title")).toContain("raster");
  });

  it("clicking a layer label selects it as a deictic target", () => {
    const controller = new CompositionController(createEmptyCompositionState());
    controller.apply({ name: "addLayer", layer: { id: "parcels", sourceId: "hi-parcels" } });
    const el = mount(controller);
    controller.apply({ name: "addWidget", widget: { id: "layers", kind: "toc" } });

    const seen: CompositionTarget[][] = [];
    document.addEventListener("honua-studio-selection-change", (event) => {
      seen.push([...(event as CustomEvent<HonuaStudioSelectionChangeDetail>).detail.targets]);
    });
    query<HTMLButtonElement>(el, ".widget-toc-label")?.click();

    expect(controller.selection).toEqual([{ kind: "layer", id: "parcels" }]);
    expect(seen).toEqual([[{ kind: "layer", id: "parcels" }]]);
  });
});

describe("<honua-studio-widget-deck> — data grid (REQ-005)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders columns and rows from the loader, then selects a feature on row click", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const el = mount(controller, loaderFor());
    controller.apply({
      name: "addWidget",
      widget: { id: "grid", kind: "table", sourceId: "hi-parcels", title: "Parcels" },
    });
    await settle();

    const headers = queryAll(el, '[data-testid="studio-widget-grid"] thead th').map((th) => th.textContent);
    expect(headers).toEqual(["parcel_id", "district", "zoning_code"]);
    const rows = queryAll<HTMLTableRowElement>(el, '[data-testid="studio-widget-grid-row"]');
    expect(rows).toHaveLength(3);

    const targets: CompositionTarget[][] = [];
    document.addEventListener("honua-studio-selection-change", (event) => {
      targets.push([...(event as CustomEvent<HonuaStudioSelectionChangeDetail>).detail.targets]);
    });
    rows[1]?.click();

    // The same `{ kind: "feature", … }` shape a map click produces — and a
    // NUMERIC id, because `feature:hi-parcels:2` and `feature:hi-parcels:"2"`
    // are different deictic targets.
    expect(targets).toEqual([[{ kind: "feature", sourceId: "hi-parcels", featureId: 2 }]]);
    expect(controller.selection).toEqual([{ kind: "feature", sourceId: "hi-parcels", featureId: 2 }]);
    await settle();
    expect(queryAll(el, '[data-testid="studio-widget-grid-row"]')[1]?.getAttribute("aria-selected")).toBe("true");
  });

  it("selects on Enter as well as click — rows are focusable, so they must be operable", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const el = mount(controller, loaderFor());
    controller.apply({ name: "addWidget", widget: { id: "grid", kind: "table", sourceId: "hi-parcels" } });
    await settle();

    const row = queryAll<HTMLTableRowElement>(el, '[data-testid="studio-widget-grid-row"]')[0];
    expect(row?.getAttribute("tabindex")).toBe("0");
    row?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true }));
    expect(controller.selection).toEqual([{ kind: "feature", sourceId: "hi-parcels", featureId: 1 }]);
  });

  it("routes selection through the host when one is wired, so the app has one dispatcher", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const el = mount(controller, loaderFor());
    const host = vi.fn();
    el.onSelection = host;
    controller.apply({ name: "addWidget", widget: { id: "grid", kind: "table", sourceId: "hi-parcels" } });
    await settle();

    queryAll<HTMLTableRowElement>(el, '[data-testid="studio-widget-grid-row"]')[0]?.click();
    expect(host).toHaveBeenCalledWith([{ kind: "feature", sourceId: "hi-parcels", featureId: 1 }]);
    // The deck did not also select/dispatch itself — exactly one path.
    expect(controller.selection).toEqual([]);
  });

  it("pages a grid larger than its page size and reports the range", async () => {
    const rows = Array.from({ length: 7 }, (_, index) => ({ featureId: index, properties: { n: index } }));
    const controller = new CompositionController(createEmptyCompositionState());
    const el = mount(controller, loaderFor({ ok: true, rows, truncated: false }));
    controller.apply({
      name: "addWidget",
      widget: { id: "grid", kind: "table", sourceId: "hi-parcels", config: { pageSize: 3 } },
    });
    await settle();

    expect(query(el, '[data-testid="studio-widget-grid-range"]')?.textContent).toBe("1–3 of 7");
    query<HTMLButtonElement>(el, '[data-testid="studio-widget-grid-next"]')?.click();
    expect(query(el, '[data-testid="studio-widget-grid-range"]')?.textContent).toBe("4–6 of 7");
  });

  it("surfaces a load failure on the card rather than rendering an empty grid", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const el = mount(controller, loaderFor({ ok: false, reason: 'Source "hi-parcels" returned HTTP 503.' }));
    controller.apply({ name: "addWidget", widget: { id: "grid", kind: "table", sourceId: "hi-parcels" } });
    await settle();

    expect(query(el, '[data-testid="studio-widget-status"]')?.textContent).toContain("HTTP 503");
    expect(query(el, '[data-testid="studio-widget-grid"]')).toBeNull();
  });

  it("says a bounded result is bounded", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const el = mount(controller, loaderFor({ ok: true, rows: PARCEL_ROWS, truncated: true, total: 900 }));
    controller.apply({ name: "addWidget", widget: { id: "grid", kind: "table", sourceId: "hi-parcels" } });
    await settle();
    expect(query(el, '[data-testid="studio-widget-status"]')?.textContent).toContain("of 900");
  });
});

describe("<honua-studio-widget-deck> — chart, legend, compare, time (REQ-001/REQ-004)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a chart from an agent-authored widget with no hand-written spec", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const el = mount(controller, loaderFor());
    // Exactly what `tool-bridge.ts`'s `add_chart` produces from
    // "chart the parcels by zoning code".
    controller.apply({
      name: "addWidget",
      widget: {
        id: "chart-hi-parcels-zoning_code",
        kind: "chart",
        sourceId: "hi-parcels",
        config: { groupBy: "zoning_code", chartType: "bar" },
      },
    });
    await settle(() => query(el, '[data-testid="studio-widget-chart"]') !== null);

    const chart = query(el, '[data-testid="studio-widget-chart"]');
    expect(chart?.getAttribute("data-mark")).toBe("bar");
    expect(chart?.querySelectorAll("rect.widget-chart-bar")).toHaveLength(2);
    expect(query(el, '[data-testid="studio-widget-chart-summary"]')?.textContent).toContain("R-5 2");
  });

  it("renders a legend keyed to the same colours the map paints, tracking visibility", () => {
    const controller = new CompositionController(createEmptyCompositionState());
    controller.apply({ name: "addLayer", layer: { id: "parcels", sourceId: "hi-parcels", title: "Parcels" } });
    controller.apply({ name: "addLayer", layer: { id: "roads", sourceId: "hi-roads", visible: false } });
    const el = mount(controller);
    controller.apply({ name: "addWidget", widget: { id: "key", kind: "legend" } });

    expect(queryAll(el, '[data-testid="studio-widget-legend-item"]')).toHaveLength(1);
    controller.apply({ name: "setVisibility", target: { kind: "layer", id: "roads" }, visible: true });
    expect(queryAll(el, '[data-testid="studio-widget-legend-item"]')).toHaveLength(2);
  });

  it("a compare switch flips visibility between two layers through the reducer", () => {
    const controller = new CompositionController(createEmptyCompositionState());
    controller.apply({ name: "addLayer", layer: { id: "before", sourceId: "s1" } });
    controller.apply({ name: "addLayer", layer: { id: "after", sourceId: "s2" } });
    const el = mount(controller);
    controller.apply({
      name: "addWidget",
      widget: { id: "cmp", kind: "compare", config: { left: "before", right: "after" } },
    });

    expect(query(el, '[data-testid="studio-widget-compare"]')?.getAttribute("data-mode")).toBe("both");
    queryAll<HTMLButtonElement>(el, '[data-testid="studio-widget-compare-option"]')[2]?.click();

    expect(controller.state.layers.map((layer) => layer.visible)).toEqual([false, true]);
    expect(query(el, '[data-testid="studio-widget-compare"]')?.getAttribute("data-mode")).toBe("right");
  });

  it("a time stepper shows one step's layer at a time", () => {
    const controller = new CompositionController(createEmptyCompositionState());
    controller.apply({ name: "addLayer", layer: { id: "y2019", sourceId: "s", visible: true } });
    controller.apply({ name: "addLayer", layer: { id: "y2020", sourceId: "s", visible: false } });
    const el = mount(controller);
    controller.apply({
      name: "addWidget",
      widget: {
        id: "time",
        kind: "time",
        config: {
          steps: [
            { label: "2019", layerId: "y2019" },
            { label: "2020", layerId: "y2020" },
          ],
        },
      },
    });

    expect(query(el, '[data-testid="studio-widget-time-label"]')?.textContent).toBe("2019");
    const slider = query<HTMLInputElement>(el, '[data-testid="studio-widget-time-slider"]');
    slider!.value = "1";
    slider!.dispatchEvent(new Event("change", { bubbles: true, composed: true }));

    expect(controller.state.layers.map((layer) => layer.visible)).toEqual([false, true]);
    expect(query(el, '[data-testid="studio-widget-time-label"]')?.textContent).toBe("2020");
  });

  it("reports an unrenderable-as-authored widget instead of drawing nothing", () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const el = mount(controller);
    controller.apply({ name: "addWidget", widget: { id: "cmp", kind: "compare", config: { left: "only" } } });
    expect(query(el, '[data-testid="studio-widget-status"]')?.textContent).toContain("needs two layers");
  });

  it("removing a widget removes its card", () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const el = mount(controller);
    controller.apply({ name: "addWidget", widget: { id: "layers", kind: "toc" } });
    expect(queryAll(el, '[data-testid="studio-widget"]')).toHaveLength(1);
    controller.apply({ name: "removeWidget", target: { kind: "component", id: "layers" } });
    expect(queryAll(el, '[data-testid="studio-widget"]')).toHaveLength(0);
  });

  it("unsubscribes on disconnect", () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const el = mount(controller);
    el.remove();
    // Would throw or repaint a detached root if the subscription survived.
    expect(() => controller.apply({ name: "addWidget", widget: { id: "layers", kind: "toc" } })).not.toThrow();
    expect(el.shadowRoot?.querySelectorAll('[data-testid="studio-widget"]')).toHaveLength(0);
  });
});
