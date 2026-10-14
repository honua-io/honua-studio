import { beforeAll, describe, expect, it } from "vitest";
import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { CompositionController } from "../../src/composition/controller.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import { applyCompositionCommands } from "../../src/composition/reducer.js";
import { EVAL_CORPUS } from "../../src/evals/corpus.js";
import { type EvalTurnContext, FixtureTurnDriver } from "../../src/evals/driver.js";
import { type LiveTurnObservation, scoreLiveSemanticRun } from "../../src/evals/live-semantic-scorer.js";
import { runEvalTask } from "../../src/evals/runner.js";
import { scoreEvalRun } from "../../src/evals/scorer.js";
import { StudioInteractionRuntime } from "../../src/interactions/studio-interactions.js";
import { McpClient } from "../../src/mcp/client.js";
import { StudioMcpToolClient } from "../../src/mcp/studio-tools.js";
import { applyStudioDraft, toStudioCompositionBody } from "../../src/mcp/tool-bridge.js";

type Input = Parameters<typeof scoreLiveSemanticRun>[0];
type Mutable<T> = T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
const baselines = new Map<string, Input>();

// The live corpus host publishes the trusted "hi-parcels" alias, whereas the
// zero-setup sample uses discovery's "hi-parcels/0". Adapt the fixture driver
// before execution; independently read HTTP drafts still supply all evidence.
class LiveHostFixtureDriver extends FixtureTurnDriver {
  override async *runTurn(context: EvalTurnContext) {
    for await (const event of super.runTurn(context)) {
      if (context.task.id === "compose-districts-map") {
        if (event.type === "toolCallDelta") {
          yield { ...event, toolArgumentsDelta: event.toolArgumentsDelta?.replaceAll("hi-parcels/0", "hi-parcels") };
          continue;
        }
        if (event.type === "toolCallStop" && event.toolArguments && typeof event.toolArguments === "object") {
          yield { ...event, toolArguments: { ...event.toolArguments, sourceId: "hi-parcels" } };
          continue;
        }
      }
      yield event;
    }
  }
}

beforeAll(async () => {
  const server = await startMockServer();
  try {
    const client = new McpClient({
      baseUrl: server.url,
      auth: { getAccessToken: async () => mintFixtureAccessToken() },
    });
    const tools = new StudioMcpToolClient(client);
    for (const task of EVAL_CORPUS) {
      const initial = applyCompositionCommands(createEmptyCompositionState(), task.setup ?? []).state;
      const draft = await tools.createDraft({
        packageKey: task.id,
        family: "map",
        schemaVersion: "1",
        body: toStudioCompositionBody(initial),
      });
      const observations: LiveTurnObservation[] = [];
      const run = await runEvalTask(task, {
        driver: new LiveHostFixtureDriver(),
        live: { client, packageKey: task.id, draftId: draft.draftId, generation: draft.generation },
        observeTurn: async (turn, localState) => {
          const actual = await tools.getDraft(draft.draftId);
          observations.push({
            turnIndex: turn.turnIndex,
            localState,
            serverState: applyStudioDraft(actual),
            generation: actual.generation,
          });
        },
      });
      const url = `${server.url}/v1/studio/package-drafts/${draft.draftId}`;
      const headers = { Authorization: `Bearer ${mintFixtureAccessToken()}` };
      const deleted = await fetch(url, { method: "DELETE", headers });
      const absent = await fetch(url, { headers });
      baselines.set(task.id, {
        run,
        initial,
        observations,
        cleanupPassed: deleted.ok && absent.status === 404,
        lifecycleWrites: [],
      });
    }
  } finally {
    await server.close();
  }
}, 30_000);

function inputFor(id: string): Mutable<Input> {
  const input = baselines.get(id);
  if (!input) throw new Error(`Missing real HTTP baseline: ${id}`);
  return structuredClone(input) as Mutable<Input>;
}

function states(input: Mutable<Input>) {
  return [
    input.run.state,
    ...input.observations.flatMap((entry) =>
      entry.serverState ? [entry.localState, entry.serverState] : [entry.localState],
    ),
  ];
}

// A declared positive live control needs a renderable domain. The original
// exact fixture intentionally remains unchanged and is a negative below.
function renderableFilterInput(): Mutable<Input> {
  const input = inputFor("bind-year-built-filter");
  for (const state of states(input)) {
    for (const control of state.controls) control.config = { field: "year_built", min: 1900, max: 2026, step: 1 };
    for (const interaction of state.interactions)
      interaction.do.args = { field: "year_built", operator: ">=", value: "$event.value" };
  }
  return input;
}

function fails(input: Input, path: string) {
  const score = scoreLiveSemanticRun(input);
  expect(score.status).toBe("fail");
  expect(score.checks.filter((entry) => entry.status === "fail").map((entry) => entry.path)).toContain(path);
}

