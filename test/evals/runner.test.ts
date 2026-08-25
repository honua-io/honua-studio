import { describe, expect, it } from "vitest";

import type { StudioAiChatEvent, StudioAiChatMessage } from "../../src/chat/ai-contract.js";
import { composeDistrictsMapConversation } from "../../src/chat/fixtures/index.js";
import type { EvalToolResult, EvalTurnContext, EvalTurnDriver } from "../../src/evals/driver.js";
import { EvalDriverError, FixtureTurnDriver, scriptedTurnEvents } from "../../src/evals/driver.js";
import { createEvalClock, runEvalTask } from "../../src/evals/runner.js";
import type { EvalTask } from "../../src/evals/types.js";

/**
 * The runner's contract: it plays a task through the app's own composition
 * loop (`ToolCallOrchestrator` -> `tool-bridge` -> reducer) and mirrors
 * `<honua-studio-chat>`'s activity-log semantics, so a corpus score is a
 * statement about the real loop rather than about an eval-only reimplementation.
 */

function instructionTask(overrides: Partial<EvalTask> = {}): EvalTask {
  return {
    id: "runner-probe",
    title: "runner probe",
    capabilities: ["layer"],
    turns: [
      {
        kind: "instruction",
        instruction: "Add the parcels layer.",
        assistant: {
          text: "Adding it.",
          toolCalls: [{ toolName: "add_layer", arguments: { datasetId: "hi-parcels", styleBy: "district" } }],
        },
      },
    ],
    expected: { state: { layers: { ids: ["hi-parcels"] } } },
    knownBad: [],
    ...overrides,
  };
}

describe("evals/runner — activity log", () => {
  it("logs the same entry types, in the same order, that <honua-studio-chat> logs for one turn", async () => {
    const run = await runEvalTask(instructionTask(), { driver: new FixtureTurnDriver() });

    expect(run.entries.map((entry) => entry.type)).toEqual([
      "user_message_sent",
      "assistant_turn_started",
      "tool_call_started",
      "tool_call_completed",
      "composition_command_applied",
      "assistant_turn_completed",
    ]);
    expect(run.entries[3].detail).toMatchObject({
      toolName: "add_layer",
      arguments: { datasetId: "hi-parcels", styleBy: "district" },
    });
    expect(run.entries[4].detail).toMatchObject({ toolName: "add_layer", command: "addLayer", mode: "local" });
  });

  it("uses a deterministic clock — no wall-clock time in a fixture run", async () => {
    const run = await runEvalTask(instructionTask(), { driver: new FixtureTurnDriver(), clock: createEvalClock() });
    expect(run.entries.map((entry) => entry.at)).toEqual([
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:02.000Z",
      "2026-01-01T00:00:03.000Z",
      "2026-01-01T00:00:04.000Z",
      "2026-01-01T00:00:05.000Z",
      "2026-01-01T00:00:06.000Z",
    ]);
  });

  it("setup commands seed the starting state without appearing in the scored log", async () => {
    const run = await runEvalTask(
      instructionTask({ setup: [{ name: "addLayer", layer: { id: "base", sourceId: "base" } }] }),
      { driver: new FixtureTurnDriver() },
    );

    expect(run.state.layers.map((layer) => layer.id)).toEqual(["base", "hi-parcels"]);
    expect(run.entries.filter((entry) => entry.type === "composition_command_applied")).toHaveLength(1);
  });

  it("an unrecognized tool is a logged, typed rejection — the run continues rather than throwing", async () => {
    const run = await runEvalTask(
      instructionTask({
        turns: [
          {
            kind: "instruction",
            instruction: "Publish it.",
            assistant: { toolCalls: [{ toolName: "honua_studio_publish_version", arguments: {} }] },
          },
        ],
      }),
      { driver: new FixtureTurnDriver() },
    );

    expect(run.toolCalls[0].outcome).toMatchObject({ ok: false, code: "unknown-tool" });
    expect(run.entries.map((entry) => entry.type)).toContain("composition_command_rejected");
    expect(run.state.layers).toEqual([]);
  });
});

