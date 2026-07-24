import { describe, expect, it } from "vitest";

import { createAnnotationRef } from "../../src/chat/annotation.js";
import { type ChatState, chatReducer, initialChatState } from "../../src/chat/message-reducer.js";

const ANNOTATION = createAnnotationRef({
  id: "a1",
  kind: "layer" as const,
  payload: { layerId: "hi-parcels" },
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("chat/message-reducer", () => {
  it("starts empty", () => {
    expect(initialChatState).toEqual({ messages: [], pendingAnnotations: [], streaming: false });
  });

  it("user-message-sent appends a complete user message and clears pending annotations", () => {
    let state: ChatState = chatReducer(initialChatState, { type: "annotation-added", annotation: ANNOTATION });
    state = chatReducer(state, { type: "user-message-sent", id: "m1", text: "hello", annotations: [ANNOTATION] });

    expect(state.messages).toEqual([
      { id: "m1", role: "user", text: "hello", annotations: [ANNOTATION], toolCalls: [], status: "complete" },
    ]);
    expect(state.pendingAnnotations).toEqual([]);
  });

  it("assistant-turn-started appends a streaming assistant message and sets streaming=true", () => {
    const state = chatReducer(initialChatState, { type: "assistant-turn-started", id: "m2" });
    expect(state.streaming).toBe(true);
    expect(state.messages).toEqual([
      { id: "m2", role: "assistant", text: "", annotations: [], toolCalls: [], status: "streaming" },
    ]);
  });

  it("accumulates textDelta events onto the target message only", () => {
    let state = chatReducer(initialChatState, { type: "assistant-turn-started", id: "m2" });
    state = chatReducer(state, { type: "ai-event", id: "m2", event: { type: "messageStart", model: "claude" } });
    state = chatReducer(state, { type: "ai-event", id: "m2", event: { type: "textDelta", text: "Hel" } });
    state = chatReducer(state, { type: "ai-event", id: "m2", event: { type: "textDelta", text: "lo" } });

    const message = state.messages.find((m) => m.id === "m2");
    expect(message?.text).toBe("Hello");
    expect(message?.model).toBe("claude");
  });

  it("runs a full tool-call lifecycle: start -> delta(s) -> stop", () => {
    let state = chatReducer(initialChatState, { type: "assistant-turn-started", id: "m2" });
    state = chatReducer(state, {
      type: "ai-event",
      id: "m2",
      event: { type: "toolCallStart", toolCallId: "call-1", toolName: "add_layer" },
    });
    state = chatReducer(state, {
      type: "ai-event",
      id: "m2",
      event: { type: "toolCallDelta", toolCallId: "call-1", toolArgumentsDelta: '{"a":' },
    });
    state = chatReducer(state, {
      type: "ai-event",
      id: "m2",
      event: { type: "toolCallDelta", toolCallId: "call-1", toolArgumentsDelta: "1}" },
    });

    let toolCall = state.messages[0]?.toolCalls[0];
    expect(toolCall).toEqual({ id: "call-1", name: "add_layer", argumentsText: '{"a":1}', status: "pending" });

    state = chatReducer(state, {
      type: "ai-event",
      id: "m2",
      event: { type: "toolCallStop", toolCallId: "call-1", toolArguments: { a: 1 } },
    });
    toolCall = state.messages[0]?.toolCalls[0];
    expect(toolCall).toEqual({
      id: "call-1",
      name: "add_layer",
      argumentsText: '{"a":1}',
      args: { a: 1 },
      status: "complete",
    });
  });

  it("supports two concurrent-looking tool calls without cross-contamination", () => {
    let state = chatReducer(initialChatState, { type: "assistant-turn-started", id: "m2" });
    state = chatReducer(state, {
      type: "ai-event",
      id: "m2",
      event: { type: "toolCallStart", toolCallId: "call-1", toolName: "a" },
    });
    state = chatReducer(state, {
      type: "ai-event",
      id: "m2",
      event: { type: "toolCallStart", toolCallId: "call-2", toolName: "b" },
    });
    state = chatReducer(state, {
      type: "ai-event",
      id: "m2",
      event: { type: "toolCallDelta", toolCallId: "call-2", toolArgumentsDelta: "x" },
    });
    const toolCalls = state.messages[0]?.toolCalls;
    expect(toolCalls).toEqual([
      { id: "call-1", name: "a", argumentsText: "", status: "pending" },
      { id: "call-2", name: "b", argumentsText: "x", status: "pending" },
    ]);
  });

  it("messageStop marks the message complete, records stopReason, and clears streaming", () => {
    let state = chatReducer(initialChatState, { type: "assistant-turn-started", id: "m2" });
    state = chatReducer(state, { type: "ai-event", id: "m2", event: { type: "messageStop", stopReason: "endTurn" } });
    expect(state.streaming).toBe(false);
    expect(state.messages[0]).toMatchObject({ status: "complete", stopReason: "endTurn" });
  });

  it("an in-band error event marks the message errored and stops streaming", () => {
    let state = chatReducer(initialChatState, { type: "assistant-turn-started", id: "m2" });
    state = chatReducer(state, { type: "ai-event", id: "m2", event: { type: "error", errorMessage: "boom" } });
    expect(state.streaming).toBe(false);
    expect(state.messages[0]).toMatchObject({ status: "error", errorMessage: "boom" });
  });

  it("turn-cancelled only affects a still-streaming message", () => {
    let state = chatReducer(initialChatState, { type: "assistant-turn-started", id: "m2" });
    state = chatReducer(state, { type: "turn-cancelled", id: "m2" });
    expect(state.messages[0]?.status).toBe("cancelled");
    expect(state.streaming).toBe(false);

    // Cancelling an already-complete message is a no-op.
    let complete = chatReducer(initialChatState, { type: "assistant-turn-started", id: "m3" });
    complete = chatReducer(complete, {
      type: "ai-event",
      id: "m3",
      event: { type: "messageStop", stopReason: "endTurn" },
    });
    complete = chatReducer(complete, { type: "turn-cancelled", id: "m3" });
    expect(complete.messages[0]?.status).toBe("complete");
  });

  it("annotation-added is idempotent for a duplicate id", () => {
    let state = chatReducer(initialChatState, { type: "annotation-added", annotation: ANNOTATION });
    state = chatReducer(state, { type: "annotation-added", annotation: ANNOTATION });
    expect(state.pendingAnnotations).toHaveLength(1);
  });

  it("annotation-removed filters by id", () => {
    let state = chatReducer(initialChatState, { type: "annotation-added", annotation: ANNOTATION });
    state = chatReducer(state, { type: "annotation-removed", id: ANNOTATION.id });
    expect(state.pendingAnnotations).toEqual([]);
  });

  it("reset returns to the initial state", () => {
    let state = chatReducer(initialChatState, { type: "annotation-added", annotation: ANNOTATION });
    state = chatReducer(state, { type: "reset" });
    expect(state).toEqual(initialChatState);
  });

  it("never mutates the input state object", () => {
    const before = chatReducer(initialChatState, { type: "assistant-turn-started", id: "m2" });
    const snapshot = JSON.parse(JSON.stringify(before));
    chatReducer(before, { type: "ai-event", id: "m2", event: { type: "textDelta", text: "x" } });
    expect(before).toEqual(snapshot);
  });
});
