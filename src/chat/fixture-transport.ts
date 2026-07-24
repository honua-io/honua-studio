/**
 * Deterministic scripted-conversation transport (honua-studio#6, AD-4's
 * "no-model fixture-conversation mode" / NFR-001). Plays a
 * {@link FixtureConversation} turn-by-turn: each `streamChat()` call
 * replays the NEXT scripted assistant turn's events, in fixed chunking
 * (exactly the events the fixture author wrote, no re-splitting), with no
 * `setTimeout`/wall-clock dependency of any kind — only a microtask
 * boundary (`await Promise.resolve()`) between events, so callers still see
 * genuinely async streaming without any real delay. Byte-stable across runs
 * — see `test/chat/fixture-replay.test.ts`.
 */
import type { StudioAiChatEvent, StudioAiChatRequest } from "./ai-contract.js";
import type { FixtureConversation } from "./fixture-conversation.js";
import type { ChatTransport } from "./transport.js";

export class FixtureChatTransport implements ChatTransport {
  #turnIndex = 0;

  constructor(private readonly conversation: FixtureConversation) {}

  /** Rewinds to the first scripted turn — lets a single instance be reused across a fresh conversation replay. */
  reset(): void {
    this.#turnIndex = 0;
  }

  /** How many scripted turns have been consumed so far. */
  get turnsPlayed(): number {
    return this.#turnIndex;
  }

  async *streamChat(_request: StudioAiChatRequest, signal: AbortSignal): AsyncGenerator<StudioAiChatEvent> {
    const turn = this.conversation.turns[this.#turnIndex];
    this.#turnIndex += 1;
    if (!turn) {
      yield {
        type: "error",
        errorMessage: `FixtureChatTransport: no scripted turn ${this.#turnIndex} in fixture "${this.conversation.id}" (${this.conversation.turns.length} turn(s) total).`,
      };
      return;
    }
    for (const event of turn.assistant.events) {
      if (signal.aborted) return;
      // Deterministic async boundary — never a real timer (NFR-001: no
      // wall-clock-dependent timing anywhere in fixture-conversation mode).
      await Promise.resolve();
      if (signal.aborted) return;
      yield event;
    }
  }
}
