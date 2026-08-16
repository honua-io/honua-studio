import { describe, expect, it } from "vitest";

import { CompositionController } from "../../src/composition/controller.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import { createCompositionAgentRuntime, createStudioAiMapKit } from "../../src/map/agent-map-kit.js";
import type { CompositionSourceDescriptor } from "../../src/map/source-resolution.js";

const CATALOG: readonly CompositionSourceDescriptor[] = [
  { id: "hi-parcels", title: "Parcels", protocol: "ogc-features", geometryType: "Polygon" },
];

function setup() {
  const controller = new CompositionController(createEmptyCompositionState());
  return { controller, runtime: createCompositionAgentRuntime({ controller, catalog: CATALOG }) };
}

describe("createCompositionAgentRuntime (honua-studio#23 REQ-002)", () => {
  it("advertises only catalogued sources — the agent cannot invent data", async () => {
    const { runtime } = setup();
    expect(await runtime.listSources?.()).toEqual([
      { id: "hi-parcels", title: "Parcels", protocol: "ogc-features", metadata: { geometryType: "Polygon" } },
    ]);
  });

  it("reports composition layers and the composed viewport", async () => {
    const { controller, runtime } = setup();
    controller.apply({ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels", title: "Parcels" } });
    controller.apply({ name: "setView", view: { center: [-157.9, 21.4], zoom: 10 } });

    expect(await runtime.listLayers?.()).toEqual([
      { id: "hi-parcels", sourceId: "hi-parcels", visible: true, title: "Parcels" },
    ]);
    expect(await runtime.getViewport?.()).toEqual({ center: [-157.9, 21.4], zoom: 10 });
  });

  it("writes through the composition reducer, so history and undo still apply", async () => {
    const { controller, runtime } = setup();
    await runtime.addLayer?.({ id: "hi-parcels", sourceId: "hi-parcels" });
    await runtime.setViewport?.({ zoom: 12 });

    expect(controller.state.layers.map((layer) => layer.id)).toEqual(["hi-parcels"]);
    expect(controller.state.view.zoom).toBe(12);
    // Two applied commands => two undoable steps. If the runtime had written
    // to a parallel store this would be 0.
    expect(controller.undo()).toBe(true);
    expect(controller.state.view.zoom).toBeUndefined();
    expect(controller.undo()).toBe(true);
    expect(controller.state.layers).toEqual([]);
  });

  it("refuses a layer with no usable id rather than inventing one", async () => {
    const { runtime } = setup();
    await expect(async () => runtime.addLayer?.({ title: "nameless" })).rejects.toThrow(
      /requires a layer with a string id/,
    );
  });

  it("reports the ephemeral feature selection the canvas set, and only features", async () => {
    const { controller, runtime } = setup();
    controller.select([
      { kind: "layer", id: "hi-parcels" },
      { kind: "feature", sourceId: "hi-parcels", featureId: 7 },
    ]);
    expect(await runtime.getSelection?.()).toEqual([{ sourceId: "hi-parcels", id: 7 }]);
  });
});

describe("createStudioAiMapKit", () => {
  it("produces the SDK's tool definitions in Honua and MCP shapes", () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const kit = createStudioAiMapKit({ controller, catalog: CATALOG });
    expect(kit.tools.map((tool) => tool.name)).toContain("setViewport");
    expect(kit.mcpTools.every((tool) => typeof tool.inputSchema === "object")).toBe(true);
  });

  it("executes a tool call straight into composition state", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const kit = createStudioAiMapKit({ controller, catalog: CATALOG });
    const result = await kit.execute({ name: "setViewport", args: { zoom: 9 } });
    expect(result.status).toBe("ok");
    expect(controller.state.view.zoom).toBe(9);
  });

  it("honours the SDK's own policy surface instead of a Studio-private one", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const kit = createStudioAiMapKit({ controller, catalog: CATALOG, policy: { readOnly: true } });
    const result = await kit.execute({ name: "setViewport", args: { zoom: 9 } });
    expect(result.status).not.toBe("ok");
    expect(controller.state.view.zoom).toBeUndefined();
  });

  it("builds a capability-aware map context from the catalog and composition", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    controller.apply({ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } });
    const kit = createStudioAiMapKit({ controller, catalog: CATALOG });
    const context = await kit.context();
    expect(context.sources.map((source) => source.id)).toEqual(["hi-parcels"]);
    expect(context.layers.map((layer) => layer.id)).toEqual(["hi-parcels"]);
  });
});
