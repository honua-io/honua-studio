// @vitest-environment happy-dom

import { McpClient as SdkMcpClient } from "@honua/sdk-js/studio-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createActivityLog } from "../../src/chat/activity-log.js";
import type { StudioAiChatEvent, StudioAiChatRequest } from "../../src/chat/ai-contract.js";
import { playFixtureConversation } from "../../src/chat/fixture-player.js";
import { FixtureChatTransport } from "../../src/chat/fixture-transport.js";
import { composeDistrictsMapConversation } from "../../src/chat/fixtures/index.js";
import { STATIC_STUDIO_AGENT_TOOLS } from "../../src/chat/studio-agent-tools.js";
import type { ChatTransport } from "../../src/chat/transport.js";
import { CompositionController } from "../../src/composition/controller.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioChatElement } from "../../src/elements/studio-chat-element.js";
import { applyStudioDraft } from "../../src/mcp/tool-bridge.js";

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
  it("runs a model-selected server tool, feeds its result back, and refreshes the real canvas controller", async () => {
    const el = mountChat();
    const controller = new CompositionController(createEmptyCompositionState());
    const requests: StudioAiChatRequest[] = [];
    const mcpCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    let round = 0;
    const model: ChatTransport = {
      async *streamChat(request) {
        requests.push(request);
        round += 1;
        if (round === 1) {
          yield { type: "toolCallStart", toolCallId: "call-1", toolName: "honua_studio_set_view" };
          yield { type: "toolCallDelta", toolCallId: "call-1", toolArgumentsDelta: '{"view":{"zoom":9}}' };
          yield { type: "toolCallStop", toolCallId: "call-1", toolArguments: { view: { zoom: 9 } } };
          yield { type: "messageStop", stopReason: "toolCall" };
          return;
        }
        yield { type: "textDelta", text: "Zoomed the map." };
        yield { type: "messageStop", stopReason: "endTurn" };
      },
    };
    const draft = {
      draftId: "draft-1",
      packageKey: "map-1",
      generation: 2,
      envelope: { family: "map" as const, schemaVersion: "1.0", body: { layers: [], view: { zoom: 9 }, widgets: [] } },
    };
    const mcpClient = new SdkMcpClient({
      fetchImpl: vi.fn(async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as {
          method: string;
          params?: { name: string; arguments: Record<string, unknown> };
          id: string;
        };
        if (request.method === "initialize") {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-03-26" } }),
            { headers: { "content-type": "application/json", "mcp-session-id": "session-1" } },
          );
        }
        if (request.method === "tools/list") {
          const tool = setViewTool[0];
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                tools: [
                  {
                    name: tool?.name,
                    description: tool?.description,
                    inputSchema: tool?.inputSchema,
                    _meta: { "honua.studio": { family: "honua.studio.composition", view: "studio" } },
                  },
                ],
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (request.params) mcpCalls.push(request.params);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { structuredContent: draft } }), {
          headers: { "content-type": "application/json" },
        });
      }),
    });
    const setViewTool = STATIC_STUDIO_AGENT_TOOLS.filter((tool) => tool.name === "honua_studio_set_view");

    el.attachAgentSession({
      transport: model,
      mcpClient,
      draft: { draftId: "draft-1", generation: 1 },
      system: "grounded system prompt",
      fetchImpl: vi.fn(() => Promise.reject(new Error("capabilities unavailable"))),
      onEvent: (event) => {
        if (event.type === "toolResult" && event.result.draft) {
          controller.replaceState(applyStudioDraft(event.result.draft as never, controller.state));
        }
      },
    });
    await el.sendMessage("Zoom in");

    expect(controller.state.view.zoom).toBe(9);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.system).toBe("grounded system prompt");
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(["honua_studio_set_view"]);
    expect(mcpCalls).toEqual([
      { name: "honua_studio_set_view", arguments: { view: { zoom: 9 }, draftId: "draft-1", generation: 1 } },
    ]);
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
      toolName: "honua_studio_set_view",
    });
    expect(requests[1]?.messages.at(-1)?.content).toContain('"status":"ok"');
    expect(el.messages.at(-1)?.text).toBe("Zoomed the map.");
    expect(el.messages.at(-1)?.status).toBe("complete");
    expect(el.activityLog.entries().map((entry) => entry.type)).toContain("tool_call_completed");
  });

  it("keeps explicit fixture transport authoritative over an attached live agent session", async () => {
    const el = mountChat();
    const liveTransport: ChatTransport = {
      // biome-ignore lint/correctness/useYield: a call proves the fixture override failed
      async *streamChat() {
        throw new Error("live session must have been detached");
      },
    };
    el.attachAgentSession({ transport: liveTransport });
    el.transport = new FixtureChatTransport(composeDistrictsMapConversation);

    await el.sendMessage("Add parcels");

    expect(el.messages.at(-1)?.status).toBe("complete");
    expect(el.messages.at(-1)?.toolCalls[0]?.name).toBe("add_layer");
  });

  it("rejects an overlapping public send while an SDK session turn is active", async () => {
    const el = mountChat();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    el.attachAgentSession({
      transport: {
        async *streamChat() {
          yield { type: "textDelta", text: "first" };
          await gate;
          yield { type: "messageStop", stopReason: "endTurn" };
        },
      },
    });

    const first = el.sendMessage("one");
    await vi.waitFor(() => expect(el.streaming).toBe(true));
    await el.sendMessage("two");
    expect(el.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["one"]);
    release?.();
    await first;
  });

  it("aborts an in-flight SDK turn when the live session is detached", async () => {
    const el = mountChat();
    el.attachAgentSession({
      transport: {
        async *streamChat(_request, signal) {
          yield { type: "messageStart", model: "fixture" };
          if (signal.aborted) return;
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        },
      },
    });

    const turn = el.sendMessage("one");
    await vi.waitFor(() => expect(el.streaming).toBe(true));
    el.detachAgentSession();
    await turn;

    expect(el.messages.at(-1)?.status).toBe("cancelled");
    expect(el.streaming).toBe(false);
  });

  it("renders and announces a failed SDK tool execution as failed, not complete", async () => {
    const el = mountChat();
    let round = 0;
    const execution = vi.fn();
    el.addEventListener("honua-studio-chat-tool-execution", execution);
    el.attachAgentSession({
      tools: [
        {
          name: "failingProbe",
          description: "Always fails.",
          mode: "action",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      execute: async () =>
        ({
          tool: "inspectMap",
          status: "error",
          deniedReason: "server rejected the mutation",
          audit: {
            tool: "inspectMap",
            status: "error",
            dryRun: false,
            action: true,
            outcome: "error",
            parameters: {},
            timestamp: "FIXED",
          },
        }) as never,
      fetchImpl: vi.fn(() => Promise.reject(new Error("capabilities unavailable"))),
      transport: {
        async *streamChat() {
          round += 1;
          if (round === 1) {
            yield { type: "toolCallStart", toolCallId: "failed-1", toolName: "failingProbe" };
            yield { type: "toolCallStop", toolCallId: "failed-1", toolArguments: {} };
            yield { type: "messageStop", stopReason: "toolCall" };
            return;
          }
          yield { type: "messageStop", stopReason: "endTurn" };
        },
      },
    });

    await el.sendMessage("fail");

    expect(el.messages.at(-1)?.toolCalls[0]).toMatchObject({
      id: "failed-1",
      status: "error",
      errorMessage: "server rejected the mutation",
    });
    expect(el.shadowRoot?.querySelector('[data-testid="studio-chat-tool-call"]')?.textContent).toContain("Failed");
    expect(execution).toHaveBeenCalledTimes(1);
    expect((execution.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({
      toolCallId: "failed-1",
      ok: false,
      errorMessage: "server rejected the mutation",
    });
  });

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
