/**
 * Chat transport seam (honua-studio#6, AD-4). `<honua-studio-chat>` depends
 * only on this interface — never on `fetch` or a concrete provider — so the
 * same element renders identically whether the model is behind the real
 * server AI proxy ({@link SseChatTransport}, honua-server#3010) or a
 * deterministic scripted conversation ({@link FixtureChatTransport} in
 * `./fixture-transport.js`, AD-4's "no-model fixture-conversation mode").
 */
import type { StudioAiChatEvent, StudioAiChatRequest } from "./ai-contract.js";

export interface ChatTransport {
  /**
   * Streams one chat turn. Implementations MUST respect `signal` —
   * cancellation is mid-stream abort, not merely "don't start" (spec: "the
   * proxy contract follows the same abort-the-HTTP-request convention as
   * the rest of the platform's streaming surfaces").
   */
  streamChat(request: StudioAiChatRequest, signal: AbortSignal): AsyncIterable<StudioAiChatEvent>;
}

/** Thrown by {@link ChatTransport} implementations for transport-level failures (network, non-2xx, malformed stream) — distinct from an in-band `{ type: "error" }` event, which is a normal, well-formed turn outcome. */
export class ChatTransportError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ChatTransportError";
  }
}
