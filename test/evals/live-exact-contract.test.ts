import { beforeAll, describe, expect, it } from "vitest";
import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { CompositionController } from "../../src/composition/controller.js";
import type { CompositionToolCall } from "../../src/composition/tool-call.js";
import { evalTaskById } from "../../src/evals/corpus.js";
import { FixtureTurnDriver } from "../../src/evals/driver.js";
import { PIN_REJECTION_REASON, createLiveExactTask, scoreLiveExactRun } from "../../src/evals/live-exact-contract.js";
import { verifyLiveExactSources } from "../../src/evals/live-exact-prerequisites.js";
import { type EvalRunResult, runEvalTask } from "../../src/evals/runner.js";
import { scoreEvalRun } from "../../src/evals/scorer.js";
import { StudioInteractionRuntime } from "../../src/interactions/studio-interactions.js";
import { McpClient } from "../../src/mcp/client.js";

const bindings = { districtStyleId: "owned-district-v1", councilStyleId: "owned-council-v1" };
type Mutable<T> = T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
const baselines = new Map<string, EvalRunResult>();
const scripts: Record<string, CompositionToolCall[][]> = {
  "compose-districts-map": [
    [
      {
        toolName: "honua_studio_add_layer",
        arguments: {
          layer: { id: "hi-parcels", sourceId: "hi-parcels", visible: true, styleRef: bindings.districtStyleId },
        },
      },
    ],
    [
      {
        toolName: "honua_studio_add_widget",
        arguments: {
          widget: {
            id: "chart-hi-parcels-zoning_code",
            kind: "chart",
            sourceId: "hi-parcels",
            config: { groupBy: "zoning_code", chartType: "bar" },
          },
        },
      },
    ],
  ],
  "add-then-remove-widgets": [
    [
      { toolName: "honua_studio_add_widget", arguments: { widget: { id: "toc-layers", kind: "toc" } } },
      { toolName: "honua_studio_add_widget", arguments: { widget: { id: "legend-parcels", kind: "legend" } } },
    ],
    [{ toolName: "honua_studio_remove_widget", arguments: { widgetId: "legend-parcels" } }],
  ],
  "bind-year-built-filter": [
    [
      {
        toolName: "honua_studio_add_control",
        arguments: {
          control: {
            id: "year-built",
            kind: "filterSlider",
            sourceId: "hi-parcels",
            config: { field: "year_built", min: 1900, max: 2025, step: 1, operator: ">=" },
          },
        },
      },
      {
        toolName: "honua_studio_bind_interaction",
        arguments: {
          interaction: {
            id: "year-built-filter",
            on: { ref: "control:year-built", event: "change" },
            do: {
              ref: "layer:hi-parcels",
              verb: "setFilter",
              args: { field: "year_built", operator: ">=", value: "$event.value" },
            },
          },
        },
      },
    ],
  ],
  "pin-protects-flood-risk": [
    [
      {
        toolName: "honua_studio_set_layer_style",
        arguments: { layerId: "flood-risk", styleRef: bindings.councilStyleId },
      },
      {
        toolName: "honua_studio_set_layer_style",
        arguments: { layerId: "development-pressure", styleRef: bindings.councilStyleId },
      },
    ],
  ],
};

beforeAll(async () => {
  const server = await startMockServer();
  try {
    const client = new McpClient({
      baseUrl: server.url,
      auth: { getAccessToken: async () => mintFixtureAccessToken() },
    });
    for (const [id, calls] of Object.entries(scripts)) {
      const original = evalTaskById(id);
      if (!original) throw new Error(id);
      const originalBytes = JSON.stringify(original);
      const exact = createLiveExactTask(original, bindings);
      const task = {
        ...exact,
        turns: exact.turns.map((turn, index) =>
          turn.kind === "instruction" ? { ...turn, assistant: { toolCalls: calls[index] } } : turn,
        ),
      };
      const run = await runEvalTask(task, {
        driver: new FixtureTurnDriver(),
        live: { client, packageKey: `exact-test-${id}` },
      });
      baselines.set(id, run);
      expect(JSON.stringify(original)).toBe(originalBytes);
    }
  } finally {
    await server.close();
  }
}, 30_000);

function runFor(id: string): Mutable<EvalRunResult> {
  const run = baselines.get(id);
  if (!run) throw new Error(id);
  return structuredClone(run) as Mutable<EvalRunResult>;
}

