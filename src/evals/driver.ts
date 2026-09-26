/**
 * The transcript driver seam (honua-studio#46 REQ-001/REQ-003).
 *
 * An eval task says what the user asked for and what the composition should
 * look like afterwards. *How the assistant turn is produced* is deliberately
 * behind one interface, {@link EvalTurnDriver}:
 *
 *  - **Today (PR-safe, model-free):** {@link FixtureTurnDriver} yields the
 *    scripted `StudioAiChatEvent`s a task authored — either synthesized from
 *    a {@link FixtureAssistantScript}, or replayed verbatim from a real
 *    `src/chat/fixtures/*.json` conversation through the app's own
 *    `FixtureChatTransport`. This is REQ-003's floor: deterministic, no
 *    network, no model, byte-stable across runs.
 *  - **After honua-studio#40 (live lane, out of scope here):** a driver that
 *    runs the instruction through `StudioAgentSession` against the real SSE
 *    proxy and yields the events the model actually produced. Nothing else in
 *    this module changes: the runner, the orchestrator, the reducer, the
 *    activity log, and every typed expectation are shared by both lanes, so a
 *    live scorecard is comparable to the fixture floor by construction.
 *
 * The interface is an async iterable of the *wire* event type
 * (`../chat/ai-contract.ts`) rather than of already-resolved tool calls on
 * purpose: that is exactly what both a fixture transport and the live SSE
 * transport emit, so neither lane needs a translation shim, and the runner
 * mirrors `<honua-studio-chat>`'s own turn loop step for step.
 *
 * {@link EvalTurnDriver.reportToolResult} closes the loop in the other
 * direction: the runner executes each tool call through the real
 * `ToolCallOrchestrator` and hands the outcome back, which is what a live
 * driver must feed to the model as the next `{ role: "tool" }` message before
 * it continues generating (an in-flight generator awaits it there). The
 * fixture driver does not implement it — a scripted turn has nothing to wait
 * for.
 *
 * @module
 */

import type { StudioAiChatEvent, StudioAiChatMessage } from "../chat/ai-contract.js";
import { FixtureChatTransport } from "../chat/fixture-transport.js";
import type { CompositionState } from "../composition/model.js";
import type { EvalTask, FixtureAssistantScript } from "./types.js";

/** The outcome of one executed tool call, as reported back to the driver. */
export interface EvalToolResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly ok: boolean;
  /** Human-readable outcome — the content a live driver puts in the `{ role: "tool" }` message. */
  readonly detail: string;
}

/** Everything a driver needs to produce one assistant turn. */
export interface EvalTurnContext {
  readonly task: EvalTask;
  /** Index into `task.turns` (user-action turns included). */
  readonly turnIndex: number;
  /** Index among instruction turns only — the conversation turn number. */
  readonly instructionIndex: number;
  readonly instruction: string;
  /** Conversation history so far, oldest first — what a live driver sends to the proxy. */
  readonly history: readonly StudioAiChatMessage[];
  /** Composition state at the start of this turn — a live driver summarizes it into its system prompt. */
  readonly state: CompositionState;
}

export interface EvalTurnDriver {
  /** Stable identity of the lane, recorded on every {@link EvalScore} (`fixture`, `live:claude-sonnet-4-5`, …). */
  readonly id: string;
  readonly kind: "fixture" | "live";
  /** Called once before a task's first turn. The live lane creates its disposable draft here (#46: "drafts created and deleted per run"). */
  beginTask?(task: EvalTask): void | Promise<void>;
  /** Called once after the last turn, including when a turn failed. The live lane deletes its draft here. */
  endTask?(task: EvalTask): void | Promise<void>;
  /** Called by the runner once per executed tool call, in order, before the turn continues — see the module doc. */
  reportToolResult?(result: EvalToolResult): void | Promise<void>;
  runTurn(context: EvalTurnContext): AsyncIterable<StudioAiChatEvent>;
}

/** Thrown when a task cannot supply a fixture transcript for a turn — an authoring error, surfaced loudly rather than scored as a model failure. */
export class EvalDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalDriverError";
  }
}

