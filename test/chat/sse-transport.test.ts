import { describe, expect, it, vi } from "vitest";

import type { StudioAiChatEvent } from "../../src/chat/ai-contract.js";
import { SseChatTransport } from "../../src/chat/sse-transport.js";
import { ChatTransportError } from "../../src/chat/transport.js";

function sseBodyStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    },
  });
}

function fakeFetch(options: {
  status?: number;
  body?: ReadableStream<Uint8Array> | null;
  captureRequest?: (init: RequestInit, url: string) => void;
}) {
  return vi.fn(async (url: string, init: RequestInit) => {
    options.captureRequest?.(init, url);
    return new Response(options.body ?? null, { status: options.status ?? 200 });
  }) as unknown as typeof fetch;
}

const START_EVENT = 'event: message_start\ndata: {"type":"messageStart","model":"m"}\n\n';
const DELTA_EVENT = 'event: text_delta\ndata: {"type":"textDelta","text":"hi"}\n\n';
const STOP_EVENT = 'event: message_stop\ndata: {"type":"messageStop","stopReason":"endTurn"}\n\n';

describe("chat/sse-transport", () => {
  it("streams a full turn split across multiple chunks, decoding each SSE frame into a StudioAiChatEvent", async () => {
    const fetchImpl = fakeFetch({ body: sseBodyStream([START_EVENT, DELTA_EVENT, STOP_EVENT]) });
    const transport = new SseChatTransport({ baseUrl: "/api", fetchImpl });
    const controller = new AbortController();

    const events: StudioAiChatEvent[] = [];
    for await (const event of transport.streamChat(
      { messages: [{ role: "user", content: "hi" }] },
      controller.signal,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "messageStart", model: "m" },
      { type: "textDelta", text: "hi" },
      { type: "messageStop", stopReason: "endTurn" },
    ]);
  });

  it("reassembles an SSE frame split across two chunks at an arbitrary byte boundary", async () => {
    const combined = START_EVENT + DELTA_EVENT;
    const splitPoint = 40;
    const fetchImpl = fakeFetch({ body: sseBodyStream([combined.slice(0, splitPoint), combined.slice(splitPoint)]) });
    const transport = new SseChatTransport({ baseUrl: "/api", fetchImpl });

    const events: StudioAiChatEvent[] = [];
    for await (const event of transport.streamChat(
      { messages: [{ role: "user", content: "hi" }] },
      new AbortController().signal,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "messageStart", model: "m" },
      { type: "textDelta", text: "hi" },
    ]);
  });

  it("attaches a bearer token from the auth token source", async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = fakeFetch({
      body: sseBodyStream([STOP_EVENT]),
      captureRequest: (init) => {
        captured = init;
      },
    });
    const auth = { getAccessToken: vi.fn().mockResolvedValue("token-123") };
    const transport = new SseChatTransport({ baseUrl: "/api", auth, fetchImpl });

    for await (const _event of transport.streamChat(
      { messages: [{ role: "user", content: "hi" }] },
      new AbortController().signal,
    )) {
      // drain
    }
    expect(auth.getAccessToken).toHaveBeenCalled();
    const headers = captured?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer token-123");
  });

  it("posts to {baseUrl}/v1/studio/ai/chat with the request body as JSON", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = init.body as string;
      return new Response(sseBodyStream([STOP_EVENT]), { status: 200 });
    }) as unknown as typeof fetch;
    const transport = new SseChatTransport({ baseUrl: "/api", fetchImpl });
    const request = { messages: [{ role: "user" as const, content: "hi" }], provider: "claude" };
    for await (const _event of transport.streamChat(request, new AbortController().signal)) {
      // drain
    }
    expect(capturedUrl).toBe("/api/v1/studio/ai/chat");
    expect(JSON.parse(capturedBody ?? "{}")).toEqual(request);
  });

  it("throws ChatTransportError for a non-2xx response", async () => {
    const fetchImpl = fakeFetch({ status: 500, body: null });
    const transport = new SseChatTransport({ baseUrl: "/api", fetchImpl });
    await expect(async () => {
      for await (const _event of transport.streamChat(
        { messages: [{ role: "user", content: "hi" }] },
        new AbortController().signal,
      )) {
        // drain
      }
    }).rejects.toThrow(ChatTransportError);
  });

  it("stops silently (no throw) when the signal is already aborted and fetch rejects with AbortError", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as unknown as typeof fetch;
    const transport = new SseChatTransport({ baseUrl: "/api", fetchImpl });
    const events: StudioAiChatEvent[] = [];
    for await (const event of transport.streamChat(
      { messages: [{ role: "user", content: "hi" }] },
      controller.signal,
    )) {
      events.push(event);
    }
    expect(events).toEqual([]);
  });

  it("yields an in-band error event for a malformed JSON data payload without throwing", async () => {
    const malformed = "event: text_delta\ndata: not-json\n\n";
    const fetchImpl = fakeFetch({ body: sseBodyStream([malformed]) });
    const transport = new SseChatTransport({ baseUrl: "/api", fetchImpl });
    const events: StudioAiChatEvent[] = [];
    for await (const event of transport.streamChat(
      { messages: [{ role: "user", content: "hi" }] },
      new AbortController().signal,
    )) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "error", errorMessage: "Malformed event payload from the Studio AI proxy." }]);
  });
});
