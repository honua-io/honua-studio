// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompositionController } from "../../src/composition/controller.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioCanvasElement } from "../../src/elements/studio-canvas-element.js";
import type { HonuaStudioSelectionChangeDetail } from "../../src/elements/types.js";

registerAllStudioElements();

function mount(): HonuaStudioCanvasElement {
  const el = document.createElement("honua-studio-canvas") as HonuaStudioCanvasElement;
  document.body.appendChild(el);
  return el;
}

describe("<honua-studio-canvas> composition readout (honua-studio#8)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("without a .composition, renders the honua-studio#5 placeholder unchanged", () => {
    const el = mount();
    expect(el.shadowRoot?.querySelector('[data-testid="studio-canvas-surface"]')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[data-testid="studio-canvas-readout"]')).toBeFalsy();
  });

  it("with a .composition, renders layers/view/widgets/pins sections reactively", () => {
    const el = mount();
    const controller = new CompositionController(createEmptyCompositionState());
    el.composition = controller;

    expect(el.shadowRoot?.querySelector('[data-testid="studio-canvas-readout"]')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[data-testid="studio-canvas-layers"] .composition-empty')).toBeTruthy();

    controller.apply({ name: "addLayer", layer: { id: "roads", sourceId: "src-roads", title: "Roads" } });

    const layerRow = el.shadowRoot?.querySelector('[data-testid="studio-canvas-layers"] [data-target-id="roads"]');
    expect(layerRow?.textContent).toContain("Roads");
  });

  it("renders view fields, widgets, and pins", () => {
    const el = mount();
    const controller = new CompositionController(createEmptyCompositionState());
    el.composition = controller;

    controller.apply({ name: "setView", view: { zoom: 8, center: [1, 2] } });
    controller.apply({ name: "addWidget", widget: { id: "chart-1", kind: "chart" } });
    controller.apply({ name: "addLayer", layer: { id: "roads", sourceId: "s" } });
    controller.apply({ name: "pin", target: { kind: "layer", id: "roads" } });

    const viewSection = el.shadowRoot?.querySelector('[data-testid="studio-canvas-view"]');
    expect(viewSection?.textContent).toContain("zoom 8");

    const widgetRow = el.shadowRoot?.querySelector('[data-testid="studio-canvas-widgets"] [data-target-id="chart-1"]');
    expect(widgetRow).toBeTruthy();

    const pinBadges = el.shadowRoot?.querySelectorAll('[data-testid="studio-canvas-pin"]');
    expect(pinBadges).toHaveLength(1);
    expect(pinBadges?.[0]?.textContent).toBe("layer:roads");

    const layerRow = el.shadowRoot?.querySelector('[data-testid="studio-canvas-layers"] [data-target-id="roads"]');
    expect(layerRow?.getAttribute("data-pinned")).toBe("true");
  });

  it("clicking a row selects it on the controller and dispatches honua-studio-selection-change", () => {
    const el = mount();
    const controller = new CompositionController(createEmptyCompositionState());
    controller.apply({ name: "addLayer", layer: { id: "roads", sourceId: "s" } });
    el.composition = controller;

    const listener = vi.fn();
    el.addEventListener("honua-studio-selection-change", listener as EventListener);

    const row = el.shadowRoot?.querySelector<HTMLButtonElement>('[data-target-kind="layer"][data-target-id="roads"]');
    expect(row).toBeTruthy();
    row?.click();

    expect(controller.selection).toEqual([{ kind: "layer", id: "roads" }]);
    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0]?.[0] as CustomEvent<HonuaStudioSelectionChangeDetail>;
    expect(event.detail.targets).toEqual([{ kind: "layer", id: "roads" }]);

    // The selected row reflects aria-pressed after the reactive re-render.
    const reselectedRow = el.shadowRoot?.querySelector('[data-target-kind="layer"][data-target-id="roads"]');
    expect(reselectedRow?.getAttribute("aria-pressed")).toBe("true");
  });

  it("unsubscribes from the composition controller on disconnect (no leaked listener)", () => {
    const el = mount();
    const controller = new CompositionController(createEmptyCompositionState());
    el.composition = controller;
    document.body.removeChild(el);

    // Applying a command after unmount must not throw from a stale render() call.
    expect(() => controller.apply({ name: "addLayer", layer: { id: "roads", sourceId: "s" } })).not.toThrow();
  });

  it("swapping .composition unsubscribes from the previous controller", () => {
    const el = mount();
    const controllerA = new CompositionController(createEmptyCompositionState());
    const controllerB = new CompositionController(createEmptyCompositionState());
    el.composition = controllerA;
    el.composition = controllerB;

    controllerB.apply({ name: "addLayer", layer: { id: "b-layer", sourceId: "s" } });
    expect(el.shadowRoot?.querySelector('[data-target-id="b-layer"]')).toBeTruthy();

    // controllerA changes no longer reach the element.
    controllerA.apply({ name: "addLayer", layer: { id: "a-layer", sourceId: "s" } });
    expect(el.shadowRoot?.querySelector('[data-target-id="a-layer"]')).toBeFalsy();
  });
});
