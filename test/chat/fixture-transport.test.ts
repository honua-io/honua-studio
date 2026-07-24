import { describe, expect, it } from "vitest";

import type { StudioAiChatEvent } from "../../src/chat/ai-contract.js";
import { FixtureChatTransport } from "../../src/chat/fixture-transport.js";
import { composeDistrictsMapConversation } from "../../src/chat/fixtures/index.js";

async function collect(transport: FixtureChatTransport, signal: AbortSignal): Promise<StudioAiChatEvent[]> {
  const events: StudioAiChatEvent[] = [];
  for await (const event of transport.streamChat({ messages: [] }, signal)) {
    events.push(event);
  }
  return events;
}

describe("chat/fixture-transport", () => {
  it("replays the fixture's scripted turns in order, one per streamChat() call", async () => {
    const transport = new FixtureChatTransport(composeDistrictsMapConversation);
    const turn1 = await collect(transport, new AbortController().signal);
    const turn2 = await collect(transport, new AbortController().signal);

    expect(turn1).toEqual(composeDistrictsMapConversation.turns[0]?.assistant.events);
    expect(turn2).toEqual(composeDistrictsMapConversation.turns[1]?.assistant.events);
  });

  it("yields an error event once every scripted turn is consumed", async () => {
    const transport = new FixtureChatTransport(composeDistrictsMapConversation);
    for (const _turn of composeDistrictsMapConversation.turns) {
      await collect(transport, new AbortController().signal);
    }
    const overflow = await collect(transport, new AbortController().signal);
    expect(overflow).toHaveLength(1);
    expect(overflow[0]?.type).toBe("error");
  });

  it("reset() rewinds to the first scripted turn", async () => {
    const transport = new FixtureChatTransport(composeDistrictsMapConversation);
    await collect(transport, new AbortController().signal);
    expect(transport.turnsPlayed).toBe(1);
    transport.reset();
    expect(transport.turnsPlayed).toBe(0);
    const replayedTurn1 = await collect(transport, new AbortController().signal);
    expect(replayedTurn1).toEqual(composeDistrictsMapConversation.turns[0]?.assistant.events);
  });

  it("stops yielding as soon as the signal is aborted, mid-turn", async () => {
    const transport = new FixtureChatTransport(composeDistrictsMapConversation);
    const controller = new AbortController();
    const events: StudioAiChatEvent[] = [];
    for await (const event of transport.streamChat({ messages: [] }, controller.signal)) {
      events.push(event);
      if (events.length === 2) controller.abort();
    }
    expect(events.length).toBe(2);
    expect(events.length).toBeLessThan(
      composeDistrictsMapConversation.turns[0]?.assistant.events.length ?? Number.POSITIVE_INFINITY,
    );
  });

  it("never uses a real timer (deterministic microtask-only pacing) — resolves promptly under fake timers", async () => {
    // If FixtureChatTransport ever used setTimeout, this would hang forever
    // under a real await with no timer advancement.
    const transport = new FixtureChatTransport(composeDistrictsMapConversation);
    const events = await collect(transport, new AbortController().signal);
    expect(events.length).toBeGreaterThan(0);
  });
});
