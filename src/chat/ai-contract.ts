/**
 * Provider-neutral Studio AI proxy wire contract (honua-studio#6, AD-4/AD-8).
 * Mirrors honua-server#3010 (`POST /api/v1/studio/ai/chat`, SSE) exactly —
 * see that PR's `src/Honua.Ai/Features/StudioAiProxy/Domain/StudioAiChatEvent.cs`
 * and `StudioAiChatModels.cs`, and `src/Honua.Server/Features/StudioAi/StudioAiProxyEndpoints.cs`.
 * This module owns ONLY the shapes; transport (SSE framing, fixtures) lives
 * in sibling modules so the contract can be unit-tested independent of
 * `fetch`/`ReadableStream`.
 *
 * Wire-shape notes (verified against the PR diff, not guessed):
 *  - The server's `StudioAiProxyJsonContext` uses
 *    `JsonSourceGenerationOptions(PropertyNamingPolicy = CamelCase, UseStringEnumConverter = true)`
 *    for every JSON body — so both object keys AND C# enum values serialize
 *    camelCase (`StudioAiChatEventType.MessageStart` -> `"messageStart"`,
 *    `StudioAiStopReason.EndTurn` -> `"endTurn"`). This module's string
 *    unions match that casing exactly.
 *  - The SSE `event:` line is a SEPARATE, hardcoded snake_case vocabulary
 *    written by `StudioAiProxyEndpoints.EventName()` — `message_start`,
 *    `text_delta`, `tool_call_start`, `tool_call_delta`, `tool_call_stop`,
 *    `message_stop`, `error` — independent of the JSON naming policy above.
 *    `SSE_EVENT_NAME_TO_TYPE` bridges the two vocabularies.
 */

/** Role of one `StudioAiChatMessage` — matches `StudioAiRole` (server-side enum, lower-case on the wire). */
export type StudioAiRole = "system" | "user" | "assistant" | "tool";

/** One turn of provider-neutral chat history sent to `POST /api/v1/studio/ai/chat`. */
export interface StudioAiChatMessage {
  readonly role: StudioAiRole;
  readonly content: string;
  /** For `role: "tool"` messages: the id of the tool call this responds to. */
  readonly toolCallId?: string;
  /** For `role: "tool"` messages: the name of the tool that was called. */
  readonly toolName?: string;
}

/** A tool (function) the model may call, described by a JSON Schema input shape. */
export interface StudioAiToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

export type StudioAiToolChoiceMode = "auto" | "none" | "required" | "specific";

export interface StudioAiToolChoice {
  readonly mode: StudioAiToolChoiceMode;
  /** Required when `mode` is `"specific"`. */
  readonly toolName?: string;
}

/** Request body for `POST /api/v1/studio/ai/chat`. */
export interface StudioAiChatRequest {
  /** Name of the configured provider to route to. Omit to use the server's configured default. */
  readonly provider?: string;
  /** Optional model override. */
  readonly model?: string;
  /** Optional system/developer prompt, carried out-of-band from `messages`. */
  readonly system?: string;
  /** Conversation turns, oldest first. */
  readonly messages: readonly StudioAiChatMessage[];
  readonly tools?: readonly StudioAiToolDefinition[];
  readonly toolChoice?: StudioAiToolChoice;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

/**
 * Discriminates which fields of a `StudioAiChatEvent` are populated — the
 * JSON body's `"type"` field. Camel-cased per the source-gen naming policy
 * (see module doc); NOT the same string as the SSE `event:` line.
 */
export type StudioAiChatEventType =
  | "messageStart"
  | "textDelta"
  | "toolCallStart"
  | "toolCallDelta"
  | "toolCallStop"
  | "messageStop"
  | "error";

/** Why a turn stopped generating — `StudioAiChatEvent.stopReason`, set on `messageStop`. */
export type StudioAiStopReason = "endTurn" | "toolCall" | "maxTokens" | "contentFilter" | "cancelled" | "error";

/**
 * One event in a streamed provider-neutral chat turn — a single flat shape
 * (matches the server's `StudioAiChatEvent`, one C# class rather than a
 * discriminated hierarchy). Unused fields for a given `type` are simply
 * absent (server omits nulls: `DefaultIgnoreCondition = WhenWritingNull`).
 */
export interface StudioAiChatEvent {
  readonly type: StudioAiChatEventType;
  /** Model id actually used. Set on `messageStart`. */
  readonly model?: string;
  /** Incremental assistant text. Set on `textDelta`. */
  readonly text?: string;
  /** Tool call id. Set on `toolCallStart` / `toolCallDelta` / `toolCallStop`. */
  readonly toolCallId?: string;
  /** Tool name. Set on `toolCallStart`. */
  readonly toolName?: string;
  /** Incremental JSON-argument text. Set on `toolCallDelta`. */
  readonly toolArgumentsDelta?: string;
  /** Full parsed arguments, when assembly succeeded. Set on `toolCallStop`. */
  readonly toolArguments?: unknown;
  /** Set on `messageStop`. */
  readonly stopReason?: StudioAiStopReason;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  /** Wall-clock time from request dispatch to this event. Set on `messageStop` / `error`. */
  readonly latencyMs?: number;
  /** Human-readable failure detail. Set on `error`. */
  readonly errorMessage?: string;
}

/** The SSE `event:` line's hardcoded snake_case vocabulary (`StudioAiProxyEndpoints.EventName()`) mapped to this module's `StudioAiChatEventType`. */
export const SSE_EVENT_NAME_TO_TYPE: Readonly<Record<string, StudioAiChatEventType>> = {
  message_start: "messageStart",
  text_delta: "textDelta",
  tool_call_start: "toolCallStart",
  tool_call_delta: "toolCallDelta",
  tool_call_stop: "toolCallStop",
  message_stop: "messageStop",
  error: "error",
};

/** Inverse of {@link SSE_EVENT_NAME_TO_TYPE} — used by `FixtureChatTransport`/mock-server.mjs to write real SSE frames from `StudioAiChatEvent`s. */
export const CHAT_EVENT_TYPE_TO_SSE_NAME: Readonly<Record<StudioAiChatEventType, string>> = Object.fromEntries(
  Object.entries(SSE_EVENT_NAME_TO_TYPE).map(([sseName, type]) => [type, sseName]),
) as Record<StudioAiChatEventType, string>;

/** One declared provider's capability descriptor — `GET /api/v1/studio/ai/capabilities`. */
export interface StudioAiCapability {
  readonly provider: string;
  readonly kind: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly toolSupport: boolean;
  readonly streaming: boolean;
  readonly isDefault: boolean;
  readonly configured: boolean;
}

export interface StudioAiCapabilitiesResponse {
  readonly enabled: boolean;
  readonly defaultProvider: string;
  readonly providers: readonly StudioAiCapability[];
}