describe("predeclared exact live contract", () => {
  for (const id of Object.keys(scripts))
    it(`${id} accepts exact native calls through the real HTTP bridge`, () => {
      const score = scoreLiveExactRun(runFor(id));
      expect(score.passed, JSON.stringify(score.failures)).toBe(true);
    });

  it("keeps fixture identities and oracle separate from requested live identities", () => {
    const run = runFor("compose-districts-map");
    const original = evalTaskById(run.task.id);
    if (!original) throw new Error("missing task");
    expect(original.expected.state?.layers?.present?.[0].sourceId).toBe("hi-parcels/0");
    expect(scoreEvalRun({ ...run, task: original }).passed).toBe(false);
    expect(
      createLiveExactTask(original, bindings).turns.every(
        (turn) => turn.kind !== "instruction" || turn.assistant === undefined,
      ),
    ).toBe(true);
    expect(() => createLiveExactTask(original, { ...bindings, districtStyleId: "" })).toThrow("configured");
  });

  const mutations: [string, string, (run: Mutable<EvalRunResult>) => void][] = [
    [
      "wrong requested layer id",
      "compose-districts-map",
      (run) => {
        run.state.layers[0].id = "generated-id";
      },
    ],
    [
      "obsolete fixture source",
      "compose-districts-map",
      (run) => {
        run.state.layers[0].sourceId = "hi-parcels/0";
      },
    ],
    [
      "invented district style",
      "compose-districts-map",
      (run) => {
        run.state.layers[0].styleRef = { kind: "style-ref", styleId: "district" };
      },
    ],
    [
      "wrong chart field",
      "compose-districts-map",
      (run) => {
        run.state.widgets[0].config = { groupBy: "risk", chartType: "bar" };
      },
    ],
    [
      "fixture tool alias",
      "compose-districts-map",
      (run) => {
        for (const entry of run.entries)
          if (entry.type === "composition_command_applied") entry.detail.toolName = "add_layer";
      },
    ],
    [
      "wrong widget removed",
      "add-then-remove-widgets",
      (run) => {
        run.state.widgets[0] = { id: "legend-parcels", kind: "legend" };
      },
    ],
    [
      "obsolete attribute argument",
      "bind-year-built-filter",
      (run) => {
        run.state.interactions[0].do.args = { attribute: "year_built", operator: ">=", value: "$event.value" };
      },
    ],
    [
      "wrong filter target",
      "bind-year-built-filter",
      (run) => {
        run.state.interactions[0].do.ref = "layer:other";
      },
    ],
    [
      "invalid slider field",
      "bind-year-built-filter",
      (run) => {
        run.state.controls[0].config = { field: "risk", min: 1900, max: 2025, step: 1, operator: ">=" };
      },
    ],
    [
      "no actual pinned attempt",
      "pin-protects-flood-risk",
      (run) => {
        run.toolCalls = run.toolCalls.filter((call) => call.outcome.ok);
      },
    ],
    [
      "rejection targets another layer",
      "pin-protects-flood-risk",
      (run) => {
        run.toolCalls[0].arguments.layerId = "other";
      },
    ],
    [
      "generic failure cannot prove pin",
      "pin-protects-flood-risk",
      (run) => {
        const call = run.toolCalls[0];
        if (!call.outcome.ok) call.outcome.reason = "network unavailable";
      },
    ],
    [
      "unpin is not allowed",
      "pin-protects-flood-risk",
      (run) => {
        run.state.pins = [];
      },
    ],
    [
      "provider failure after correct mutation",
      "compose-districts-map",
      (run) => {
        run.turns[0].completed = false;
        run.turns[0].errorMessage = "provider failed";
      },
    ],
  ];
  for (const [name, id, mutate] of mutations)
    it(`rejects ${name}`, () => {
      const run = runFor(id);
      expect(scoreLiveExactRun(run).passed).toBe(true);
      mutate(run);
      expect(scoreLiveExactRun(run).passed).toBe(false);
    });
  it("requires the pinned-state cause even when the activity log claims a rejection", () => {
    const run = runFor("pin-protects-flood-risk");
    expect(run.entries.some((entry) => entry.detail.reason === PIN_REJECTION_REASON)).toBe(true);
    run.toolCalls[0].toolName = "setLayerStyleRef";
    expect(scoreLiveExactRun(run).failures.map((check) => check.path)).toContain("toolCalls.pinnedFloodRiskRejection");
  });
  for (const fieldArgument of ["field", "attribute"] as const)
    it(`executes the actual SDK binding with ${fieldArgument}`, async () => {
      const run = runFor("bind-year-built-filter");
      if (fieldArgument === "attribute")
        run.state.interactions[0].do.args = { attribute: "year_built", operator: ">=", value: "$event.value" };
      expect(scoreLiveExactRun(run).passed).toBe(fieldArgument === "field");
      // Remove the intrinsic source shortcut only for this execution probe so
      // a working control cannot conceal a broken explicit interaction binding.
      run.state.controls[0].sourceId = undefined;
      const dispatched: unknown[] = [];
      const runtime = new StudioInteractionRuntime({
        controller: new CompositionController(run.state),
        onDispatch: (entry) => dispatched.push(entry),
      });
      try {
        runtime.publishControlChange("year-built", { field: "year_built", operator: ">=", value: 2000 });
        for (let i = 0; i < 4; i++) await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (fieldArgument === "field") {
          expect(dispatched).toHaveLength(1);
          expect(JSON.stringify(runtime.appearance.filters["hi-parcels"])).toContain(
            '[">=",["get","year_built"],2000]',
          );
        } else {
          // SDK observes the attempted action but the obsolete argument cannot
          // produce a FilterClause; a dispatch alone is not success evidence.
          expect(dispatched).toHaveLength(1);
          expect(runtime.appearance.filters["hi-parcels"]).toBeUndefined();
        }
      } finally {
        runtime.dispose();
      }
    });
});

