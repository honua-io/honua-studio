import type { StudioAiChatEvent, StudioAiStopReason } from "./ai-contract.js";
/**
 * Pure message-state reducer (honua-studio#6). `<honua-studio-chat>` is a
 * thin renderer over this module's `ChatState` — every state transition is a
 * `chatReducer(state, action) -> state` call, so the streaming
 * text-accumulation / tool-call-card lifecycle / annotation-chip lifecycle
 * are all independently unit-testable without a DOM (`test/chat/message-reducer.test.ts`).
 * Never mutates its input; always returns fresh objects/arrays.
 */
import type { AnnotationRef } from "./annotation.js";

export type ChatRole = "user" | "assistant";
export type ChatMessageStatus = "streaming" | "complete" | "cancelled" | "error";
export type ChatToolCallStatus = "pending" | "complete";

export interface ChatToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw accumulated JSON-argument text from `toolCallDelta` events. */
  readonly argumentsText: string;
  /** Parsed arguments, once `toolCallStop` is received. */
  readonly args?: unknown;
  readonly status: ChatToolCallStatus;
}

export interface ChatMessage {
  readonly id: string;
  readonly role: ChatRole;
  /** Display text — for a user message, exactly what was typed (never the annotation-augmented wire content). For an assistant message, the accumulated `textDelta` stream. */
  readonly text: string;
  readonly annotations: readonly AnnotationRef[];
  readonly toolCalls: readonly ChatToolCall[];
  readonly status: ChatMessageStatus;
  readonly model?: string;
  readonly stopReason?: StudioAiStopReason;
  readonly errorMessage?: string;
}

export interface ChatState {
  readonly messages: readonly ChatMessage[];
  /** Annotation chips attached in the composer but not yet sent. */
  readonly pendingAnnotations: readonly AnnotationRef[];
  readonly streaming: boolean;
}

export const initialChatState: ChatState = { messages: [], pendingAnnotations: [], streaming: false };

export type ChatAction =
  | {
      readonly type: "user-message-sent";
      readonly id: string;
      readonly text: string;
      readonly annotations: readonly AnnotationRef[];
    }
  | { readonly type: "assistant-turn-started"; readonly id: string }
  | { readonly type: "ai-event"; readonly id: string; readonly event: StudioAiChatEvent }
  | { readonly type: "turn-cancelled"; readonly id: string }
  | { readonly type: "annotation-added"; readonly annotation: AnnotationRef }
  | { readonly type: "annotation-removed"; readonly id: string }
  | { readonly type: "reset" };

function updateMessage(
  messages: readonly ChatMessage[],
  id: string,
  updater: (message: ChatMessage) => ChatMessage,
): readonly ChatMessage[] {
  return messages.map((message) => (message.id === id ? updater(message) : message));
}

function updateToolCall(
  toolCalls: readonly ChatToolCall[],
  id: string | undefined,
  updater: (toolCall: ChatToolCall) => ChatToolCall,
): readonly ChatToolCall[] {
  if (!id) return toolCalls;
  return toolCalls.map((toolCall) => (toolCall.id === id ? updater(toolCall) : toolCall));
}

function applyAiEvent(message: ChatMessage, event: StudioAiChatEvent): ChatMessage {
  switch (event.type) {
    case "messageStart":
      return { ...message, model: event.model };
    case "textDelta":
      return { ...message, text: message.text + (event.text ?? "") };
    case "toolCallStart": {
      const toolCall: ChatToolCall = {
        id: event.toolCallId ?? "",
        name: event.toolName ?? "",
        argumentsText: "",
        status: "pending",
      };
      return { ...message, toolCalls: [...message.toolCalls, toolCall] };
    }
    case "toolCallDelta":
      return {
        ...message,
        toolCalls: updateToolCall(message.toolCalls, event.toolCallId, (toolCall) => ({
          ...toolCall,
          argumentsText: toolCall.argumentsText + (event.toolArgumentsDelta ?? ""),
        })),
      };
    case "toolCallStop":
      return {
        ...message,
        toolCalls: updateToolCall(message.toolCalls, event.toolCallId, (toolCall) => ({
          ...toolCall,
          args: event.toolArguments,
          status: "complete",
        })),
      };
    case "messageStop":
      return { ...message, status: "complete", stopReason: event.stopReason };
    case "error":
      return {
        ...message,
        status: "error",
        errorMessage: event.errorMessage ?? "The Studio AI proxy reported an error.",
      };
    default:
      return message;
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "user-message-sent": {
      const message: ChatMessage = {
        id: action.id,
        role: "user",
        text: action.text,
        annotations: action.annotations,
        toolCalls: [],
        status: "complete",
      };
      return { ...state, messages: [...state.messages, message], pendingAnnotations: [] };
    }
    case "assistant-turn-started": {
      const message: ChatMessage = {
        id: action.id,
        role: "assistant",
        text: "",
        annotations: [],
        toolCalls: [],
        status: "streaming",
      };
      return { ...state, messages: [...state.messages, message], streaming: true };
    }
    case "ai-event": {
      const messages = updateMessage(state.messages, action.id, (message) => applyAiEvent(message, action.event));
      const stillStreaming = action.event.type !== "messageStop" && action.event.type !== "error";
      return { ...state, messages, streaming: stillStreaming && state.streaming };
    }
    case "turn-cancelled": {
      const messages = updateMessage(state.messages, action.id, (message) =>
        message.status === "streaming" ? { ...message, status: "cancelled" } : message,
      );
      return { ...state, messages, streaming: false };
    }
    case "annotation-added":
      if (state.pendingAnnotations.some((a) => a.id === action.annotation.id)) return state;
      return { ...state, pendingAnnotations: [...state.pendingAnnotations, action.annotation] };
    case "annotation-removed":
      return { ...state, pendingAnnotations: state.pendingAnnotations.filter((a) => a.id !== action.id) };
    case "reset":
      return initialChatState;
    default:
      return state;
  }
}
