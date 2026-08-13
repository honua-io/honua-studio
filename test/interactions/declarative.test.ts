/**
 * The ADR-0030 compiler (honua-studio#25 REQ-002), and above all the rule the
 * whole design hangs on: **actions never emit events**.
 *
 * Three independent mechanisms are asserted separately, because each is a
 * different way the cycle could come back: the source discriminator, the
 * re-entrancy guard, and — in `studio-interactions.test.ts` — the structural
 * separation of the compiler's exploration view from the controls' one.
 */
import { createExplorationContext } from "@honua/sdk-js/exploration";
import type { ExplorationContext, ExplorationViewController } from "@honua/sdk-js/exploration";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompositionInteraction } from "../../src/composition/model.js";
import {
  INTERACTION_FANOUT_CAP,
  type StudioControlChangeEvent,
  type StudioInteractionComponents,
  compileStudioInteractions,
  parseInteractionRef,
  resolveInteractionArgs,
  validateInteractions,
} from "../../src/interactions/declarative.js";

let context: ExplorationContext | undefined;

function view(): ExplorationViewController {
  context = createExplorationContext({ datasetId: "test", sourceIds: ["src-parcels"] });
  return context.connectView({ id: "interactions", role: "custom" });
}

afterEach(() => {
  context?.dispose();
  context = undefined;
});

const setFilter = vi.fn();
const setVisibility = vi.fn();
const setViewport = vi.fn();

function components(): StudioInteractionComponents {
  return {
    map: { setViewport },
    layers: { parcels: { sourceId: "src-parcels", setFilter, setVisibility } },
    widgets: { grid: {} },
    controls: { district: {}, zoning: {} },
  };
}

function binding(overrides: Partial<CompositionInteraction> = {}): CompositionInteraction {
  return {
    id: "district-filters-parcels",
    on: { ref: "control:district", event: "change" },
    do: { ref: "layer:parcels", verb: "setFilter", args: { field: "district_id", value: "$event.value" } },
    ...overrides,
  } as CompositionInteraction;
}

function gesture(
  ref: string,
  value: unknown,
  source: StudioControlChangeEvent["source"] = "adapter",
): StudioControlChangeEvent {
  return {
    type: "change",
    ref,
    source,
    payload: {
      id: ref.slice("control:".length),
      field: "district",
      operator: "=",
      value,
      clause: { field: "district", operator: "=", value },
      filters: {},
    },
  };
}