const sourceIds = ["hi-parcels", "hi-districts", "src-flood-risk", "src-dev-pressure"];
function sources() {
  return sourceIds.map((id, index) => ({
    id,
    serviceId: "owned",
    layerId: index + 1,
    url: `http://localhost:19929/rest/services/owned/FeatureServer/${index + 1}`,
    fields: ["district", "zoning_code", "year_built"].map((name) => ({ name, type: "esriFieldTypeInteger" })),
  }));
}
const metadataFetch: typeof fetch = async (input, init) => {
  expect(init?.redirect).toBe("error");
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  const id = Number(new URL(String(input)).pathname.split("/").at(-1));
  return Response.json({ id, geometryType: "esriGeometryPolygon", fields: sources()[id - 1].fields });
};
describe("live source admission before model execution", () => {
  it("binds configured aliases to independent metadata", async () => {
    expect(await verifyLiveExactSources(sources(), "http://localhost:19929", metadataFetch)).toHaveLength(4);
  });
  for (const mutation of ["missing", "duplicate", "foreign", "wrong-path", "wrong-fields", "fixture-alias"] as const)
    it(`refuses ${mutation}`, async () => {
      const configured = sources();
      if (mutation === "missing") configured.pop();
      if (mutation === "duplicate") configured.push(configured[0]);
      if (mutation === "foreign") configured[0].url = configured[0].url.replace("localhost", "example.com");
      if (mutation === "wrong-path") configured[0].layerId = 9;
      if (mutation === "wrong-fields") configured[0].fields.pop();
      if (mutation === "fixture-alias") configured[0].id = "hi-parcels/0";
      await expect(verifyLiveExactSources(configured, "http://localhost:19929", metadataFetch)).rejects.toThrow();
    });
  it("refuses failed and redirected metadata responses", async () => {
    await expect(
      verifyLiveExactSources(sources(), "http://localhost:19929", async () => new Response(null, { status: 302 })),
    ).rejects.toThrow("302");
  });
  it("provides a bounded abort signal to a stalled metadata transport", async () => {
    // Event-loop timers are not mocked: capture the requested timeout without
    // waiting eight seconds, and prove rejection is propagated before admission.
    const original = AbortSignal.timeout;
    const controller = new AbortController();
    const calls: number[] = [];
    AbortSignal.timeout = (milliseconds) => {
      calls.push(milliseconds);
      return controller.signal;
    };
    try {
      const pending = verifyLiveExactSources(
        sources(),
        "http://localhost:19929",
        async (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
          }),
      );
      controller.abort(new Error("bounded metadata timeout"));
      await expect(pending).rejects.toThrow("bounded metadata timeout");
      expect(calls).toEqual([8000]);
    } finally {
      AbortSignal.timeout = original;
    }
  });
});
