import type { EvalRunResult } from "./runner.js";
import { scoreEvalRun } from "./scorer.js";
import type { EvalCheck, EvalScore, EvalTask } from "./types.js";

export const LIVE_EXACT_CONTRACT = "honua.studio.live-exact-contract.v1";
export const PIN_REJECTION_REASON = "setLayerStyleRef: target layer:flood-risk is pinned — unpin it first";

export interface LiveExactBindings {
  readonly districtStyleId: string;
  readonly councilStyleId: string;
}

/** Requested identities are declared before execution, never learned from a model's output. */
export function createLiveExactTask(original: EvalTask, bindings: LiveExactBindings): EvalTask {
  if (!bindings.districtStyleId.trim() || !bindings.councilStyleId.trim())
    throw new Error("Exact live tasks require configured authoritative style identities.");
  const task: EvalTask = {
    ...original,
    fixtureConversation: undefined,
    knownBad: [],
    turns: original.turns.map((turn) => (turn.kind === "instruction" ? { ...turn, assistant: undefined } : turn)),
  };
  switch (task.id) {
    case "compose-districts-map":
      return {
        ...task,
        turns: [
          {
            kind: "instruction",
            instruction: `Add the Hawai'i parcels source hi-parcels as layer hi-parcels, visible, using the district classification style ${bindings.districtStyleId}. Create the layer with this style in a single addition.`,
          },
          {
            kind: "instruction",
            instruction:
              "Add a bar chart with ID chart-hi-parcels-zoning_code, using source hi-parcels, grouping parcel counts by zoning_code. Keep the layer unchanged.",
          },
        ],
        expected: {
          state: {
            layers: {
              ids: ["hi-parcels"],
              present: [{ id: "hi-parcels", sourceId: "hi-parcels", visible: true, styleId: bindings.districtStyleId }],
            },
            widgets: {
              ids: ["chart-hi-parcels-zoning_code"],
              present: [
                {
                  id: "chart-hi-parcels-zoning_code",
                  kind: "chart",
                  sourceId: "hi-parcels",
                  config: { groupBy: "zoning_code", chartType: "bar" },
                },
              ],
            },
          },
          activityLog: {
            ...original.expected.activityLog,
            present: [
              {
                type: "composition_command_applied",
                detail: { toolName: "honua_studio_add_layer", command: "addLayer", mode: "server" },
              },
              {
                type: "composition_command_applied",
                detail: { toolName: "honua_studio_add_widget", command: "addWidget", mode: "server" },
              },
            ],
          },
        },
      };
    case "add-then-remove-widgets":
      return {
        ...task,
        turns: [
          {
            kind: "instruction",
            instruction: "Add a layer list with ID toc-layers and a legend with ID legend-parcels to this map.",
          },
          {
            kind: "instruction",
            instruction: "Remove legend-parcels. Keep toc-layers and the existing map layer unchanged.",
          },
        ],
      };
    case "bind-year-built-filter":
      return {
        ...task,
        turns: [
          {
            kind: "instruction",
            instruction:
              "Add a year-built filter slider with ID year-built for source hi-parcels, minimum 1900, maximum 2025 and step 1. Its value should select parcels whose year_built is greater than or equal to the slider value. Use interaction ID year-built-filter; connect the slider's change event to the hi-parcels layer's filter.",
          },
        ],
        expected: {
          state: {
            controls: {
              ids: ["year-built"],
              present: [
                {
                  id: "year-built",
                  kind: "filterSlider",
                  sourceId: "hi-parcels",
                  config: { field: "year_built", min: 1900, max: 2025, step: 1, operator: ">=" },
                },
              ],
            },
            interactions: {
              ids: ["year-built-filter"],
              present: [
                {
                  id: "year-built-filter",
                  on: { ref: "control:year-built", event: "change" },
                  do: {
                    ref: "layer:hi-parcels",
                    verb: "setFilter",
                    args: { field: "year_built", operator: ">=", value: "$event.value" },
                  },
                },
              ],
            },
          },
          activityLog: original.expected.activityLog,
        },
      };
    case "pin-protects-flood-risk":
      return {
        ...task,
        turns: [
          {
            kind: "instruction",
            instruction: `Test the existing pin protection: attempt to apply the council presentation style ${bindings.councilStyleId} to both flood-risk and development-pressure. Keep all pins in place; do not unpin anything. Report any denied attempt, and still apply the style to the unpinned layer.`,
          },
        ],
        expected: {
          state: {
            layers: {
              ids: ["flood-risk", "development-pressure"],
              present: [
                { id: "development-pressure", styleId: bindings.councilStyleId },
                { id: "flood-risk", styleId: null },
              ],
            },
            pins: { keys: ["layer:flood-risk"] },
          },
          activityLog: {
            counts: { composition_command_applied: 1, composition_command_rejected: 1 },
            present: [
              {
                type: "composition_command_rejected",
                detail: {
                  toolName: "honua_studio_set_layer_style",
                  code: "reducer-rejected",
                  reason: PIN_REJECTION_REASON,
                },
                count: 1,
              },
            ],
          },
        },
      };
    default:
      return task;
  }
}

/** Adds evidence checks; it never changes a recorded call, state, or strict comparison. */
export function scoreLiveExactRun(run: EvalRunResult): EvalScore {
  const strict = scoreEvalRun(run);
  const checks: EvalCheck[] = [...strict.checks];
  if (run.task.id === "pin-protects-flood-risk") {
    const rejected = run.toolCalls.filter(
      (call) =>
        call.toolName === "honua_studio_set_layer_style" &&
        call.arguments.layerId === "flood-risk" &&
        !call.outcome.ok &&
        call.outcome.code === "reducer-rejected" &&
        call.outcome.reason === PIN_REJECTION_REASON,
    );
    checks.push({
      id: "pin.rejectedCall",
      path: "toolCalls.pinnedFloodRiskRejection",
      status: rejected.length === 1 ? "pass" : "fail",
      expected: 1,
      actual: rejected.length,
      message: "One native call targeting flood-risk must be rejected for the retained pin.",
    });
  }
  const failures = checks.filter((check) => check.status === "fail");
  return {
    ...strict,
    checks,
    failures,
    passed: failures.length === 0,
    passedCount: checks.length - failures.length,
    totalCount: checks.length,
  };
}
