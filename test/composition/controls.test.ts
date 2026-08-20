/**
 * The `controls` collection in the composition model and the bounded command
 * set (honua-studio#25), mirroring what `set-visibility.test.ts` did for
 * honua-studio#24.
 *
 * The load-bearing case is `removeControl`'s dangling-binding obligation:
 * ADR-0031 rules out exactly one outcome — silently retaining an unresolvable
 * `control:{id}` reference — so the reducer must be unable to produce it.
 */
import { describe, expect, it } from "vitest";

import { validateCompositionCommand } from "../../src/composition/commands.js";
import {
  canonicalCompositionJson,
  compositionTargetKey,
  createEmptyCompositionState,
  interactionsReferencingControl,
} from "../../src/composition/model.js";
import { applyCompositionCommand, isCompositionCommandError } from "../../src/composition/reducer.js";
import { applyStudioDraftBody, resolveToolCall, toStudioCompositionBody } from "../../src/mcp/tool-bridge.js";

const YEAR_FILTER = {
  id: "year-built-filter",
  kind: "filterSelect",
  title: "Year built",
  sourceId: "parcels",
  config: { field: "yearBuilt" },
} as const;

const BINDING = {
  id: "year-filters-parcels",
  on: { ref: "control:year-built-filter", event: "change" },
  do: { ref: "layer:parcels", verb: "setFilter", args: { field: "yearBuilt", value: "$event.value" } },
} as const;

function withControlAndBinding() {
  let state = applyCompositionCommand(createEmptyCompositionState(), {
    name: "addControl",
    control: YEAR_FILTER,
  }).state;
  state = applyCompositionCommand(state, { name: "bindInteraction", interaction: BINDING }).state;
  return state;
}