/**
 * Turns one scripted assistant reply into the event stream the proxy would
 * have produced: `messageStart`, text deltas, then per tool call a
 * `toolCallStart` / `toolCallDelta` / `toolCallStop` triple, then
 * `messageStop`.
 *
 * The tool name rides on `toolCallStart` only — never on `toolCallStop` —
 * because that is what honua-server's proxy does (`ai-contract.ts`: "Tool
 * name. Set on `toolCallStart`"), and the runner must be exercised against
 * the real shape rather than a convenient one.
 */
export function scriptedTurnEvents(script: FixtureAssistantScript, turnNumber: number): readonly StudioAiChatEvent[] {
  const events: StudioAiChatEvent[] = [{ type: "messageStart", model: "fixture" }];
  if (script.text !== undefined) events.push({ type: "textDelta", text: script.text });
  const toolCalls = script.toolCalls ?? [];
  toolCalls.forEach((call, index) => {
    const toolCallId = `eval-t${turnNumber}-c${index + 1}`;
    events.push({ type: "toolCallStart", toolCallId, toolName: call.toolName });
    events.push({ type: "toolCallDelta", toolCallId, toolArgumentsDelta: JSON.stringify(call.arguments) });
    events.push({ type: "toolCallStop", toolCallId, toolArguments: call.arguments });
  });
  events.push({
    type: "messageStop",
    stopReason: script.stopReason ?? (toolCalls.length > 0 ? "toolCall" : "endTurn"),
  });
  return events;
}

/**
 * The PR-safe lane. Prefers a turn's own {@link FixtureAssistantScript}; falls
 * back to the task's {@link EvalTask.fixtureConversation}, replayed through
 * the app's own `FixtureChatTransport` so the corpus rides the same
 * fixture-conversation machinery the Playwright journeys do.
 *
 * That precedence is load-bearing for REQ-003: a known-bad variant overrides
 * a single turn of an otherwise-real fixture conversation without having to
 * fork the conversation file.
 */
export class FixtureTurnDriver implements EvalTurnDriver {
  public readonly id = "fixture";
  public readonly kind = "fixture" as const;

  #transport: FixtureChatTransport | undefined;
  #transportTurn = 0;

  public beginTask(task: EvalTask): void {
    this.#transport = task.fixtureConversation ? new FixtureChatTransport(task.fixtureConversation) : undefined;
    this.#transportTurn = 0;
  }

  public async *runTurn(context: EvalTurnContext): AsyncGenerator<StudioAiChatEvent> {
    const turn = context.task.turns[context.turnIndex];
    const script = turn?.kind === "instruction" ? turn.assistant : undefined;
    if (script) {
      // Keep a conversation-backed task's transport aligned: the scripted
      // reply STANDS IN FOR this conversation turn (that is how a known-bad
      // variant overrides one turn of a real fixture conversation), so the
      // turn it replaces must still be consumed.
      await this.#skipConversationTurn(context);
      for (const event of scriptedTurnEvents(script, context.instructionIndex + 1)) {
        // A microtask boundary, never a timer — same determinism rule
        // `FixtureChatTransport` documents (NFR-001).
        await Promise.resolve();
        yield event;
      }
      return;
    }

    const transport = this.#transport;
    if (!transport) {
      throw new EvalDriverError(
        `Task "${context.task.id}" turn ${context.turnIndex} has no scripted assistant reply and the task has no fixtureConversation.`,
      );
    }
    this.#transportTurn += 1;
    yield* transport.streamChat({ messages: context.history }, new AbortController().signal);
  }

  async #skipConversationTurn(context: EvalTurnContext): Promise<void> {
    const transport = this.#transport;
    if (!transport || this.#transportTurn > context.instructionIndex) return;
    this.#transportTurn += 1;
    for await (const _event of transport.streamChat({ messages: context.history }, new AbortController().signal)) {
      // Drained: the scripted reply replaces this turn's events.
    }
  }
}
