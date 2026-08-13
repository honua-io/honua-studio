/**
 * honua-studio#24's additions to the bounded vocabulary: the `setVisibility`
 * command (REQ-003) and the `toc` widget kind (REQ-002).
 *
 * The point of these tests is not that a boolean gets written — it is that
 * the TOC's *intrinsic* toggle has no privileged path. It is a command, so it
 * is structurally validated, semantically resolved, pin-enforced, diffed, and
 * undoable exactly like `addLayer` is. A chrome control that mutated state
 * directly would pass a rendering test and fail every one of these.
 */
import { describe, expect, it } from "vitest";

import { COMPOSITION_COMMAND_NAMES, validateCompositionCommand } from "../../src/composition/commands.js";
import { CompositionController } from "../../src/composition/controller.js";
import { COMPOSITION_WIDGET_KINDS, createEmptyCompositionState } from "../../src/composition/model.js";
import { applyCompositionCommand, isPinViolation } from "../../src/composition/reducer.js";

function stateWithLayers() {
  const { state } = applyCompositionCommand(
    applyCompositionCommand(createEmptyCompositionState(), {
      name: "addLayer",
      layer: { id: "parcels", sourceId: "hi-parcels", title: "Parcels" },
    }).state,
    { name: "addLayer", layer: { id: "roads", sourceId: "hi-roads", visible: false } },
  );
  return state;
}

describe("composition/commands: setVisibility (honua-studio#24 REQ-003)", () => {
  it("is part of the bounded command set", () => {
    expect(COMPOSITION_COMMAND_NAMES).toContain("setVisibility");
  });

  it("validates a well-formed command", () => {
    const result = validateCompositionCommand({
      name: "setVisibility",
      target: { kind: "layer", id: "parcels" },
      visible: false,
    });
    expect(result).toEqual({
      ok: true,
      command: { name: "setVisibility", target: { kind: "layer", id: "parcels" }, visible: false },
    });
  });

  it("rejects a missing or non-boolean visible, reporting every problem at once", () => {
    const result = validateCompositionCommand({ name: "setVisibility", target: { kind: "nope" }, visible: "yes" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(2);
    expect(result.errors.join(" ")).toContain("setVisibility.visible must be a boolean");
  });
});

describe("composition/reducer: setVisibility", () => {
  it("flips a layer's visibility and diffs it as a replace", () => {
    const { state, diff } = applyCompositionCommand(stateWithLayers(), {
      name: "setVisibility",
      target: { kind: "layer", id: "parcels" },
      visible: false,
    });
    expect(state.layers.find((layer) => layer.id === "parcels")?.visible).toBe(false);
    // The other layer is untouched — a toggle must not disturb the rest of the
    // composition, which is what makes the map's style diff minimal.
    expect(state.layers.find((layer) => layer.id === "roads")?.visible).toBe(false);
    expect(diff.changes).toEqual([expect.objectContaining({ path: "layers[parcels]", kind: "replace" })]);
  });

  it("is a no-op (no diff) when the layer already has that visibility", () => {
    const { diff } = applyCompositionCommand(stateWithLayers(), {
      name: "setVisibility",
      target: { kind: "layer", id: "parcels" },
      visible: true,
    });
    expect(diff.changes).toEqual([]);
  });

  it("refuses a pinned layer — the pin holds against chrome, not just against the agent", () => {
    const { state } = applyCompositionCommand(stateWithLayers(), {
      name: "pin",
      target: { kind: "layer", id: "parcels" },
    });
    let thrown: unknown;
    try {
      applyCompositionCommand(state, {
        name: "setVisibility",
        target: { kind: "layer", id: "parcels" },
        visible: false,
      });
    } catch (error) {
      thrown = error;
    }
    expect(isPinViolation(thrown)).toBe(true);
  });

  it("refuses an unknown layer and a non-layer target", () => {
    expect(() =>
      applyCompositionCommand(stateWithLayers(), {
        name: "setVisibility",
        target: { kind: "layer", id: "ghost" },
        visible: false,
      }),
    ).toThrow(/does not exist/);
    expect(() =>
      applyCompositionCommand(stateWithLayers(), {
        name: "setVisibility",
        target: { kind: "component", id: "parcels" },
        visible: false,
      }),
    ).toThrow(/must be kind "layer"/);
  });

  it("undoes through history like any other command", () => {
    const controller = new CompositionController(stateWithLayers());
    controller.apply({ name: "setVisibility", target: { kind: "layer", id: "parcels" }, visible: false });
    expect(controller.state.layers[0]?.visible).toBe(false);
    expect(controller.undo()).toBe(true);
    expect(controller.state.layers[0]?.visible).toBe(true);
  });
});

describe("composition/model: the toc widget kind (honua-studio#24 REQ-002)", () => {
  it("is in the bounded widget vocabulary", () => {
    expect(COMPOSITION_WIDGET_KINDS).toEqual(["table", "chart", "compare", "time", "legend", "toc"]);
  });

  it("addWidget accepts it with no config at all — a layer list needs no authoring", () => {
    const result = validateCompositionCommand({ name: "addWidget", widget: { id: "layers", kind: "toc" } });
    expect(result.ok).toBe(true);
  });

  it("still rejects a kind outside the vocabulary", () => {
    const result = validateCompositionCommand({ name: "addWidget", widget: { id: "x", kind: "scatter" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("toc");
  });
});
