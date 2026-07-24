import { describe, expect, it } from "vitest";

import { InvalidFixtureConversationError, parseFixtureConversation } from "../../src/chat/fixture-conversation.js";
import { annotateParcelFeatureConversation, composeDistrictsMapConversation } from "../../src/chat/fixtures/index.js";

describe("chat/fixture-conversation", () => {
  it("both required fixtures parse and have at least one turn", () => {
    for (const conversation of [composeDistrictsMapConversation, annotateParcelFeatureConversation]) {
      expect(conversation.turns.length).toBeGreaterThan(0);
      expect(conversation.id.length).toBeGreaterThan(0);
      expect(conversation.title.length).toBeGreaterThan(0);
    }
  });

  it("the annotation-referencing fixture actually carries annotation seeds", () => {
    const seeded = annotateParcelFeatureConversation.turns.some((turn) => (turn.user.annotations?.length ?? 0) > 0);
    expect(seeded).toBe(true);
  });

  it("every fixture turn's assistant events end in a terminal event (messageStop or error)", () => {
    for (const conversation of [composeDistrictsMapConversation, annotateParcelFeatureConversation]) {
      for (const turn of conversation.turns) {
        const last = turn.assistant.events.at(-1);
        expect(["messageStop", "error"]).toContain(last?.type);
      }
    }
  });

  it("rejects a non-object value", () => {
    expect(() => parseFixtureConversation(null)).toThrow(InvalidFixtureConversationError);
    expect(() => parseFixtureConversation("nope")).toThrow(InvalidFixtureConversationError);
  });

  it("rejects a missing/empty id or title", () => {
    expect(() =>
      parseFixtureConversation({ id: "", title: "t", turns: [{ user: { text: "" }, assistant: { events: [] } }] }),
    ).toThrow(InvalidFixtureConversationError);
    expect(() =>
      parseFixtureConversation({ id: "i", title: "", turns: [{ user: { text: "" }, assistant: { events: [] } }] }),
    ).toThrow(InvalidFixtureConversationError);
  });

  it("rejects an empty turns array", () => {
    expect(() => parseFixtureConversation({ id: "i", title: "t", turns: [] })).toThrow(InvalidFixtureConversationError);
  });

  it("rejects a turn missing user/assistant or with a malformed events array", () => {
    expect(() => parseFixtureConversation({ id: "i", title: "t", turns: [{ user: { text: "hi" } }] })).toThrow(
      InvalidFixtureConversationError,
    );
    expect(() =>
      parseFixtureConversation({
        id: "i",
        title: "t",
        turns: [{ user: { text: "hi" }, assistant: { events: "nope" } }],
      }),
    ).toThrow(InvalidFixtureConversationError);
  });

  it("accepts a minimal valid conversation", () => {
    const parsed = parseFixtureConversation({
      id: "i",
      title: "t",
      turns: [{ user: { text: "hi" }, assistant: { events: [{ type: "messageStop", stopReason: "endTurn" }] } }],
    });
    expect(parsed.turns).toHaveLength(1);
  });
});