describe("interactions/declarative", () => {
  afterEach(() => {
    setFilter.mockReset();
    setVisibility.mockReset();
    setViewport.mockReset();
  });

  describe("ref grammar", () => {
    it("parses the four ADR-0030 reference shapes and rejects everything else", () => {
      expect(parseInteractionRef("map")).toEqual({ kind: "map" });
      expect(parseInteractionRef("control:year-built")).toEqual({ kind: "control", id: "year-built" });
      expect(parseInteractionRef("layer:a:b")).toEqual({ kind: "layer", id: "a:b" });
      expect(parseInteractionRef("source:x")).toBeUndefined();
      expect(parseInteractionRef("control:")).toBeUndefined();
      expect(parseInteractionRef("")).toBeUndefined();
    });
  });

  describe("$event substitution", () => {
    it("is static JSON plus path reads — and nothing that resembles an expression language", () => {
      const payload = { value: "R-5", clause: { field: "zoning" } };
      expect(
        resolveInteractionArgs(
          { field: "zoning", value: "$event.value", nested: { f: "$event.clause.field" } },
          payload,
        ),
      ).toEqual({ field: "zoning", value: "R-5", nested: { f: "zoning" } });
    });

    it("resolves an unreachable path to undefined rather than throwing", () => {
      expect(resolveInteractionArgs({ v: "$event.a.b.c" }, {})).toEqual({ v: undefined });
    });
  });

  describe("validation", () => {
    it("accepts a well-formed control binding", () => {
      expect(validateInteractions([binding()], { components: components() })).toEqual([]);
    });

    it("rejects a change event on a non-control source — only controls emit change", () => {
      const issues = validateInteractions([binding({ on: { ref: "layer:parcels", event: "change" } })], {
        components: components(),
      });
      expect(issues.map((issue) => issue.code)).toContain("invalid-ref");
      expect(issues[0]?.message).toContain("control source");
    });

    it("rejects a ref that resolves to no declared component", () => {
      const issues = validateInteractions([binding({ on: { ref: "control:missing", event: "change" } })], {
        components: components(),
      });
      expect(issues[0]?.message).toContain("does not resolve");
    });

    it("rejects duplicate ids and out-of-vocabulary events/verbs", () => {
      const issues = validateInteractions(
        [
          binding(),
          binding(),
          binding({ id: "c", on: { ref: "control:district", event: "hover" } } as never),
          binding({ id: "d", do: { ref: "layer:parcels", verb: "deleteFeature" } } as never),
        ],
        { components: components() },
      );
      const codes = issues.map((issue) => issue.code);
      expect(codes).toContain("duplicate-id");
      expect(codes).toContain("unknown-event");
      expect(codes).toContain("unknown-verb");
    });

    it("rejects a document over the fan-out cap rather than truncating it", () => {
      const many = Array.from({ length: INTERACTION_FANOUT_CAP + 1 }, (_, index) => binding({ id: `b${index}` }));
      const issues = validateInteractions(many, { components: components() });
      expect(issues.map((issue) => issue.code)).toContain("fan-out-exceeded");
    });

    it("does not count a disabled binding against the cap", () => {
      const many = [
        ...Array.from({ length: INTERACTION_FANOUT_CAP }, (_, index) => binding({ id: `b${index}` })),
        binding({ id: "off", disabled: true }),
      ];
      expect(validateInteractions(many, { components: components() })).toEqual([]);
    });
  });

  describe("compile", () => {
    it("binds nothing at all when the document has an issue — a broken block is never half-applied", () => {
      const compiled = compileStudioInteractions({
        interactions: [binding({ on: { ref: "control:missing", event: "change" } })],
        view: view(),
        components: components(),
      });
      expect(compiled.ok).toBe(false);
      expect(compiled.bindings).toEqual([]);
      expect(compiled.dispatch(gesture("control:missing", "x"))).toEqual([]);
    });

    it("runs the bound verb on a gesture and rewrites the field the binding names", () => {
      const compiled = compileStudioInteractions({
        interactions: [binding()],
        view: view(),
        components: components(),
      });
      expect(compiled.ok).toBe(true);
      const records = compiled.dispatch(gesture("control:district", "HON"));
      expect(records.map((record) => record.verb)).toEqual(["setFilter"]);
      expect(setFilter).toHaveBeenCalledWith({ field: "district_id", operator: "=", value: "HON" });
      compiled.dispose();
    });

    it("passes the control's own clause through when the binding overrides nothing", () => {
      const compiled = compileStudioInteractions({
        interactions: [binding({ do: { ref: "layer:parcels", verb: "setFilter" } })],
        view: view(),
        components: components(),
      });
      compiled.dispatch(gesture("control:district", "HON"));
      expect(setFilter).toHaveBeenCalledWith({ field: "district", operator: "=", value: "HON" });
      compiled.dispose();
    });

    it("ignores a gesture from a control it does not bind", () => {
      const compiled = compileStudioInteractions({
        interactions: [binding()],
        view: view(),
        components: components(),
      });
      expect(compiled.dispatch(gesture("control:zoning", "R-5"))).toEqual([]);
      expect(setFilter).not.toHaveBeenCalled();
      compiled.dispose();
    });

    it("reports an uncompilable-but-valid binding instead of leaving it quietly inert", () => {
      const compiled = compileStudioInteractions({
        interactions: [
          binding({ id: "q", do: { ref: "widget:grid", verb: "runWidgetQuery" } }),
          binding({ id: "v", on: { ref: "map", event: "viewportChange" }, do: { ref: "map", verb: "setViewport" } }),
        ],
        view: view(),
        components: components(),
      });
      expect(compiled.ok).toBe(false);
      expect(compiled.bindings).toEqual([]);
      expect(compiled.unsupported.map((entry) => entry.interactionId).sort()).toEqual(["q", "v"]);
      // Each reason names the missing capability, not just "unsupported".
      expect(compiled.unsupported.find((entry) => entry.interactionId === "q")?.reason).toContain("no query verb");
      compiled.dispose();
    });

    it("lists a disabled binding rather than pretending it does not exist", () => {
      const compiled = compileStudioInteractions({
        interactions: [binding({ disabled: true })],
        view: view(),
        components: components(),
      });
      expect(compiled.disabled).toEqual(["district-filters-parcels"]);
      expect(compiled.dispatch(gesture("control:district", "HON"))).toEqual([]);
      compiled.dispose();
    });
  });

  describe("actions never emit events", () => {
    it("refuses an event tagged as action-driven (`controller`) — the source discriminator IS the rule", () => {
      const compiled = compileStudioInteractions({
        interactions: [binding()],
        view: view(),
        components: components(),
      });
      expect(compiled.dispatch(gesture("control:district", "HON", "controller"))).toEqual([]);
      expect(setFilter).not.toHaveBeenCalled();
      expect(compiled.refused[0]).toContain("actions never emit events");
      // …and the same gesture, correctly tagged, does run.
      expect(compiled.dispatch(gesture("control:district", "HON", "adapter"))).toHaveLength(1);
      compiled.dispose();
    });

    it("refuses a re-entrant event raised by a verb while that verb is running", () => {
      let compiled = undefined as ReturnType<typeof compileStudioInteractions> | undefined;
      const reentrant: StudioInteractionComponents = {
        ...components(),
        layers: {
          parcels: {
            sourceId: "src-parcels",
            setFilter: () => {
              // The action tries to feed a gesture straight back in.
              compiled?.dispatch(gesture("control:district", "LOOP"));
            },
          },
        },
      };
      compiled = compileStudioInteractions({ interactions: [binding()], view: view(), components: reentrant });
      const records = compiled.dispatch(gesture("control:district", "HON"));
      expect(records).toHaveLength(1);
      expect(compiled.refused.some((entry) => entry.includes("re-entrant"))).toBe(true);
      compiled.dispose();
    });
  });
});