describe("composition/controls", () => {
  it("renders a control target as the ADR-0030 reference string itself", () => {
    expect(compositionTargetKey({ kind: "control", id: "year-built-filter" })).toBe("control:year-built-filter");
  });

  it("admits only the closed 14-kind vocabulary", () => {
    expect(validateCompositionCommand({ name: "addControl", control: { id: "d", kind: "draw" } }).ok).toBe(false);
    expect(validateCompositionCommand({ name: "addControl", control: { id: "e", kind: "edit" } }).ok).toBe(false);
    expect(validateCompositionCommand({ name: "addControl", control: { id: "n", kind: "navigation" } }).ok).toBe(true);
  });

  it("rejects a blank sourceId while leaving it optional (presentation-only kinds omit it)", () => {
    expect(
      validateCompositionCommand({ name: "addControl", control: { id: "n", kind: "scale", sourceId: "" } }).ok,
    ).toBe(false);
    expect(validateCompositionCommand({ name: "addControl", control: { id: "n", kind: "scale" } }).ok).toBe(true);
  });

  it("adds a control, diffs it under its own path, and refuses a duplicate id", () => {
    const result = applyCompositionCommand(createEmptyCompositionState(), {
      name: "addControl",
      control: YEAR_FILTER,
    });
    expect(result.state.controls).toHaveLength(1);
    expect(result.diff.changes.map((change) => change.path)).toEqual(["controls[year-built-filter]"]);
    expect(() => applyCompositionCommand(result.state, { name: "addControl", control: YEAR_FILTER })).toThrowError(
      /already exists/,
    );
  });

  it("keeps controls out of the widgets collection — a control is a peer of a widget, not a kind of one", () => {
    const state = applyCompositionCommand(createEmptyCompositionState(), {
      name: "addControl",
      control: YEAR_FILTER,
    }).state;
    expect(state.widgets).toEqual([]);
    expect(validateCompositionCommand({ name: "addWidget", widget: { id: "x", kind: "filterSelect" } }).ok).toBe(false);
  });

  it("binds an interaction add-or-replace by id rather than erroring on a re-bind", () => {
    let state = withControlAndBinding();
    expect(state.interactions).toHaveLength(1);
    state = applyCompositionCommand(state, {
      name: "bindInteraction",
      interaction: { ...BINDING, disabled: true },
    }).state;
    expect(state.interactions).toHaveLength(1);
    expect(state.interactions[0]?.disabled).toBe(true);
  });

  it("validates the ADR-0030 reference grammar and the closed event/verb sets", () => {
    const bad = validateCompositionCommand({
      name: "bindInteraction",
      interaction: { id: "b", on: { ref: "source:x", event: "poke" }, do: { ref: "map", verb: "deleteFeature" } },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.some((error) => error.includes("on.ref"))).toBe(true);
      expect(bad.errors.some((error) => error.includes("on.event"))).toBe(true);
      expect(bad.errors.some((error) => error.includes("do.verb"))).toBe(true);
    }
  });

  describe("removeControl", () => {
    it("removes a control nothing references", () => {
      const state = applyCompositionCommand(createEmptyCompositionState(), {
        name: "addControl",
        control: YEAR_FILTER,
      }).state;
      const removed = applyCompositionCommand(state, {
        name: "removeControl",
        target: { kind: "control", id: YEAR_FILTER.id },
      });
      expect(removed.state.controls).toEqual([]);
    });

    it("REFUSES by default while a binding references it, naming the offending binding", () => {
      const state = withControlAndBinding();
      expect(interactionsReferencingControl(state, YEAR_FILTER.id).map((entry) => entry.id)).toEqual([BINDING.id]);
      try {
        applyCompositionCommand(state, { name: "removeControl", target: { kind: "control", id: YEAR_FILTER.id } });
        throw new Error("expected the removal to be refused");
      } catch (error) {
        expect(isCompositionCommandError(error)).toBe(true);
        if (isCompositionCommandError(error)) {
          expect(error.code).toBe("interaction-conflict");
          expect(error.message).toContain(BINDING.id);
          expect(error.message).toContain("cascadeInteractions");
          expect(error.details).toEqual([BINDING.id]);
        }
      }
    });

    it("removes the dependent bindings with the control when cascadeInteractions is true", () => {
      const state = withControlAndBinding();
      const removed = applyCompositionCommand(state, {
        name: "removeControl",
        target: { kind: "control", id: YEAR_FILTER.id },
        cascadeInteractions: true,
      });
      expect(removed.state.controls).toEqual([]);
      expect(removed.state.interactions).toEqual([]);
      // Both removals are diffed — the cascade is visible, not a side effect.
      expect(removed.diff.changes.map((change) => change.path).sort()).toEqual([
        `controls[${YEAR_FILTER.id}]`,
        `interactions[${BINDING.id}]`,
      ]);
    });

    it("also refuses when only the ACTION half references the control", () => {
      let state = applyCompositionCommand(createEmptyCompositionState(), {
        name: "addControl",
        control: { id: "toggle", kind: "opacity", sourceId: "parcels" },
      }).state;
      state = applyCompositionCommand(state, {
        name: "addControl",
        control: { id: "picker", kind: "filterSelect", config: { field: "f" } },
      }).state;
      state = applyCompositionCommand(state, {
        name: "bindInteraction",
        interaction: {
          id: "hide-the-toggle",
          on: { ref: "control:picker", event: "change" },
          do: { ref: "control:toggle", verb: "setVisibility" },
        },
      }).state;
      expect(() =>
        applyCompositionCommand(state, { name: "removeControl", target: { kind: "control", id: "toggle" } }),
      ).toThrowError(/hide-the-toggle/);
    });

    it("refuses a target of the wrong kind rather than removing the wrong thing", () => {
      const state = withControlAndBinding();
      expect(() =>
        applyCompositionCommand(state, { name: "removeControl", target: { kind: "component", id: YEAR_FILTER.id } }),
      ).toThrowError(/must be kind "control"/);
    });

    it("honours a pin on a control, like every other pinned target", () => {
      let state = applyCompositionCommand(createEmptyCompositionState(), {
        name: "addControl",
        control: YEAR_FILTER,
      }).state;
      state = applyCompositionCommand(state, { name: "pin", target: { kind: "control", id: YEAR_FILTER.id } }).state;
      expect(() =>
        applyCompositionCommand(state, { name: "removeControl", target: { kind: "control", id: YEAR_FILTER.id } }),
      ).toThrowError(/pinned/);
    });
  });

  describe("server wire round-trip", () => {
    it("omits both blocks entirely when the composition holds none — the server keeps them nullable", () => {
      const body = toStudioCompositionBody(createEmptyCompositionState());
      expect("controls" in body).toBe(false);
      expect("interactions" in body).toBe(false);
    });

    it("round-trips a control and a binding through the draft body unchanged", () => {
      const state = withControlAndBinding();
      const body = toStudioCompositionBody(state);
      const restored = applyStudioDraftBody(body, createEmptyCompositionState());
      expect(canonicalCompositionJson(restored.controls)).toBe(canonicalCompositionJson(state.controls));
      expect(canonicalCompositionJson(restored.interactions)).toBe(canonicalCompositionJson(state.interactions));
    });

    it("treats an absent block as unset, never as a clear — a pre-#3196 draft must not wipe local controls", () => {
      const state = withControlAndBinding();
      const restored = applyStudioDraftBody({ layers: [], view: {}, widgets: [] }, state);
      expect(restored.controls).toHaveLength(1);
      expect(restored.interactions).toHaveLength(1);
    });

    it("interprets an inbound honua_studio_add_control / remove_control call", () => {
      const added = resolveToolCall({ toolName: "honua_studio_add_control", arguments: { control: YEAR_FILTER } });
      expect(added.ok).toBe(true);
      if (added.ok) expect(added.command).toEqual({ name: "addControl", control: YEAR_FILTER });

      const removed = resolveToolCall({
        toolName: "honua_studio_remove_control",
        arguments: { controlId: YEAR_FILTER.id, cascadeInteractions: true },
      });
      expect(removed.ok).toBe(true);
      if (removed.ok) {
        expect(removed.command).toEqual({
          name: "removeControl",
          target: { kind: "control", id: YEAR_FILTER.id },
          cascadeInteractions: true,
        });
        expect(removed.serverToolName).toBe("honua_studio_remove_control");
      }
    });
  });
});
