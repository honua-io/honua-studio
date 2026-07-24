/**
 * The real transport (honua-studio#6, AD-4/AD-8): streams
 * `POST {baseUrl}/v1/studio/ai/chat` per honua-server#3010's SSE contract,
 * bearer-attached via the session adapter (never the model's own
 * credentials — those stay server-side). Cancellation is a plain
 * `AbortController.abort()` on the `fetch` — the proxy's own documented
 * cancellation convention ("closing the client connection ... stops the
 * upstream call and ends the SSE stream").
 */
import { SSE_EVENT_NAME_TO_TYPE, type StudioAiChatEvent, type StudioAiChatRequest } from "./ai-contract.js";
import { SseFrameParser } from "./sse-parser.js";
import { ChatTransportError, type ChatTransport } from "./transport.js";

/** The minimal token surface this transport depends on — `AuthSession` satisfies this (matches `src/client/studio-client.ts`'s `TokenSource`). */
export interface TokenSource {
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string | undefined>;
}

export interface SseChatTransportOptions {
  /** Defaults to `"/api"` — matches `StudioClient`'s default. */
  baseUrl?: string;
  auth?: TokenSource;
  /** Override for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

function parseChatEventFrame(data: string, sseEventName: string): StudioAiChatEvent | undefined {
  const type = SSE_EVENT_NAME_TO_TYPE[sseEventName];
  if (!type) return undefined; // an SSE comment/keepalive frame, or an event name this contract doesn't know — ignore rather than fail the whole stream
  if (!data) return { type };
  try {
    const body = JSON.parse(data) as Record<string, unknown>;
    // The server-authoritative discriminant is the SSE `event:` line (see
    // ai-contract.ts's module doc) — `type` from the JSON body is
    // deliberately overwritten with it, never trusted on its own, so a
    // mismatched/missing body `type` field can never desync the parser.
    return { ...body, type } as StudioAiChatEvent;
  } catch {
    return { type: "error", errorMessage: "Malformed event payload from the Studio AI proxy." };
  }
}

/** Streams one chat turn against a real (or mock, see `mock-server.mjs`) honua-server AI proxy over SSE. */
export class SseChatTransport implements ChatTransport {
  constructor(private readonly options: SseChatTransportOptions = {}) {}

  async *streamChat(request: StudioAiChatRequest, signal: AbortSignal): AsyncGenerator<StudioAiChatEvent> {
    const baseUrl = this.options.baseUrl ?? "/api";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
    };
    if (this.options.auth) {
      const token = await this.options.auth.getAccessToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/v1/studio/ai/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal,
      });
    } catch (error) {
      if (signal.aborted) return;
      throw new ChatTransportError(`Could not reach the Studio AI proxy at ${baseUrl}/v1/studio/ai/chat.`, error);
    }

    if (!response.ok) {
      throw new ChatTransportError(`Studio AI proxy responded ${response.status} for the chat request.`);
    }
    if (!response.body) {
      throw new ChatTransportError("Studio AI proxy response had no body to stream.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseFrameParser();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const frame of parser.push(chunk)) {
          const event = parseChatEventFrame(frame.data, frame.event);
          if (event) yield event;
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      throw new ChatTransportError("Studio AI proxy stream failed.", error);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Already released (stream errored/closed) — fine to ignore.
      }
    }
  }
}
