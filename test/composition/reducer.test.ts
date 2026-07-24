import { describe, expect, it } from "vitest";

import type { CompositionCommand } from "../../src/composition/commands.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import {
  type CompositionCommandError,
  applyCompositionCommand,
  applyCompositionCommands,
  isCompositionCommandError,
  isPinViolation,
  isPinned,
  resolveCompositionTarget,
} from "../../src/composition/reducer.js";

function cmd(command: CompositionCommand): CompositionCommand {
  return command;
}

describe("composition/reducer applyCompositionCommand", () => {
  it("addLayer appends a layer with defaulted visible:true and produces an 'add' diff", () => {
    const state = createEmptyCompositionState();
    const { state: next, diff } = applyCompositionCommand(
      state,
      cmd({ name: "addLayer", layer: { id: "roads", sourceId: "src-roads" } }),
    );
    expect(next.layers).toEqual([{ id: "roads", sourceId: "src-roads", visible: true }]);
    expect(diff.changes).toEqual([{ path: "layers[roads]", kind: "add", after: next.layers[0] }]);
    // Purity: the input state is never mutated.
    expect(state.layers).toEqual([]);
  });

  it("addLayer with beforeId inserts before the named layer", () => {
    let state = createEmptyCompositionState();
    state = applyCompositionCommand(state, cmd({ name: "addLayer", layer: { id: "a", sourceId: "s" } })).state;
    state = applyCompositionCommand(state, cmd({ name: "addLayer", layer: { id: "b", sourceId: "s" } })).state;
    const { state: next } = applyCompositionCommand(
      state,
      cmd({ name: "addLayer", layer: { id: "c", sourceId: "s" }, beforeId: "b" }),
    );
    expect(next.layers.map((layer) => layer.id)).toEqual(["a", "c", "b"]);
  });

  it("addLayer rejects a duplicate id with a typed duplicate-id error", () => {
    const state = applyCompositionCommand(
      createEmptyCompositionState(),
      cmd({ name: "addLayer", layer: { id: "roads", sourceId: "s" } }),
    ).state;
    try {
      applyCompositionCommand(state, cmd({ name: "addLayer", layer: { id: "roads", sourceId: "s2" } }));
      expect.unreachable("expected duplicate-id rejection");
    } catch (error) {
      expect(isCompositionCommandError(error)).toBe(true);
      expect((error as CompositionCommandError).code).toBe("duplicate-id");
    }
  });

  it("addLayer rejects an out-of-bounds beforeId", () => {
    expect(() =>
      applyCompositionCommand(
        createEmptyCompositionState(),
        cmd({ name: "addLayer", layer: { id: "a", sourceId: "s" }, beforeId: "ghost" }),
      ),
    ).toThrowError(/out of bounds|does not exist/);
  });

  it("removeLayer on a missing layer throws target-not-found", () => {
    try {
      applyCompositionCommand(
        createEmptyCompositionState(),
        cmd({ name: "removeLayer", target: { kind: "layer", id: "x" } }),
      );
      expect.unreachable("expected target-not-found");
    } catch (error) {
      expect((error as CompositionCommandError).code).toBe("target-not-found");
    }
  });

  it("removeLayer rejects a mismatched target kind as invalid-command", () => {
    let state = createEmptyCompositionState();
    state = applyCompositionCommand(state, cmd({ name: "addLayer", layer: { id: "roads", sourceId: "s" } })).state;
    try {
      applyCompositionCommand(state, cmd({ name: "removeLayer", target: { kind: "component", id: "roads" } }));
      expect.unreachable("expected invalid-command");
    } catch (error) {
      expect((error as CompositionCommandError).code).toBe("invalid-command");
    }
  });

  it("setView merges partial fields and preserves untouched ones", () => {
    let state = createEmptyCompositionState();
    state = applyCompositionCommand(state, cmd({ name: "setView", view: { zoom: 10, center: [1, 2] } })).state;
    state = applyCompositionCommand(state, cmd({ name: "setView", view: { zoom: 12 } })).state;
    expect(state.view).toEqual({ zoom: 12, center: [1, 2] });
  });

  it("setView rejects out-of-bounds zoom/pitch/bearing", () => {
    for (const view of [{ zoom: 25 }, { zoom: -1 }, { pitch: 90 }, { bearing: 360 }, { bearing: -1 }]) {
      try {
        applyCompositionCommand(createEmptyCompositionState(), cmd({ name: "setView", view }));
        expect.unreachable(`expected out-of-bounds rejection for ${JSON.stringify(view)}`);
      } catch (error) {
        expect((error as CompositionCommandError).code).toBe("out-of-bounds");
      }
    }
  });

  it("addWidget / removeWidget round-trip", () => {
    let state = createEmptyCompositionState();
    state = applyCompositionCommand(
      state,
      cmd({ name: "addWidget", widget: { id: "chart-1", kind: "chart", sourceId: "src" } }),
    ).state;
    expect(state.widgets).toHaveLength(1);
    state = applyCompositionCommand(
      state,
      cmd({ name: "removeWidget", target: { kind: "component", id: "chart-1" } }),
    ).state;
    expect(state.widgets).toHaveLength(0);
  });

  it("addAnnotation / removeAnnotation round-trip (annotations-as-targets)", () => {
    let state = createEmptyCompositionState();
    state = applyCompositionCommand(
      state,
      cmd({ name: "addAnnotation", annotation: { id: "r1", kind: "region", bbox: [0, 0, 1, 1] } }),
    ).state;
    expect(resolveCompositionTarget(state, { kind: "region", id: "r1" }).exists).toBe(true);
    state = applyCompositionCommand(
      state,
      cmd({ name: "removeAnnotation", target: { kind: "region", id: "r1" } }),
    ).state;
    expect(resolveCompositionTarget(state, { kind: "region", id: "r1" }).exists).toBe(false);
  });

  describe("pin enforcement", () => {
    it("pinning a non-existent layer throws target-not-found", () => {
      try {
        applyCompositionCommand(
          createEmptyCompositionState(),
          cmd({ name: "pin", target: { kind: "layer", id: "x" } }),
        );
        expect.unreachable("expected target-not-found");
      } catch (error) {
        expect((error as CompositionCommandError).code).toBe("target-not-found");
      }
    });

    it("a command touching a pinned layer fails with pin-violation", () => {
      let state = createEmptyCompositionState();
      state = applyCompositionCommand(state, cmd({ name: "addLayer", layer: { id: "roads", sourceId: "s" } })).state;
      state = applyCompositionCommand(state, cmd({ name: "pin", target: { kind: "layer", id: "roads" } })).state;
      expect(isPinned(state, { kind: "layer", id: "roads" })).toBe(true);

      try {
        applyCompositionCommand(state, cmd({ name: "removeLayer", target: { kind: "layer", id: "roads" } }));
        expect.unreachable("expected pin-violation");
      } catch (error) {
        expect(isPinViolation(error)).toBe(true);
      }

      try {
        applyCompositionCommand(
          state,
          cmd({
            name: "setLayerStyleRef",
            target: { kind: "layer", id: "roads" },
            styleRef: { kind: "style-ref", styleId: "s1" },
          }),
        );
        expect.unreachable("expected pin-violation");
      } catch (error) {
        expect(isPinViolation(error)).toBe(true);
      }
    });

    it("unpinning first, in the same batch, allows the mutation to proceed", () => {
      let state = createEmptyCompositionState();
      state = applyCompositionCommand(state, cmd({ name: "addLayer", layer: { id: "roads", sourceId: "s" } })).state;
      state = applyCompositionCommand(state, cmd({ name: "pin", target: { kind: "layer", id: "roads" } })).state;

      const { state: next, diffs } = applyCompositionCommands(state, [
        cmd({ name: "unpin", target: { kind: "layer", id: "roads" } }),
        cmd({ name: "removeLayer", target: { kind: "layer", id: "roads" } }),
      ]);
      expect(next.layers).toHaveLength(0);
      expect(next.pins).toHaveLength(0);
      expect(diffs).toHaveLength(2);
    });

    it("pin is idempotent; unpin of a non-pinned target is a no-op, not an error", () => {
      let state = createEmptyCompositionState();
      state = applyCompositionCommand(state, cmd({ name: "addLayer", layer: { id: "roads", sourceId: "s" } })).state;
      state = applyCompositionCommand(state, cmd({ name: "pin", target: { kind: "layer", id: "roads" } })).state;
      const { state: samePinTwice } = applyCompositionCommand(
        state,
        cmd({ name: "pin", target: { kind: "layer", id: "roads" } }),
      );
      expect(samePinTwice.pins).toHaveLength(1);

      const { state: afterNoOpUnpin } = applyCompositionCommand(
        createEmptyCompositionState(),
        cmd({ name: "addLayer", layer: { id: "x", sourceId: "s" } }),
      );
      const { state: unpinNoOp } = applyCompositionCommand(
        afterNoOpUnpin,
        cmd({ name: "unpin", target: { kind: "layer", id: "x" } }),
      );
      expect(unpinNoOp.pins).toHaveLength(0);
    });

    it("a feature target can be pinned without existing in composition state (structural resolution)", () => {
      const { state } = applyCompositionCommand(
        createEmptyCompositionState(),
        cmd({ name: "pin", target: { kind: "feature", sourceId: "parcels", featureId: 7 } }),
      );
      expect(isPinned(state, { kind: "feature", sourceId: "parcels", featureId: 7 })).toBe(true);
    });
  });

  describe("deictic target resolution", () => {
    it("resolves layer/component/region targets against their matching collection", () => {
      let state = createEmptyCompositionState();
      state = applyCompositionCommand(state, cmd({ name: "addLayer", layer: { id: "roads", sourceId: "s" } })).state;
      state = applyCompositionCommand(
        state,
        cmd({ name: "addWidget", widget: { id: "chart-1", kind: "chart" } }),
      ).state;
      state = applyCompositionCommand(
        state,
        cmd({ name: "addAnnotation", annotation: { id: "r1", kind: "region", bbox: [0, 0, 1, 1] } }),
      ).state;

      expect(resolveCompositionTarget(state, { kind: "layer", id: "roads" }).exists).toBe(true);
      expect(resolveCompositionTarget(state, { kind: "component", id: "chart-1" }).exists).toBe(true);
      expect(resolveCompositionTarget(state, { kind: "region", id: "r1" }).exists).toBe(true);
      expect(resolveCompositionTarget(state, { kind: "layer", id: "ghost" }).exists).toBe(false);
    });

    it("a feature target always resolves 'exists: true' structurally (composition state does not track features)", () => {
      const state = createEmptyCompositionState();
      const resolution = resolveCompositionTarget(state, { kind: "feature", sourceId: "parcels", featureId: "abc" });
      expect(resolution.exists).toBe(true);
      expect(resolution.pinned).toBe(false);
    });
  });

  describe("diff shape", () => {
    it("replace diffs carry both before and after for the same path", () => {
      let state = createEmptyCompositionState();
      state = applyCompositionCommand(
        state,
        cmd({ name: "addLayer", layer: { id: "roads", sourceId: "s", visible: true } }),
      ).state;
      const { diff } = applyCompositionCommand(
        state,
        cmd({
          name: "setLayerStyleRef",
          target: { kind: "layer", id: "roads" },
          styleRef: { kind: "style-ref", styleId: "style-1" },
        }),
      );
      expect(diff.changes).toHaveLength(1);
      expect(diff.changes[0]?.kind).toBe("replace");
      expect(diff.changes[0]?.path).toBe("layers[roads]");
      expect((diff.changes[0]?.before as { styleRef?: unknown }).styleRef).toBeUndefined();
      expect((diff.changes[0]?.after as { styleRef?: unknown }).styleRef).toEqual({
        kind: "style-ref",
        styleId: "style-1",
      });
    });

    it("a no-op command (idempotent unpin) produces an empty diff", () => {
      const { diff } = applyCompositionCommand(
        createEmptyCompositionState(),
        cmd({ name: "unpin", target: { kind: "layer", id: "ghost" } }),
      );
      expect(diff.changes).toEqual([]);
    });

    it("setView diffs use view.<field> paths", () => {
      const { diff } = applyCompositionCommand(
        createEmptyCompositionState(),
        cmd({ name: "setView", view: { zoom: 5 } }),
      );
      expect(diff.changes).toEqual([{ path: "view.zoom", kind: "add", after: 5 }]);
    });
  });

  describe("invalid input", () => {
    it("an unknown command name throws invalid-command with collected validation errors", () => {
      try {
        applyCompositionCommand(createEmptyCompositionState(), { name: "notARealCommand" });
        expect.unreachable("expected invalid-command");
      } catch (error) {
        expect((error as CompositionCommandError).code).toBe("invalid-command");
        expect((error as CompositionCommandError).details.length).toBeGreaterThan(0);
      }
    });
  });
});
