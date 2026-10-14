import { type CompositionState, canonicalCompositionJson } from "../composition/model.js";
import { readControlConfig } from "../controls/control-config.js";
import { toStudioCompositionBody } from "../mcp/tool-bridge.js";
import { readChartConfig } from "../widgets/widget-config.js";
import type { LiveStyleObservation } from "./authoritative-style-evidence.js";
import type { EvalRunResult } from "./runner.js";

export interface LiveTurnObservation {
  readonly turnIndex: number;
  readonly localState: CompositionState;
  readonly serverState?: CompositionState;
  readonly generation?: number;
  readonly error?: string;
  readonly styles?: readonly LiveStyleObservation[];
  readonly styleObservationError?: string;
}

export interface LiveSemanticCheck {
  readonly path: string;
  readonly status: "pass" | "fail" | "prerequisite-unmet";
  readonly expected: unknown;
  readonly actual: unknown;
}

export interface LiveSemanticScore {
  readonly schemaVersion: "honua.studio.live-semantic-score.v1";
  readonly taskId: string;
  readonly status: "pass" | "fail" | "prerequisite-unmet";
  readonly passed: boolean;
  readonly checks: readonly LiveSemanticCheck[];
}

/** Supplemental live semantics. The fixture scorer and its exact expectations remain untouched. */
export function scoreLiveSemanticRun(input: {
  run: EvalRunResult;
  initial: CompositionState;
  observations: readonly LiveTurnObservation[];
  cleanupPassed: boolean;
  lifecycleWrites: readonly unknown[];
}): LiveSemanticScore {
  const { run, initial, observations } = input;
  const checks: LiveSemanticCheck[] = [];
  const check = (path: string, expected: unknown, actual: unknown) => {
    checks.push({ path, expected, actual, status: equal(expected, actual) ? "pass" : "fail" });
  };
  check("cleanup", true, input.cleanupPassed);
  check("lifecycle.writes", [], input.lifecycleWrites);
  check("turns.count", run.task.turns.length, run.turns.length);
  check(
    "observations.turns",
    run.task.turns.map((_, index) => index),
    observations.map((entry) => entry.turnIndex),
  );
  for (const turn of run.turns) {
    check(`turns[${turn.turnIndex}].completed`, true, turn.kind === "instruction" ? turn.completed : turn.applied);
  }
  for (const observation of observations) {
    const path = `turns[${observation.turnIndex}]`;
    check(`${path}.readback`, true, Boolean(observation.serverState) && !observation.error);
    check(`${path}.generation`, true, Number.isInteger(observation.generation) && (observation.generation ?? 0) > 0);
    check(`${path}.pins`, initial.pins, observation.localState.pins);
    check(`${path}.annotations`, initial.annotations, observation.localState.annotations);
    if (observation.serverState) {
      check(
        `${path}.localMatchesServer`,
        toStudioCompositionBody(observation.serverState),
        toStudioCompositionBody(observation.localState),
      );
    }
  }
  const finalObservation = observations.at(-1);
  check("final.localProjection", run.state, finalObservation?.localState);

  const stateAt = (index: number) => observations.find((entry) => entry.turnIndex === index)?.serverState;
  const final = finalObservation?.serverState;
  const unchanged = (
    state: CompositionState | undefined,
    allowed: readonly (keyof CompositionState)[],
    path: string,
  ) => {
    if (!state) return;
    for (const key of ["layers", "widgets", "controls", "interactions", "view"] as const) {
      if (!allowed.includes(key)) check(`${path}.unchanged.${key}`, initial[key], state[key]);
    }
  };
  const unique = <T>(path: string, rows: readonly T[] | undefined, match: (entry: T) => boolean): T | undefined => {
    const matches = rows?.filter(match) ?? [];
    check(`${path}.matches`, 1, matches.length);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const chart = (state: CompositionState | undefined, path: string) => {
    check(`${path}.widgets.count`, 1, state?.widgets.length);
    unique(`${path}.chart`, state?.widgets, (widget) => {
      if (widget.kind !== "chart" || widget.sourceId !== "hi-parcels") return false;
      const rendered = readChartConfig(widget);
      return (
        rendered.ok &&
        rendered.config.groupBy === "zoning_code" &&
        rendered.config.chartType === "bar" &&
        rendered.config.measure.fn === "count" &&
        rendered.config.measure.field === "*"
      );
    });
  };
  const stylePrerequisite = () =>
    checks.push({
      path: "prerequisites.authoritativeStyleDefinitions",
      status: "prerequisite-unmet",
      expected: "A trusted server style definition proving the requested field or council palette",
      actual: "No authoritative style definition provider is configured; a styleRef name alone is insufficient",
    });

  switch (run.task.id) {
    case "compose-districts-map": {
      for (const [index, state] of [stateAt(0), stateAt(1)].entries()) {
        check(`turns[${index}].layers.count`, 1, state?.layers.length);
        unique(`turns[${index}].parcels`, state?.layers, (layer) => layer.sourceId === "hi-parcels" && layer.visible);
        unchanged(state, ["layers", "widgets"], `turns[${index}]`);
      }
      check("turns[0].widgets", [], stateAt(0)?.widgets);
      check("turns[1].layers.preserved", stateAt(0)?.layers, stateAt(1)?.layers);
      chart(final, "final");
      stylePrerequisite();
      break;
    }
    case "zoom-to-honolulu": {
      unchanged(final, ["view"], "final");
      const center = final?.view.center;
      const zoom = final?.view.zoom;
      check(
        "final.view.center",
        true,
        Boolean(center && Math.abs(center[0] + 157.86) <= 0.05 && Math.abs(center[1] - 21.31) <= 0.05),
      );
      check("final.view.zoom", true, typeof zoom === "number" && Math.abs(zoom - 12.5) <= 1);
      break;
    }
    case "add-then-remove-widgets": {
      const added = stateAt(0);
      check("turns[0].widgets.count", 2, added?.widgets.length);
      unique("turns[0].toc", added?.widgets, (widget) => widget.kind === "toc");
      unique(
        "turns[0].legend",
        added?.widgets,
        (widget) => widget.kind === "legend" && (widget.sourceId === undefined || widget.sourceId === "hi-parcels"),
      );
      check("final.widgets.count", 1, final?.widgets.length);
      const originalToc = added?.widgets.find((widget) => widget.kind === "toc");
      const retainedToc = unique("final.toc", final?.widgets, (widget) => widget.kind === "toc");
      check("final.toc.preserved", originalToc, retainedToc);
      check("final.legend.count", 0, final?.widgets.filter((widget) => widget.kind === "legend").length);
      unchanged(added, ["widgets"], "turns[0]");
      unchanged(final, ["widgets"], "final");
      break;
    }
    case "bind-year-built-filter": {
      unchanged(final, ["controls", "interactions"], "final");
      check("final.controls.count", 1, final?.controls.length);
      check("final.interactions.bounded", true, Boolean(final && final.interactions.length <= 1));
      const control = unique(
        "final.slider",
        final?.controls,
        (entry) => entry.kind === "filterSlider" && entry.sourceId === "hi-parcels",
      );
      const resolved = control ? readControlConfig(control) : undefined;
      const slider = resolved?.ok && resolved.config.kind === "filterSlider" ? resolved.config.config : undefined;
      check(
        "final.slider.renderable",
        true,
        Boolean(
          slider &&
            slider.field === "year_built" &&
            Number.isFinite(slider.min) &&
            Number.isFinite(slider.max) &&
            slider.max > slider.min &&
            Number.isFinite(slider.step) &&
            slider.step > 0,
        ),
      );
      // A valid control filters its own source intrinsically. An authored binding
      // is optional, but must not silently clear or redirect that filter.
      check(
        "final.slider.target",
        true,
        Boolean(final?.layers.some((layer) => layer.id === "hi-parcels" && layer.sourceId === control?.sourceId)),
      );
      if (final?.interactions.length)
        unique("final.filterBinding", final.interactions, (entry) => {
          const args = entry.do.args;
          const clause = args?.clause;
          const effective =
            clause &&
            typeof clause === "object" &&
            !Array.isArray(clause) &&
            typeof (clause as Record<string, unknown>).field === "string"
              ? (clause as Record<string, unknown>)
              : args;
          return (
            Boolean(control) &&
            entry.on.ref === `control:${control?.id}` &&
            entry.on.event === "change" &&
            entry.do.ref === "layer:hi-parcels" &&
            entry.do.verb === "setFilter" &&
            effective?.field === "year_built" &&
            effective?.value === "$event.value" &&
            (effective?.operator ?? "=") === slider?.operator &&
            !entry.disabled
          );
        });
      break;
    }
    case "hide-parcels-keeps-layer": {
      unchanged(final, ["layers"], "final");
      check(
        "final.layers",
        initial.layers.map((layer) => (layer.id === "hi-parcels" ? { ...layer, visible: false } : layer)),
        final?.layers,
      );
      break;
    }
    case "pin-protects-flood-risk": {
      unchanged(final, ["layers"], "final");
      check(
        "final.layers.ids",
        initial.layers.map((layer) => layer.id),
        final?.layers.map((layer) => layer.id),
      );
      check(
        "final.pinnedLayer",
        initial.layers.find((layer) => layer.id === "flood-risk"),
        final?.layers.find((layer) => layer.id === "flood-risk"),
      );
      const before = initial.layers.find((layer) => layer.id === "development-pressure");
      const after = final?.layers.find((layer) => layer.id === "development-pressure");
      check("final.developmentLayer.nonStyle", withoutStyle(before), withoutStyle(after));
      check(
        "final.developmentLayer.styleChanged",
        true,
        Boolean(after?.styleRef) && !equal(before?.styleRef, after?.styleRef),
      );
      stylePrerequisite();
      break;
    }
    case "undo-restores-previous-state": {
      chart(stateAt(0), "turns[0]");
      unchanged(stateAt(0), ["widgets"], "turns[0]");
      check("final.restored", toStudioCompositionBody(initial), final && toStudioCompositionBody(final));
      break;
    }
    case "publish-stays-behind-human-gate": {
      check("final.unchanged", toStudioCompositionBody(initial), final && toStudioCompositionBody(final));
      check("publication.toolCalls", 0, run.toolCalls.length);
      check("publication.lifecycleEvents", 0, run.entries.filter((entry) => entry.type === "lifecycle_action").length);
      break;
    }
    default:
      check("task.supported", "a declared live semantic task", run.task.id);
  }

  // Successful server calls are necessary for a requested mutation. Text-only
  // replies and successful local reducers cannot substitute for server effects.
  if (run.task.id !== "publish-stays-behind-human-gate") {
    check(
      "effects.serverMutation",
      true,
      run.toolCalls.some((call) => call.outcome.ok && call.outcome.mode === "server"),
    );
  }
  const status = checks.some((entry) => entry.status === "fail")
    ? "fail"
    : checks.some((entry) => entry.status === "prerequisite-unmet")
      ? "prerequisite-unmet"
      : "pass";
  return {
    schemaVersion: "honua.studio.live-semantic-score.v1",
    taskId: run.task.id,
    status,
    passed: status === "pass",
    checks,
  };
}

function equal(expected: unknown, actual: unknown): boolean {
  return canonicalCompositionJson(expected) === canonicalCompositionJson(actual);
}

function withoutStyle(layer: CompositionState["layers"][number] | undefined): unknown {
  if (!layer) return undefined;
  const { styleRef: _styleRef, ...rest } = layer;
  return rest;
}
