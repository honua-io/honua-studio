/**
 * The ADR-0030 compiler (honua-studio#25 REQ-002) as Studio now consumes it:
 * `compileHonuaInteractions` from `@honua/sdk-js/interactions/declarative`,
 * driven through the component registry shape
 * `../../src/interactions/studio-interactions.ts` hands it.
 *
 * This suite is not a re-test of the SDK's own unit suite. It pins the four
 * properties Studio depends on and would regress silently without:
 *
 *  1. a malformed or over-cap block binds **nothing**;
 *  2. a real control gesture runs the bound verb through Studio's adapters,
 *     with `$event.*` substitution and the binding's field rewrite;
 *  3. **actions never emit events** — a verb's own write does not re-enter
 *     the compiler, which is why the compiler gets a view of its own;
 *  4. a binding the runtime cannot honor is *named* in `unsupported`, never
 *     quietly inert.
 *
 * Every gesture here travels the same way it does in the app: one
 * `FilterClause` published on a *different* exploration view of the same
 * context. There is no synchronous back door into the compiler, because the
 * SDK does not offer one and the app does not need one.
 */
import { createExplorationContext } from "@honua/sdk-js/exploration";
import type { ExplorationContext, ExplorationViewController, FilterClause } from "@honua/sdk-js/exploration";
import { bindFilterControlsToExploration } from "@honua/sdk-js/interactions";
import {
  HONUA_INTERACTION_FANOUT_CAP,
  type HonuaInteractionComponents,
  compileHonuaInteractions,
  parseHonuaInteractionRef,
  resolveHonuaInteractionArgs,
  validateHonuaInteractions,
} from "@honua/sdk-js/interactions/declarative";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompositionInteraction } from "../../src/composition/model.js";

let context: ExplorationContext | undefined;
let controls: ExplorationViewController | undefined;

/** The compiler's own view. Gestures are published on a separate one, exactly as `StudioInteractionRuntime` arranges it. */
function compilerView(): ExplorationViewController {
  context = createExplorationContext({ datasetId: "test", sourceIds: ["src-parcels"] });
  controls = context.connectView({ id: "controls", role: "filter" });
  return context.connectView({ id: "interactions", role: "custom" });
}

/** One control gesture: a clause published under the control's own id. */
function gesture(controlId: string, clause: FilterClause | undefined): void {
  const channel = bindFilterControlsToExploration(controls as ExplorationViewController);
  if (clause === undefined) channel.clearFilter(controlId);
  else channel.setFilter(controlId, clause);
}

/** Exploration listeners fire on a microtask so a burst of intents coalesces — let them land. */
async function flush(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  context?.dispose();
  context = undefined;
  controls = undefined;
});

const setFilter = vi.fn();
const setVisibility = vi.fn();
const setViewport = vi.fn();

