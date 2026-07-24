import { describe, expect, it, vi } from "vitest";

import { CompositionController } from "../../src/composition/controller.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";

describe("composition/controller CompositionController", () => {
  it("apply/undo/redo delegate to history and notify subscribers", () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.apply({ name: "addLayer", layer: { id: "roads", sourceId: "s" } });
    expect(controller.state.layers).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(1);

    expect(controller.undo()).toBe(true);
    expect(controller.state.layers).toHaveLength(0);
    expect(listener).toHaveBeenCalledTimes(2);

    expect(controller.redo()).toBe(true);
    expect(controller.state.layers).toHaveLength(1);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("undo()/redo() return false and do not notify when there is nothing to do", () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const listener = vi.fn();
    controller.subscribe(listener);
    expect(controller.undo()).toBe(false);
    expect(controller.redo()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("select() replaces the ephemeral selection and notifies", () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.select([{ kind: "layer", id: "roads" }]);
    expect(controller.selection).toEqual([{ kind: "layer", id: "roads" }]);
    expect(listener).toHaveBeenCalledTimes(1);
    controller.clearSelection();
    expect(controller.selection).toEqual([]);
  });

  it("a rejected apply() throws through to the caller and does not notify", () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const listener = vi.fn();
    controller.subscribe(listener);
    expect(() => controller.apply({ name: "removeLayer", target: { kind: "layer", id: "ghost" } })).toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it("subscribe() returns an unsubscribe function", () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    unsubscribe();
    controller.apply({ name: "addLayer", layer: { id: "roads", sourceId: "s" } });
    expect(listener).not.toHaveBeenCalled();
  });
});
