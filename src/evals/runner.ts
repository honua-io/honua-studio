/**
 * The corpus runner (honua-studio#46 REQ-001): plays one {@link EvalTask}
 * through the *real* composition loop and returns what the loop actually
 * produced — final composition state, the activity log, and every observed
 * tool call with its outcome.
 *
 * "Real" is the point. The runner owns no composition logic of its own: it
 * mirrors `<honua-studio-chat>`'s `#runAssistantTurn()` event handling (same
 * activity-log entry types, same order) and hands every `toolCallStop` to the
 * app's own `ToolCallOrchestrator`, which resolves it through
 * `../mcp/tool-bridge.ts` and applies it through `../composition/reducer.ts`.
 * So a corpus failure is a failure of the composition loop or of the model
 * turn — never of a parallel implementation written for the eval harness.
 *
 * The element itself is not reused because it needs a DOM; the runner is
 * pure Node, so the corpus runs in the default Vitest suite (`npm test`,
 * `environment: "node"`) with no browser.
 *
 * The orchestrator runs in fixture/offline mode (no live MCP session), so
 * every command applies through the local reducer. The live lane
 * (honua-studio#40, out of scope) attaches a session via
 * `ToolCallOrchestrator.attachLiveSession` — see {@link EvalRunOptions.live}.
 *
 * @module
 */

import { type ActivityLog, type ActivityLogEntry, createActivityLog } from "../chat/activity-log.js";
import type { StudioAiChatMessage } from "../chat/ai-contract.js";
import { CompositionController } from "../composition/controller.js";
import { type CompositionState, createEmptyCompositionState } from "../composition/model.js";
import { applyCompositionCommands } from "../composition/reducer.js";
import {
  type ToolCallOrchestrationResult,
  ToolCallOrchestrator,
  type ToolCallOrchestratorLiveOptions,
} from "../mcp/orchestrator.js";
import type { EvalToolResult, EvalTurnDriver } from "./driver.js";
import type { EvalKnownBadVariant, EvalTask, EvalTurn } from "./types.js";

/** One tool call the assistant made, and what the composition loop did with it. */
export interface ObservedToolCall {
  readonly turnIndex: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly outcome: ToolCallOrchestrationResult;
}

export interface EvalTurnRecord {
  readonly turnIndex: number;
  readonly kind: EvalTurn["kind"];
  readonly instruction?: string;
  readonly action?: "undo" | "redo";
  /** Concatenated assistant text. Recorded for the transcript, never scored. */
  readonly assistantText?: string;
  /** For a user-action turn: whether the history had anything to undo/redo. */
  readonly applied?: boolean;
}

export interface EvalRunResult {
  readonly task: EvalTask;
  readonly driverId: string;
  readonly state: CompositionState;
  readonly entries: readonly ActivityLogEntry[];
  readonly toolCalls: readonly ObservedToolCall[];
  readonly turns: readonly EvalTurnRecord[];
}

export interface EvalRunOptions {
  readonly driver: EvalTurnDriver;
  /** Defaults to a deterministic, monotonic ISO clock so fixture runs are byte-stable. */
  readonly clock?: () => string;
  /**
   * Live-session options handed to the orchestrator. Reserved for the
   * post-honua-studio#40 lane: with it set, resolved commands that have a
   * `honua_studio_*` counterpart go to the server draft instead of the local
   * reducer. Fixture runs leave it undefined.
   */
  readonly live?: ToolCallOrchestratorLiveOptions;
}

/** A monotonic, wall-clock-free ISO clock — fixture runs must never depend on real time (NFR-001). */
export function createEvalClock(startMs = Date.UTC(2026, 0, 1)): () => string {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(startMs + tick * 1000).toISOString();
  };
}

/**
 * Rewrites a task with a known-bad variant's assistant scripts substituted in
 * — the deliberately miscomposed transcript REQ-003's gate runs. Everything
 * else (instructions, setup, expectations) is untouched: the expectation is
 * what the variant must fail against.
 */
export function withKnownBadVariant(task: EvalTask, variant: EvalKnownBadVariant): EvalTask {
  const overrides = new Map(variant.turns.map((entry) => [entry.turnIndex, entry.assistant]));
  const turns = task.turns.map((turn, index) => {
    const override = overrides.get(index);
    if (!override) return turn;
    if (turn.kind !== "instruction") {
      throw new Error(
        `Known-bad variant "${variant.id}" of task "${task.id}" overrides turn ${index}, which is a ${turn.kind} turn.`,
      );
    }
    return { ...turn, assistant: override };
  });
  return { ...task, id: `${task.id}#${variant.id}`, turns };
}