function components(): HonuaInteractionComponents {
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

describe("interactions/declarative (@honua/sdk-js)", () => {
  afterEach(() => {
    setFilter.mockReset();
    setVisibility.mockReset();
    setViewport.mockReset();
  });

  describe("ref grammar", () => {
    it("parses the four ADR-0030 reference shapes and rejects everything else", () => {
      expect(parseHonuaInteractionRef("map")).toEqual({ kind: "map" });
      expect(parseHonuaInteractionRef("control:year-built")).toEqual({ kind: "control", id: "year-built" });
      expect(parseHonuaInteractionRef("layer:a:b")).toEqual({ kind: "layer", id: "a:b" });
      expect(parseHonuaInteractionRef("source:x")).toBeUndefined();
      expect(parseHonuaInteractionRef("control:")).toBeUndefined();
      expect(parseHonuaInteractionRef("")).toBeUndefined();
    });
  });

  describe("$event substitution", () => {
    it("is static JSON plus path reads — and nothing that resembles an expression language", () => {
      const payload = { value: "R-5", clause: { field: "zoning" } };
      expect(
        resolveHonuaInteractionArgs(
          { field: "zoning", value: "$event.value", nested: { f: "$event.clause.field" } },
          payload,
        ),
      ).toEqual({ field: "zoning", value: "R-5", nested: { f: "zoning" } });
    });

    it("resolves an unreachable path to undefined rather than throwing", () => {
      expect(resolveHonuaInteractionArgs({ v: "$event.a.b.c" }, {})).toEqual({ v: undefined });
    });
  });

  describe("validation", () => {
    it("accepts a well-formed control binding", () => {
      expect(validateHonuaInteractions([binding()])).toEqual({ ok: true, issues: [] });
    });

    it("rejects duplicate ids and out-of-vocabulary events/verbs", () => {
      const { issues } = validateHonuaInteractions([
        binding(),
        binding(),
        binding({ id: "c", on: { ref: "control:district", event: "hover" } } as never),
        binding({ id: "d", do: { ref: "layer:parcels", verb: "deleteFeature" } } as never),
      ]);
      const codes = issues.map((issue) => issue.code);
      expect(codes).toContain("duplicate-id");
      expect(codes).toContain("unknown-event");
      expect(codes).toContain("unknown-verb");
    });

    it("rejects a document over the fan-out cap rather than truncating it", () => {
      const many = Array.from({ length: HONUA_INTERACTION_FANOUT_CAP + 1 }, (_, index) => binding({ id: `b${index}` }));
      expect(validateHonuaInteractions(many).issues.map((issue) => issue.code)).toContain("fan-out-exceeded");
    });

    it("does not count a disabled binding against the cap", () => {
      const many = [
        ...Array.from({ length: HONUA_INTERACTION_FANOUT_CAP }, (_, index) => binding({ id: `b${index}` })),
        binding({ id: "off", disabled: true }),
      ];
      expect(validateHonuaInteractions(many)).toEqual({ ok: true, issues: [] });
    });
  });

  describe("compile", () => {
    it("binds nothing at all when a ref resolves to no declared component", async () => {
      const compiled = compileHonuaInteractions([binding({ on: { ref: "control:missing", event: "change" } })], {
        view: compilerView(),
        components: components(),
      });
      expect(compiled.ok).toBe(false);
      expect(compiled.issues.map((issue) => issue.code)).toContain("invalid-ref");
      expect(compiled.bindings).toEqual([]);

      gesture("missing", { field: "d", operator: "=", value: "x" });
      await flush();
      expect(setFilter).not.toHaveBeenCalled();
      compiled.dispose();
    });

    it("runs the bound verb on a real gesture and rewrites the field the binding names", async () => {
      const compiled = compileHonuaInteractions([binding()], { view: compilerView(), components: components() });
      expect(compiled.ok).toBe(true);
      expect(compiled.bindings.map((entry) => entry.pair)).toEqual(["change -> setFilter"]);

      gesture("district", { field: "district", operator: "=", value: "HON" });
      await flush();

      expect(setFilter).toHaveBeenCalledWith({ field: "district_id", operator: "=", value: "HON" });
      compiled.dispose();
    });

    it("clears the target's filter when the control clears", async () => {
      const compiled = compileHonuaInteractions([binding()], { view: compilerView(), components: components() });
      gesture("district", { field: "district", operator: "=", value: "HON" });
      await flush();
      setFilter.mockReset();

      gesture("district", undefined);
      await flush();

      expect(setFilter).toHaveBeenCalledWith(undefined);
      compiled.dispose();
    });

    it("ignores a gesture from a control it does not bind", async () => {
      const compiled = compileHonuaInteractions([binding()], { view: compilerView(), components: components() });
      gesture("zoning", { field: "zoning_code", operator: "=", value: "R-5" });
      await flush();
      expect(setFilter).not.toHaveBeenCalled();
      compiled.dispose();
    });

    it("reports an uncompilable-but-valid binding instead of leaving it quietly inert", () => {
      const compiled = compileHonuaInteractions(
        [
          binding({ id: "q", do: { ref: "widget:grid", verb: "runWidgetQuery" } }),
          binding({ id: "s", on: { ref: "layer:parcels", event: "featureSelect" } }),
        ],
        { view: compilerView(), components: components() },
      );
      expect(compiled.ok).toBe(false);
      expect(compiled.unsupported.map((entry) => entry.interactionId).sort()).toEqual(["q", "s"]);
      // Each reason names the missing capability, not just "unsupported".
      expect(compiled.unsupported.find((entry) => entry.interactionId === "q")?.reason).toContain("runQuery");
      // Studio declares no `map` on a layer component, so the map-gesture half
      // of ADR-0030 is reported, not bound (honua-studio#43).
      expect(compiled.unsupported.find((entry) => entry.interactionId === "s")?.reason).toContain("map");
      compiled.dispose();
    });

    it("lists a disabled binding rather than pretending it does not exist", async () => {
      const compiled = compileHonuaInteractions([binding({ disabled: true })], {
        view: compilerView(),
        components: components(),
      });
      expect(compiled.disabled).toEqual(["district-filters-parcels"]);

      gesture("district", { field: "district", operator: "=", value: "HON" });
      await flush();
      expect(setFilter).not.toHaveBeenCalled();
      compiled.dispose();
    });

    it("stops dispatching once disposed", async () => {
      const compiled = compileHonuaInteractions([binding()], { view: compilerView(), components: components() });
      compiled.dispose();

      gesture("district", { field: "district", operator: "=", value: "HON" });
      await flush();
      expect(setFilter).not.toHaveBeenCalled();
    });
  });

  describe("actions never emit events", () => {
    it("does not re-enter the compiler when a verb writes back into the compiler's own view", async () => {
      const view = compilerView();
      const dispatches: string[] = [];
      // The action feeds a clause straight back onto the slice the compiler
      // subscribes to. `includeSelf` is false by default, so the write is
      // structurally invisible to the compiler that made it.
      const reentrant: HonuaInteractionComponents = {
        ...components(),
        layers: {
          parcels: {
            sourceId: "src-parcels",
            setFilter: () => {
              bindFilterControlsToExploration(view).setFilter("district", {
                field: "district",
                operator: "=",
                value: "LOOP",
              });
            },
          },
        },
      };
      const compiled = compileHonuaInteractions([binding()], {
        view,
        components: reentrant,
        onDispatch: (dispatch) => dispatches.push(dispatch.interactionId),
      });

      gesture("district", { field: "district", operator: "=", value: "HON" });
      await flush();
      await flush();

      // Exactly one action ran. A cascade would show up here as two, or as an
      // unbounded loop that never lets `flush` return.
      expect(dispatches).toEqual(["district-filters-parcels"]);
      compiled.dispose();
    });
  });
});
