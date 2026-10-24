import { describe, expect, it } from "vitest";
import { CompositionController } from "../../src/composition/controller.js";
import { designConnections, designConsumers, designRemovalImpact } from "../../src/design/design-inventory.js";
import { StudioInteractionRuntime } from "../../src/interactions/studio-interactions.js";
import { designFixture } from "./design-fixture.js";

describe("design inventory", () => {
  it("uses normalized widget/control fields and canonical styles, retaining exact source identities", () => {
    const consumers = designConsumers(designFixture());
    expect(consumers.find((entry) => entry.ref === "widget:table")).toMatchObject({
      sourceId: "source-a",
      fields: ["name", "missing", "id", "category"],
    });
    expect(consumers.find((entry) => entry.ref === "widget:chart")?.fields).toEqual(["category", "amount"]);
    expect(consumers.find((entry) => entry.ref === "control:filter")?.fields).toEqual(["category"]);
    expect(
      consumers.filter((entry) => entry.title === "Places").map((entry) => [entry.ref, entry.sourceId, entry.fields]),
    ).toEqual([
      ["layer:places", "source-a", ["amount", "category"]],
      ["layer:elsewhere", "source-b", ["other"]],
    ]);
  });

  it("does not resolve an ambiguous source alias by choosing an arbitrary layer", () => {
    const state = designFixture();
    const ambiguous = { ...state, layers: [...state.layers, { id: "collision", sourceId: "places", visible: true }] };
    expect(designConsumers(ambiguous).find((entry) => entry.ref === "widget:table")?.sourceId).toBeUndefined();
  });

  it("reads legacy filters and inferred table columns without treating literal paint arrays as fields", () => {
    const state = designFixture();
    const consumers = designConsumers(
      {
        ...state,
        widgets: [{ id: "inferred", kind: "table", sourceId: "source-a" }],
        mapSpec: {
          ...state.mapSpec,
          layers: [
            {
              id: "places",
              filter: ["all", ["==", "legacy_zone", "A"], ["in", "district", "One", "Two"]],
              paint: { "circle-color": ["literal", ["get", "not_a_field"]] },
              metadata: { ignored: ["get", "not_a_rendered_field"] },
            },
          ],
        },
      },
      { inferred: ["actual_loaded_column"] },
    );
    expect(consumers.find((entry) => entry.ref === "layer:places")?.fields).toEqual([
      "legacy_zone",
      "district",
      "category",
    ]);
    expect(consumers.find((entry) => entry.ref === "widget:inferred")?.fields).toEqual([
      "actual_loaded_column",
      "category",
    ]);
  });

  it("keeps authored relationship identity separate from a colliding intrinsic display identifier", () => {
    const state = designFixture();
    const collision = "intrinsic:filter:layer:places";
    const controller = new CompositionController({
      ...state,
      interactions: [{ ...state.interactions[0]!, id: collision }],
    });
    const runtime = new StudioInteractionRuntime({ controller });
    try {
      const rows = designConnections(controller.state, runtime.compiled).filter((entry) => entry.id === collision);
      expect(rows).toHaveLength(2);
      expect(rows.find((entry) => entry.origin === "authored")?.authoredInteractionId).toBe(collision);
      expect(rows.find((entry) => entry.origin === "intrinsic")?.authoredInteractionId).toBeUndefined();
    } finally {
      runtime.dispose();
    }
  });

  it("discloses dynamic style field references rather than presenting their inventory as complete", () => {
    const state = designFixture();
    const consumers = designConsumers({
      ...state,
      mapSpec: {
        ...state.mapSpec,
        layers: [{ id: "places", paint: { "circle-radius": ["get", ["concat", "field_", ["get", "selector"]]] } }],
      },
    });
    expect(consumers.find((entry) => entry.ref === "layer:places")).toMatchObject({
      fields: ["selector", "category"],
      note: expect.stringContaining("Dynamic field references are unresolved"),
    });
  });

  it("agrees with the executing runtime and exposes the actual unsupported denominator", () => {
    const controller = new CompositionController(designFixture());
    const runtime = new StudioInteractionRuntime({ controller });
    try {
      expect(
        designConnections(controller.state, runtime.compiled)
          .filter((entry) => !entry.id.startsWith("intrinsic:"))
          .map((entry) => [entry.id, entry.status]),
      ).toEqual([
        ["hide", "supported"],
        ["query", "unsupported"],
        ["disabled", "disabled"],
      ]);
      expect(
        designConnections(controller.state, runtime.compiled)
          .filter((entry) => entry.id.startsWith("intrinsic:filter:"))
          .map((entry) => entry.to),
      ).toEqual(["layer:places", "widget:table", "widget:chart"]);
      runtime.publishControlChange("filter", { field: "category", operator: "=", value: "B" });
      expect(controller.state.layers.find((entry) => entry.id === "places")?.visible).toBe(false);
      expect(runtime.appearance.sourceFilters?.["source-a"]).toEqual([
        { field: "category", operator: "=", value: "B" },
      ]);
      const authored = controller.state.mapSpec;
      runtime.resetTemporaryFilters();
      expect(runtime.temporaryFilterSummary()).toEqual([]);
      expect(controller.state.mapSpec).toBe(authored);
      expect(controller.state.interactions).toHaveLength(3);
    } finally {
      runtime.dispose();
    }
  });

  it("reports compiler validation as an unresolved block and does not pretend retained refs execute", () => {
    const controller = new CompositionController(designFixture());
    const runtime = new StudioInteractionRuntime({ controller });
    try {
      expect(designRemovalImpact(controller.state, "control:filter")).toEqual([
        "interaction:hide",
        "interaction:query",
        "interaction:disabled",
      ]);
      expect(() => controller.apply({ name: "removeControl", target: { kind: "control", id: "filter" } })).toThrow(
        /referenced/,
      );
      expect(designRemovalImpact(controller.state, "layer:places")).toEqual(
        expect.arrayContaining([
          "interaction:hide",
          "interaction:disabled",
          "widget:table",
          "widget:chart",
          "control:filter",
          "widget:compare",
        ]),
      );
      controller.apply({ name: "removeLayer", target: { kind: "layer", id: "places" } });
      expect(designConnections(controller.state, runtime.compiled).find((entry) => entry.id === "hide")).toMatchObject({
        status: "unresolved",
        reason: expect.stringContaining("No bindings installed"),
      });
      expect(controller.state.interactions).toHaveLength(3);
    } finally {
      runtime.dispose();
    }
  });

  it("does not advertise unconsumed compiler fallbacks as working widget filters", () => {
    const state = designFixture();
    const controller = new CompositionController({
      ...state,
      interactions: [
        {
          id: "fallback",
          on: { ref: "control:filter", event: "change" },
          do: { ref: "widget:chart", verb: "setFilter", args: { filter: "$event.filter" } },
        },
      ],
    });
    const runtime = new StudioInteractionRuntime({ controller });
    try {
      expect(
        designConnections(controller.state, runtime.compiled).find((entry) => entry.id === "fallback"),
      ).toMatchObject({ status: "unsupported", reason: expect.stringContaining("no filter consumer") });
    } finally {
      runtime.dispose();
    }
  });

  it("does not claim raw-source widgets depend on a visual layer when no filter connection changes", () => {
    const state = designFixture();
    const impact = designRemovalImpact({ ...state, controls: [], interactions: [] }, "layer:places");
    expect(impact).toContain("widget:table");
    expect(impact).toContain("widget:compare");
    expect(impact).not.toContain("widget:chart");
  });
});