describe("supplemental live semantics over independently read HTTP drafts", () => {
  for (const task of EVAL_CORPUS) {
    it(`scores ${task.id} without inventing style evidence`, () => {
      const input = inputFor(task.id);
      if (task.id === "bind-year-built-filter") {
        expect(scoreEvalRun(input.run).passed).toBe(true);
        fails(input, "final.slider.renderable");
      } else {
        const score = scoreLiveSemanticRun(input);
        expect(score.status).toBe(task.capabilities.includes("style") ? "prerequisite-unmet" : "pass");
        expect(score.checks.filter((entry) => entry.status === "fail")).toEqual([]);
      }
    });
  }

  it("accepts unique renamed components and native aliases while retaining the strict failure", () => {
    const input = inputFor("add-then-remove-widgets");
    for (const state of states(input)) for (const widget of state.widgets) widget.id = `model-${widget.kind}`;
    for (const call of input.run.toolCalls)
      call.toolName = `honua_studio_${call.outcome.ok && call.outcome.command.name === "removeWidget" ? "remove_widget" : "add_widget"}`;
    expect(scoreEvalRun(input.run).passed).toBe(false);
    expect(scoreLiveSemanticRun(input).passed).toBe(true);
  });

  it("follows the observed slider identity rather than a fixture spelling", () => {
    const input = renderableFilterInput();
    for (const state of states(input)) {
      for (const control of state.controls) control.id = "model-slider";
      for (const interaction of state.interactions) {
        interaction.id = "model-binding";
        interaction.on.ref = "control:model-slider";
      }
    }
    expect(scoreEvalRun(input.run).passed).toBe(false);
    expect(scoreLiveSemanticRun(input).passed).toBe(true);
  });

  it("accepts actual renderer chart aliases without changing the strict result", () => {
    const input = inputFor("undo-restores-previous-state");
    for (const state of [input.observations[0].localState, input.observations[0].serverState]) {
      const widget = state?.widgets[0];
      if (!widget) throw new Error("Missing chart baseline");
      widget.config = { chartType: "bar", categoryField: "zoning_code", aggregationType: "count" };
    }
    const score = scoreLiveSemanticRun(input);
    expect(score.checks.find((check) => check.path === "turns[0].chart.matches")?.status).toBe("pass");
    expect(score.passed).toBe(true);
  });

  for (const mode of ["intrinsic", "explicit", "clause", "explicit-no-source"] as const) {
    it(`scores executable ${mode} own-source filtering and drives the actual runtime`, async () => {
      const input = renderableFilterInput();
      for (const state of states(input)) {
        if (mode === "explicit-no-source") state.controls[0].sourceId = undefined;
        if (mode === "intrinsic") state.interactions = [];
        else if (mode === "clause")
          state.interactions[0].do.args = { clause: { field: "year_built", operator: ">=", value: "$event.value" } };
      }
      expect(scoreLiveSemanticRun(input).passed).toBe(true);
      const controller = new CompositionController(input.run.state);
      const runtime = new StudioInteractionRuntime({ controller });
      try {
        runtime.publishControlChange(input.run.state.controls[0].id, {
          field: "year_built",
          operator: ">=",
          value: 2000,
        });
        for (let i = 0; i < 4; i++) await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const filter = runtime.appearance.filters["hi-parcels"];
        expect(filter).toBeDefined();
        expect(JSON.stringify(filter)).toContain('[">=",["get","year_built"],2000]');
        expect(scoreEvalRun(input.run).passed).toBe(false);
      } finally {
        runtime.dispose();
      }
    });
  }

  it("rejects an unbound numeric control with no source target", () => {
    const input = renderableFilterInput();
    for (const state of states(input)) {
      state.controls[0].sourceId = undefined;
      state.interactions = [];
    }
    fails(input, "final.slider.target");
  });

  it("rejects an omitted binding operator because the installed SDK defaults to equality, not the slider event", async () => {
    const input = renderableFilterInput();
    for (const state of states(input)) {
      state.controls[0].sourceId = undefined;
      state.interactions[0].do.args = { field: "year_built", value: "$event.value" };
    }
    const controller = new CompositionController(input.run.state);
    const runtime = new StudioInteractionRuntime({ controller });
    try {
      runtime.publishControlChange(input.run.state.controls[0].id, {
        field: "year_built",
        operator: ">=",
        value: 2000,
      });
      for (let i = 0; i < 4; i++) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(JSON.stringify(runtime.appearance.filters["hi-parcels"])).toContain('["==",["get","year_built"],2000]');
      fails(input, "final.filterBinding.matches");
    } finally {
      runtime.dispose();
    }
  });

  it("rejects duplicate matching components", () => {
    const input = inputFor("add-then-remove-widgets");
    for (const state of [input.run.state, input.observations[1].localState, input.observations[1].serverState]) {
      const toc = state?.widgets.find((widget) => widget.kind === "toc");
      if (toc) state?.widgets.push({ ...toc, id: "duplicate-toc" });
    }
    fails(input, "final.toc.matches");
  });

  for (const defect of ["source", "groupBy", "measure", "chartType"] as const) {
    it(`rejects a chart with the wrong ${defect}`, () => {
      const input = inputFor("undo-restores-previous-state");
      for (const state of [input.observations[0].localState, input.observations[0].serverState]) {
        const widget = state?.widgets[0];
        if (!widget) throw new Error("Missing chart baseline");
        if (defect === "source") widget.sourceId = "wrong-source";
        else if (defect === "groupBy") widget.config = { ...widget.config, groupBy: "district" };
        else if (defect === "measure") widget.config = { ...widget.config, measure: { fn: "sum", field: "area" } };
        else widget.config = { ...widget.config, chartType: "line" };
      }
      fails(input, "turns[0].chart.matches");
    });
  }

  for (const defect of ["target", "event-value", "attribute-only", "disabled", "operator"] as const) {
    it(`rejects a ${defect} filter binding`, () => {
      const input = renderableFilterInput();
      for (const state of states(input)) {
        if (defect === "target") state.interactions[0].do.ref = "map";
        else if (defect === "attribute-only")
          state.interactions[0].do.args = { attribute: "year_built", value: "$event.value" };
        else if (defect === "disabled") state.interactions[0].disabled = true;
        else if (defect === "operator")
          state.interactions[0].do.args = { field: "year_built", operator: "<=", value: "$event.value" };
        else state.interactions[0].do.args = { field: "year_built", value: 2020 };
      }
      fails(input, "final.filterBinding.matches");
    });
  }

  for (const config of [
    { field: "district", min: 1900, max: 2026 },
    { field: "year_built", min: 2026, max: 1900 },
    { field: "year_built", min: 1900, max: 2026, step: 0 },
    { field: "year_built", min: 1900 },
  ]) {
    it(`rejects an unusable slider config: ${JSON.stringify(config)}`, () => {
      const input = renderableFilterInput();
      for (const state of states(input)) for (const control of state.controls) control.config = config;
      fails(input, "final.slider.renderable");
    });
  }

  it("rejects removal of the wrong widget", () => {
    const input = inputFor("add-then-remove-widgets");
    for (const state of [input.run.state, input.observations[1].localState, input.observations[1].serverState]) {
      if (state) state.widgets = [{ id: "remaining-legend", kind: "legend" }];
    }
    fails(input, "final.toc.matches");
  });

  it("fails pinned edits even when style evidence is unavailable", () => {
    const input = inputFor("pin-protects-flood-risk");
    for (const state of states(input)) {
      const layer = state.layers.find((entry) => entry.id === "flood-risk");
      if (layer) layer.visible = false;
    }
    fails(input, "final.pinnedLayer");
  });

  it("fails a pin-restyle no-op instead of attributing it only to missing styles", () => {
    const input = inputFor("pin-protects-flood-risk");
    input.run.toolCalls = [];
    input.run.state = structuredClone(input.initial);
    input.observations[0].localState = structuredClone(input.initial);
    input.observations[0].serverState = structuredClone(input.initial);
    fails(input, "effects.serverMutation");
    fails(input, "final.developmentLayer.styleChanged");
  });

  it("does not pass a text-only no-effect response", () => {
    const input = inputFor("hide-parcels-keeps-layer");
    input.run.toolCalls = [];
    input.run.state = structuredClone(input.initial);
    input.observations[0].localState = structuredClone(input.initial);
    input.observations[0].serverState = structuredClone(input.initial);
    fails(input, "effects.serverMutation");
    fails(input, "final.layers");
  });

  it("fails provider errors after a successful partial mutation", () => {
    const input = inputFor("hide-parcels-keeps-layer");
    input.run.turns[0].completed = false;
    input.run.turns[0].errorMessage = "Provider request failed";
    fails(input, "turns[0].completed");
  });

  it("rejects local-only success with unchanged authoritative state", () => {
    const input = inputFor("hide-parcels-keeps-layer");
    input.observations[0].serverState = structuredClone(input.initial);
    for (const call of input.run.toolCalls) if (call.outcome.ok) call.outcome.mode = "local";
    fails(input, "turns[0].localMatchesServer");
    fails(input, "effects.serverMutation");
  });

  it("rejects an actual lifecycle write independently of final composition", () => {
    const input = inputFor("publish-stays-behind-human-gate");
    input.lifecycleWrites.push({ method: "tools/call", params: { name: "honua_studio_publish" } });
    fails(input, "lifecycle.writes");
  });

  it("requires intermediate readback before undo, not just a final empty widget list", () => {
    const input = inputFor("undo-restores-previous-state");
    input.observations.shift();
    fails(input, "observations.turns");
    fails(input, "turns[0].chart.matches");
  });

  it("requires cleanup even when every composition check passes", () => {
    const input = inputFor("hide-parcels-keeps-layer");
    input.cleanupPassed = false;
    fails(input, "cleanup");
  });
});
