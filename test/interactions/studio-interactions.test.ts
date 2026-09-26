/**
 * honua-studio#25's headline acceptance criterion, end to end and without a
 * DOM: **"a control `change` binding dispatches through the compiler with no
 * cascade"**, and the issue's second user workflow verbatim — "when the
 * district filter changes, filter the parcels layer".
 *
 * This is the test that would catch a regression to a parallel event path:
 * nothing here calls a Studio-private bus. A control publishes one
 * `FilterClause` through the SDK's exploration primitive, and both the
 * compiler and the map's appearance are downstream *reads* of that one write.
 */
import { describe, expect, it } from "vitest";

import { CompositionController } from "../../src/composition/controller.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import { StudioInteractionRuntime } from "../../src/interactions/studio-interactions.js";

function controllerWithParcels(): CompositionController {
  const controller = new CompositionController(createEmptyCompositionState());
  controller.apply({ name: "addLayer", layer: { id: "parcels", sourceId: "src-parcels" } });
  controller.apply({ name: "addLayer", layer: { id: "districts", sourceId: "src-districts" } });
  return controller;
}

/** Exploration listeners fire on a microtask so a burst of intents coalesces — let them land. */
async function flush(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("interactions/StudioInteractionRuntime", () => {
  it("filters a control's OWN source layer with no authored binding — a filter bar filters what it reads from", async () => {
    const controller = controllerWithParcels();
    controller.apply({
      name: "addControl",
      control: { id: "zoning", kind: "filterSelect", sourceId: "src-parcels", config: { field: "zoning_code" } },
    });
    const runtime = new StudioInteractionRuntime({ controller });

    runtime.publishControlChange("zoning", { field: "zoning_code", operator: "=", value: "R-5" });
    await flush();

    expect(runtime.appearance.filters.parcels).toEqual(["==", ["get", "zoning_code"], "R-5"]);
    expect(runtime.appearance.filters.districts).toBeUndefined();
    runtime.dispose();
  });

  it('runs the issue\'s workflow: "when the district filter changes, filter the parcels layer"', async () => {
    const controller = controllerWithParcels();
    controller.apply({
      name: "addControl",
      control: { id: "district", kind: "filterSelect", sourceId: "src-districts", config: { field: "name" } },
    });
    controller.apply({
      name: "bindInteraction",
      interaction: {
        id: "district-drives-parcels",
        on: { ref: "control:district", event: "change" },
        do: { ref: "layer:parcels", verb: "setFilter", args: { field: "district_id", value: "$event.value" } },
      },
    });
    const runtime = new StudioInteractionRuntime({ controller });
    expect(runtime.compiled?.ok).toBe(true);
    expect(runtime.compiled?.bindings.map((binding) => binding.pair)).toEqual(["change -> setFilter"]);

    runtime.publishControlChange("district", { field: "name", operator: "=", value: "HON" });
    await flush();

    // The bound layer got the binding's rewritten field…
    expect(runtime.appearance.filters.parcels).toEqual(["==", ["get", "district_id"], "HON"]);
    // …and the control's own source layer got its own clause. Both are the
    // consequence of ONE published clause.
    expect(runtime.appearance.filters.districts).toEqual(["==", ["get", "name"], "HON"]);
    runtime.dispose();
  });

  it("does not cascade: the verb's own write never re-enters the compiler", async () => {
    const controller = controllerWithParcels();
    controller.apply({
      name: "addControl",
      control: { id: "district", kind: "filterSelect", sourceId: "src-districts", config: { field: "name" } },
    });
    controller.apply({
      name: "bindInteraction",
      interaction: {
        id: "b",
        on: { ref: "control:district", event: "change" },
        do: { ref: "layer:parcels", verb: "setFilter", args: { field: "district_id", value: "$event.value" } },
      },
    });
    const dispatches: string[] = [];
    const runtime = new StudioInteractionRuntime({
      controller,
      onDispatch: (record) => dispatches.push(record.interactionId),
    });

    runtime.publishControlChange("district", { field: "name", operator: "=", value: "HON" });
    await flush();
    await flush();

    // Exactly one action ran. A cascade would show up here as two, or as an
    // unbounded loop that never lets `flush` return.
    expect(dispatches).toEqual(["b"]);
    runtime.dispose();
  });

  it("clears the layer filter when the control clears (the All option)", async () => {
    const controller = controllerWithParcels();
    controller.apply({
      name: "addControl",
      control: { id: "zoning", kind: "filterSelect", sourceId: "src-parcels", config: { field: "zoning_code" } },
    });
    const runtime = new StudioInteractionRuntime({ controller });
    runtime.publishControlChange("zoning", { field: "zoning_code", operator: "=", value: "R-5" });
    await flush();
    expect(runtime.appearance.filters.parcels).toBeDefined();

    runtime.publishControlChange("zoning", undefined);
    await flush();
    expect(runtime.appearance.filters.parcels).toBeUndefined();
    runtime.dispose();
  });

  it("carries an opacity value on the same channel without it ever becoming a map filter", async () => {
    const controller = controllerWithParcels();
    controller.apply({
      name: "addControl",
      control: { id: "fade", kind: "opacity", sourceId: "parcels" },
    });
    const runtime = new StudioInteractionRuntime({ controller });

    runtime.publishOpacity("fade", 0.4);
    await flush();

    expect(runtime.appearance.opacity).toEqual({ parcels: 0.4 });
    expect(runtime.appearance.filters).toEqual({});
    runtime.dispose();
  });

  it("drives a setViewport verb through the reducer, so an action lands in history like any other write", async () => {
    const controller = controllerWithParcels();
    controller.apply({
      name: "addControl",
      control: { id: "year", kind: "filterSlider", config: { field: "year_built", min: 1900, max: 2020 } },
    });
    controller.apply({
      name: "bindInteraction",
      interaction: {
        id: "zoom-on-change",
        on: { ref: "control:year", event: "change" },
        // ADR-0030 spells a viewport argument flat; the SDK compiler reads
        // `bbox`/`center`/`zoom`/`pitch`/`bearing` off `args` directly.
        do: { ref: "map", verb: "setViewport", args: { zoom: 9 } },
      },
    });
    const runtime = new StudioInteractionRuntime({ controller });

    runtime.publishControlChange("year", { field: "year_built", operator: ">=", value: 1950 });
    await flush();

    expect(controller.state.view.zoom).toBe(9);
    expect(controller.canUndo()).toBe(true);
    runtime.dispose();
  });

  it("recompiles when the document changes, so a binding added mid-conversation goes live", async () => {
    const controller = controllerWithParcels();
    controller.apply({
      name: "addControl",
      control: { id: "district", kind: "filterSelect", sourceId: "src-districts", config: { field: "name" } },
    });
    const runtime = new StudioInteractionRuntime({ controller });
    expect(runtime.compiled?.bindings).toEqual([]);

    controller.apply({
      name: "bindInteraction",
      interaction: {
        id: "late",
        on: { ref: "control:district", event: "change" },
        do: { ref: "layer:parcels", verb: "setFilter", args: { field: "district_id", value: "$event.value" } },
      },
    });
    runtime.publishControlChange("district", { field: "name", operator: "=", value: "HON" });
    await flush();

    expect(runtime.appearance.filters.parcels).toEqual(["==", ["get", "district_id"], "HON"]);
    runtime.dispose();
  });
});