describe("evals/runner — user-action turns", () => {
  const withUndo = (action: "undo" | "redo") =>
    instructionTask({
      turns: [
        {
          kind: "instruction",
          instruction: "Add the parcels layer.",
          assistant: { toolCalls: [{ toolName: "add_layer", arguments: { datasetId: "hi-parcels" } }] },
        },
        { kind: "user-action", action },
      ],
    });

  it("undo reverts the last revision and is not itself a composition command", async () => {
    const run = await runEvalTask(withUndo("undo"), { driver: new FixtureTurnDriver() });

    expect(run.state.layers).toEqual([]);
    expect(run.turns[1]).toMatchObject({ kind: "user-action", action: "undo", applied: true });
    expect(run.entries.filter((entry) => entry.type === "composition_command_applied")).toHaveLength(1);
  });

  it("redo with nothing to redo is recorded as not applied rather than failing the run", async () => {
    const run = await runEvalTask(withUndo("redo"), { driver: new FixtureTurnDriver() });

    expect(run.state.layers.map((layer) => layer.id)).toEqual(["hi-parcels"]);
    expect(run.turns[1]).toMatchObject({ applied: false });
  });
});

describe("evals/driver — the fixture lane", () => {
  it("replays a real fixture conversation through FixtureChatTransport", async () => {
    const task = instructionTask({
      id: "replay-probe",
      fixtureConversation: composeDistrictsMapConversation,
      turns: composeDistrictsMapConversation.turns.map((turn) => ({
        kind: "instruction" as const,
        instruction: turn.user.text,
      })),
    });

    const run = await runEvalTask(task, { driver: new FixtureTurnDriver() });

    expect(run.toolCalls.map((call) => call.toolName)).toEqual(["add_layer", "add_chart"]);
    expect(run.state.layers.map((layer) => layer.styleRef?.styleId)).toEqual(["district"]);
    expect(run.state.widgets.map((widget) => widget.kind)).toEqual(["chart"]);
  });

  it("a scripted turn stands in for the conversation turn it replaces, keeping later turns aligned", async () => {
    const task = instructionTask({
      id: "override-probe",
      fixtureConversation: composeDistrictsMapConversation,
      turns: [
        {
          kind: "instruction",
          instruction: composeDistrictsMapConversation.turns[0].user.text,
          assistant: { toolCalls: [{ toolName: "add_layer", arguments: { datasetId: "hi-roads" } }] },
        },
        { kind: "instruction", instruction: composeDistrictsMapConversation.turns[1].user.text },
      ],
    });

    const run = await runEvalTask(task, { driver: new FixtureTurnDriver() });

    // Turn 1 came from the override; turn 2 is still the conversation's chart.
    expect(run.state.layers.map((layer) => layer.id)).toEqual(["hi-roads"]);
    expect(run.state.widgets.map((widget) => widget.id)).toEqual(["chart-hi-parcels-zoning_code"]);
  });

  it("a turn with neither a scripted reply nor a conversation is an authoring error, not a scored failure", async () => {
    const task = instructionTask({ turns: [{ kind: "instruction", instruction: "Do something." }] });
    await expect(runEvalTask(task, { driver: new FixtureTurnDriver() })).rejects.toBeInstanceOf(EvalDriverError);
  });

  it("synthesizes the proxy's own event shape: the tool name rides on toolCallStart only", () => {
    const events = scriptedTurnEvents({ text: "hi", toolCalls: [{ toolName: "setView", arguments: { view: {} } }] }, 1);

    expect(events.map((event) => event.type)).toEqual([
      "messageStart",
      "textDelta",
      "toolCallStart",
      "toolCallDelta",
      "toolCallStop",
      "messageStop",
    ]);
    expect(events[2]).toMatchObject({ toolName: "setView" });
    expect(events[4].toolName).toBeUndefined();
    expect(events[5]).toMatchObject({ stopReason: "toolCall" });
  });
});