/** Runs one task end to end. Never scores — see `scorer.ts`. */
export async function runEvalTask(task: EvalTask, options: EvalRunOptions): Promise<EvalRunResult> {
  const { driver } = options;
  const initialState = task.setup?.length
    ? applyCompositionCommands(createEmptyCompositionState(), task.setup).state
    : createEmptyCompositionState();
  const controller = new CompositionController(initialState);
  const activityLog = createActivityLog({ clock: options.clock ?? createEvalClock() });
  const orchestrator = new ToolCallOrchestrator({
    controller,
    activityLog,
    ...(options.live ? { live: options.live } : {}),
  });

  const history: StudioAiChatMessage[] = [];
  const toolCalls: ObservedToolCall[] = [];
  const turns: EvalTurnRecord[] = [];
  let instructionIndex = 0;
  let messageCounter = 0;

  await driver.beginTask?.(task);
  try {
    for (const [turnIndex, turn] of task.turns.entries()) {
      if (turn.kind === "user-action") {
        const applied = turn.action === "undo" ? controller.undo() : controller.redo();
        turns.push({ turnIndex, kind: turn.kind, action: turn.action, applied });
        continue;
      }

      messageCounter += 1;
      const userMessageId = `m${messageCounter}`;
      history.push({ role: "user", content: turn.instruction });
      activityLog.append("user_message_sent", { messageId: userMessageId, text: turn.instruction });

      messageCounter += 1;
      const assistantMessageId = `m${messageCounter}`;
      activityLog.append("assistant_turn_started", { messageId: assistantMessageId });

      const assistantText = await runAssistantTurn({
        task,
        turnIndex,
        instructionIndex,
        instruction: turn.instruction,
        driver,
        controller,
        orchestrator,
        activityLog,
        assistantMessageId,
        history,
        toolCalls,
      });

      history.push({ role: "assistant", content: assistantText });
      turns.push({ turnIndex, kind: turn.kind, instruction: turn.instruction, assistantText });
      instructionIndex += 1;
    }
  } finally {
    await driver.endTask?.(task);
  }

  return {
    task,
    driverId: driver.id,
    state: controller.state,
    entries: activityLog.entries(),
    toolCalls,
    turns,
  };
}

interface AssistantTurnArgs {
  readonly task: EvalTask;
  readonly turnIndex: number;
  readonly instructionIndex: number;
  readonly instruction: string;
  readonly driver: EvalTurnDriver;
  readonly controller: CompositionController;
  readonly orchestrator: ToolCallOrchestrator;
  readonly activityLog: ActivityLog;
  readonly assistantMessageId: string;
  /** Mutated in place: executed tool calls append their `{ role: "tool" }` result, so a later turn's request carries the whole transcript. */
  readonly history: StudioAiChatMessage[];
  readonly toolCalls: ObservedToolCall[];
}

/** One assistant turn, mirroring `<honua-studio-chat>`'s own event loop (see this module's doc). */
async function runAssistantTurn(args: AssistantTurnArgs): Promise<string> {
  const { activityLog, assistantMessageId, controller, driver, orchestrator, toolCalls } = args;
  const pendingToolNames = new Map<string, string>();
  let text = "";

  const stream = driver.runTurn({
    task: args.task,
    turnIndex: args.turnIndex,
    instructionIndex: args.instructionIndex,
    instruction: args.instruction,
    history: args.history,
    state: controller.state,
  });

  for await (const event of stream) {
    if (event.type === "textDelta") {
      text += event.text ?? "";
    } else if (event.type === "toolCallStart" && event.toolCallId && event.toolName) {
      pendingToolNames.set(event.toolCallId, event.toolName);
      activityLog.append("tool_call_started", {
        messageId: assistantMessageId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
    } else if (event.type === "toolCallStop" && event.toolCallId) {
      const toolName = event.toolName ?? pendingToolNames.get(event.toolCallId) ?? "";
      const toolArguments = isPlainObject(event.toolArguments) ? event.toolArguments : {};
      activityLog.append("tool_call_completed", {
        messageId: assistantMessageId,
        toolCallId: event.toolCallId,
        toolName,
        arguments: event.toolArguments,
      });
      const outcome = await orchestrator.handleToolCall({ toolName, arguments: toolArguments });
      toolCalls.push({
        turnIndex: args.turnIndex,
        toolCallId: event.toolCallId,
        toolName,
        arguments: toolArguments,
        outcome,
      });
      // Hand the outcome back to the driver: the live lane turns this into
      // the next `{ role: "tool" }` message before the model continues.
      const result: EvalToolResult = {
        toolCallId: event.toolCallId,
        toolName,
        ok: outcome.ok,
        detail: outcome.ok ? `applied ${outcome.command.name} (${outcome.mode})` : `${outcome.code}: ${outcome.reason}`,
      };
      args.history.push({
        role: "tool",
        content: result.detail,
        toolCallId: result.toolCallId,
        toolName: result.toolName,
      });
      await driver.reportToolResult?.(result);
    } else if (event.type === "messageStop") {
      activityLog.append("assistant_turn_completed", {
        messageId: assistantMessageId,
        stopReason: event.stopReason,
        promptTokens: event.promptTokens,
        completionTokens: event.completionTokens,
        latencyMs: event.latencyMs,
      });
    } else if (event.type === "error") {
      activityLog.append("assistant_turn_error", {
        messageId: assistantMessageId,
        errorMessage: event.errorMessage ?? "The Studio AI proxy reported an error.",
      });
    }
  }

  return text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
