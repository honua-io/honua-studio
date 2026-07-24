// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { createActivityLog } from "../../src/chat/activity-log.js";
import type { StudioAiChatEvent, StudioAiChatRequest } from "../../src/chat/ai-contract.js";
import { playFixtureConversation } from "../../src/chat/fixture-player.js";
import { FixtureChatTransport } from "../../src/chat/fixture-transport.js";
import { composeDistrictsMapConversation } from "../../src/chat/fixtures/index.js";
import type { ChatTransport } from "../../src/chat/transport.js";
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioChatElement } from "../../src/elements/studio-chat-element.js";

registerAllStudioElements();

function mountChat(): HonuaStudioChatElement {
  const el = document.createElement("honua-studio-chat") as HonuaStudioChatElement;
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("<honua-studio-chat>", () => {
  it("still dispatches honua-studio-chat-message with the exact legacy {text} shape on composer submit (honua-studio#5 contract)", async () => {
    const el = mountChat();
    el.transport = new FixtureChatTransport(composeDistrictsMapConversation);
    const listener = vi.fn();
    el.addEventListener("honua-studio-chat-message", listener);

    const input = el.shadowRoot?.querySelector<HTMLInputElement>("#honua-studio-chat-input");
    const form = el.shadowRoot?.querySelector("form");
    if (input) input.value = "Add the parcels layer";
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ text: "Add the parcels layer" });

    // Let the fixture turn settle so it doesn't leak into the next test.
    await vi.waitFor(() => expect(el.streaming).toBe(false));
  });

  it("addAnnotation()/removeAnnotation() render chips, dispatch typed events, and are folded into the outgoing message content", async () => {
    const el = mountChat();
    const transport: ChatTransport & { lastRequest?: StudioAiChatRequest } = {
      lastRequest: undefined,
      async *streamChat(request, _signal) {
        this.lastRequest = request;
        yield { type: "messageStop", stopReason: "endTurn" } satisfies StudioAiChatEvent;
      },
    };
    el.transport = transport;

    const addedListener = vi.fn();
    el.addEventListener("honua-studio-chat-annotation-added", addedListener);
    const annotation = el.addAnnotation({
      id: "a1",
      kind: "layer",
      payload: { layerId: "hi-parcels" },
      createdAt: "t",
    });

    expect(addedListener).toHaveBeenCalledTimes(1);
    expect(el.pendingAnnotations).toEqual([annotation]);
    const chip = el.shadowRoot?.querySelector('[data-testid="studio-chat-annotation-chip"]');
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toContain("Layer hi-parcels");

    const removedListener = vi.fn();
    el.addEventListener("honua-studio-chat-annotation-removed", removedListener);
    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="studio-chat-annotation-remove"]')?.click();
    expect(removedListener).toHaveBeenCalledTimes(1);
    expect(el.pendingAnnotations).toEqual([]);

    // Re-add and actually send, to prove the annotation context reaches the wire request.
    el.addAnnotation({ id: "a1", kind: "layer", payload: { layerId: "hi-parcels" }, createdAt: "t" });
    await el.sendMessage("What zoning applies?");
    expect(transport.lastRequest?.messages[0]).toEqual({
      role: "user",
      content:
        'What zoning applies?\n\nContext (user-selected references):\n- [layer] Layer hi-parcels :: {"layerId":"hi-parcels"}',
    });
    // The rendered user bubble shows the plain text, never the wire-augmented content.
    expect(el.messages[0]?.text).toBe("What zoning applies?");
  });

  it("adds an annotation via the honua-studio-annotate window event (canvas injection path, REQ-012)", () => {
    const el = mountChat();
    window.dispatchEvent(
      new CustomEvent("honua-studio-annotate", {
        detail: { id: "a2", kind: "feature", payload: { layerId: "L", featureId: 1 } },
      }),
    );
    expect(el.pendingAnnotations).toHaveLength(1);
    expect(el.pendingAnnotations[0]?.id).toBe("a2");
  });

  it("streams a full tool-call turn: renders incremental text, a tool-call card, dispatches intent/turn events, and logs activity", async () => {
    const el = mountChat();
    el.transport = new FixtureChatTransport(composeDistrictsMapConversation);
    el.activityLog = createActivityLog({ clock: () => "FIXED" });

    const toolCallResult = vi.fn();
    const turnComplete = vi.fn();
    el.addEventListener("honua-studio-chat-tool-call-result", toolCallResult);
    el.addEventListener("honua-studio-chat-turn-complete", turnComplete);

    await el.sendMessage("Add the Hawai'i statewide parcels layer and style it by district.");

    expect(el.streaming).toBe(false);
    expect(el.messages).toHaveLength(2); // user + assistant
    const assistant = el.messages[1];
    expect(assistant?.status).toBe("complete");
    expect(assistant?.text).toBe("Adding the parcels layer and styling it by district now.");
    expect(assistant?.toolCalls).toEqual([
      {
        id: "call-1",
        name: "add_layer",
        argumentsText: '{"datasetId":"hi-parcels","styleBy":"district"}',
        args: { datasetId: "hi-parcels", styleBy: "district" },
        status: "complete",
      },
    ]);

    expect(toolCallResult).toHaveBeenCalledTimes(1);
    expect((toolCallResult.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      messageId: assistant?.id,
      toolCallId: "call-1",
      toolName: "add_layer",
      arguments: { datasetId: "hi-parcels", styleBy: "district" },
    });
    expect(turnComplete).toHaveBeenCalledTimes(1);

    const toolCallCard = el.shadowRoot?.querySelector('[data-testid="studio-chat-tool-call"]');
    expect(toolCallCard?.getAttribute("data-status")).toBe("complete");

    const entryTypes = el.activityLog.entries().map((e) => e.type);
    expect(entryTypes).toEqual([
      "user_message_sent",
      "assistant_turn_started",
      "tool_call_started",
      "tool_call_completed",
      "assistant_turn_completed",
    ]);
  });

  it("cancel() aborts an in-flight turn, marks the message cancelled, and dispatches honua-studio-chat-turn-cancelled", async () => {
    const el = mountChat();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport: ChatTransport = {
      async *streamChat(_request, signal) {
        yield { type: "messageStart", model: "m" };
        yield { type: "textDelta", text: "partial" };
        await gate;
        if (signal.aborted) return;
        yield { type: "messageStop", stopReason: "endTurn" };
      },
    };
    el.transport = transport;

    const cancelledListener = vi.fn();
    el.addEventListener("honua-studio-chat-turn-cancelled", cancelledListener);

    const sendPromise = el.sendMessage("hello");
    await vi.waitFor(() => expect(el.streaming).toBe(true));
    el.cancel();
    release?.();
    await sendPromise;

    expect(cancelledListener).toHaveBeenCalledTimes(1);
    const assistant = el.messages.at(-1);
    expect(assistant?.status).toBe("cancelled");
    expect(el.streaming).toBe(false);
  });

  it("a transport-level error surfaces as an error-status message and a turn-error event, without throwing", async () => {
    const el = mountChat();
    const transport: ChatTransport = {
      // biome-ignore lint/correctness/useYield: intentionally throws before any yield to exercise the transport-error path
      async *streamChat(): AsyncGenerator<StudioAiChatEvent> {
        throw new Error("network down");
      },
    };
    el.transport = transport;

    const errorListener = vi.fn();
    el.addEventListener("honua-studio-chat-turn-error", errorListener);
    await el.sendMessage("hello");

    expect(errorListener).toHaveBeenCalledTimes(1);
    expect((errorListener.mock.calls[0]?.[0] as CustomEvent).detail.errorMessage).toBe("network down");
    expect(el.messages.at(-1)?.status).toBe("error");
  });

  it("fixture-conversation replay renders byte-identically across two fresh instances (deterministic, no wall clock)", async () => {
    async function runOnce() {
      const el = document.createElement("honua-studio-chat") as HonuaStudioChatElement;
      document.body.appendChild(el);
      el.transport = new FixtureChatTransport(composeDistrictsMapConversation);
      el.activityLog = createActivityLog({ clock: () => "FIXED" });
      await playFixtureConversation(el, composeDistrictsMapConversation);
      const result = {
        html: el.shadowRoot?.innerHTML,
        messages: el.messages,
        activityLog: el.activityLog.toJSON(),
      };
      document.body.removeChild(el);
      return result;
    }

    const first = await runOnce();
    const second = await runOnce();

    expect(first.html).toBe(second.html);
    expect(first.messages).toEqual(second.messages);
    expect(first.activityLog).toEqual(second.activityLog);
    // Sanity: it's not trivially empty.
    expect(first.messages.length).toBeGreaterThan(0);
    expect(first.html).toContain("add_layer");
  });
});