describe("evals/driver — the seam a live lane plugs into (honua-studio#40)", () => {
  /**
   * A stand-in for the post-#40 live driver: it decides its second tool call
   * only after the runner reports the outcome of its first, which is exactly
   * what an agent loop does with the `{ role: "tool" }` result message. The
   * fixture lane does not need this, but the seam has to support it, or the
   * corpus could not be re-run against a real model without rewriting the
   * runner.
   */
  class ScriptedAgentDriver implements EvalTurnDriver {
    public readonly id = "fake-live";
    public readonly kind = "live" as const;
    public readonly seen: string[] = [];
    public readonly results: EvalToolResult[] = [];
    #pending: EvalToolResult | undefined;

    public beginTask(): void {
      this.seen.push("beginTask");
    }

    public endTask(): void {
      this.seen.push("endTask");
    }

    public reportToolResult(result: EvalToolResult): void {
      this.results.push(result);
      this.#pending = result;
    }

    public async *runTurn(context: EvalTurnContext): AsyncGenerator<StudioAiChatEvent> {
      this.seen.push(
        `turn:${context.instruction}`,
        `history:${context.history.length}`,
        `layers:${context.state.layers.length}`,
      );
      yield { type: "messageStart", model: "fake" };
      yield { type: "toolCallStart", toolCallId: "c1", toolName: "add_layer" };
      yield { type: "toolCallStop", toolCallId: "c1", toolArguments: { datasetId: "hi-parcels" } };
      // The runner has now executed the call and reported it back.
      if (this.#pending?.ok) {
        yield { type: "toolCallStart", toolCallId: "c2", toolName: "addWidget" };
        yield {
          type: "toolCallStop",
          toolCallId: "c2",
          toolArguments: { widget: { id: "toc", kind: "toc" } },
        };
      }
      yield { type: "messageStop", stopReason: "endTurn" };
    }
  }

  it("hands each tool outcome back to the driver before the turn continues", async () => {
    const driver = new ScriptedAgentDriver();
    const run = await runEvalTask(instructionTask(), { driver });

    expect(run.driverId).toBe("fake-live");
    expect(driver.results.map((result) => `${result.toolName}:${result.ok}`)).toEqual([
      "add_layer:true",
      "addWidget:true",
    ]);
    expect(driver.results[0].detail).toBe("applied addLayer (local)");
    expect(run.state.widgets.map((widget) => widget.id)).toEqual(["toc"]);
  });

  it("carries each executed tool call into the transcript as a `tool` message the next turn can see", async () => {
    const seen: StudioAiChatMessage[][] = [];
    const driver: EvalTurnDriver = {
      id: "recorder",
      kind: "live",
      async *runTurn(context: EvalTurnContext): AsyncGenerator<StudioAiChatEvent> {
        seen.push([...context.history]);
        yield { type: "toolCallStart", toolCallId: `c${context.turnIndex}`, toolName: "add_layer" };
        yield {
          type: "toolCallStop",
          toolCallId: `c${context.turnIndex}`,
          toolArguments: { datasetId: `d${context.turnIndex}` },
        };
        yield { type: "messageStop", stopReason: "endTurn" };
      },
    };

    await runEvalTask(
      instructionTask({
        turns: [
          { kind: "instruction", instruction: "one" },
          { kind: "instruction", instruction: "two" },
        ],
      }),
      { driver },
    );

    expect(seen[0].map((message) => message.role)).toEqual(["user"]);
    expect(seen[1].map((message) => message.role)).toEqual(["user", "tool", "assistant", "user"]);
    expect(seen[1][1]).toMatchObject({ toolName: "add_layer", content: "applied addLayer (local)" });
  });

  it("brackets a task with beginTask/endTask — where the live lane creates and deletes its disposable draft", async () => {
    const driver = new ScriptedAgentDriver();
    await runEvalTask(instructionTask(), { driver });

    expect(driver.seen[0]).toBe("beginTask");
    expect(driver.seen.at(-1)).toBe("endTask");
    expect(driver.seen).toContain("turn:Add the parcels layer.");
    expect(driver.seen).toContain("history:1");
  });
});
