/**
 * `<honua-studio-chat>` — the Studio chat console (honua-studio#6, realizing
 * the honua-studio#5 placeholder). Renders a user/assistant/tool-call
 * message list with streaming text, an activity-log-backed history, and a
 * composer with removable annotation reference chips (spec REQ-012). Talks
 * to the model exclusively through the `ChatTransport` seam
 * (`../chat/transport.js`) — `SseChatTransport` (honua-server#3010) by
 * default, or a host-assigned `FixtureChatTransport` for deterministic
 * dev/CI/demo replay (AD-4).
 *
 * Per the issue framing (AD-5/AD-8): this element EMITS tool-call intents
 * (`honua-studio-chat-tool-call-result`) and renders results — it does not
 * own composition state. A future composition engine (honua-studio#8) is
 * the intended consumer of that event.
 */
import {
  type StudioAgentSession,
  type StudioAgentSessionEvent,
  type StudioAgentSessionOptions,
  createStudioAgentSession,
} from "@honua/sdk-js/studio-agent";

import {
  type ActivityLog,
  type AnnotationRef,
  type ChatState,
  type ChatTransport,
  type CreateAnnotationInput,
  SseChatTransport,
  type StudioAiChatMessage,
  annotationChipLabel,
  chatReducer,
  composeMessageContent,
  createActivityLog,
  createAnnotationRef,
  initialChatState,
} from "../chat/index.js";
import { runtimeServerBaseUrl } from "../runtime-config.js";
import { AUTH_STATUS_LABELS } from "./auth-status.js";
import { HonuaStudioElementBase } from "./base-element.js";
import { resolveInjectedAuth } from "./session.js";
import { baseElementStyles, chatStyles } from "./styles.js";
import type {
  AuthSession,
  HonuaStudioAnnotateDetail,
  HonuaStudioChatAnnotationAddedDetail,
  HonuaStudioChatAnnotationRemovedDetail,
  HonuaStudioChatMessageDetail,
  HonuaStudioChatToolCallResultDetail,
  HonuaStudioChatToolCallStartDetail,
  HonuaStudioChatToolExecutionDetail,
  HonuaStudioChatTurnCancelledDetail,
  HonuaStudioChatTurnCompleteDetail,
  HonuaStudioChatTurnErrorDetail,
} from "./types.js";

export class HonuaStudioChatElement extends HonuaStudioElementBase {
  static get observedAttributes(): string[] {
    return ["label", "placeholder"];
  }

  #auth: AuthSession | undefined;
  #authUnsubscribe: (() => void) | undefined;
  #transport: ChatTransport | undefined;
  #transportOverridden = false;
  #activityLog: ActivityLog | undefined;
  #state: ChatState = initialChatState;
  #history: StudioAiChatMessage[] = [];
  #messageSeq = 0;
  #annotationSeq = 0;
  #activeAbort: AbortController | undefined;
  #agentSession: StudioAgentSession | undefined;
  #agentMessageId: string | undefined;

  /** Direct `AuthSession` override — falls back to the nearest `<honua-studio-app>` ancestor's `.auth` when unset. See docs/embed-session.md. */
  public get auth(): AuthSession | undefined {
    return this.#auth;
  }

  public set auth(auth: AuthSession | undefined) {
    if (this.#auth === auth) return;
    this.#authUnsubscribe?.();
    this.#authUnsubscribe = undefined;
    this.#auth = auth;
    this.#authUnsubscribe = auth?.subscribe(() => this.render());
    // The default `.transport` getter captures `.auth` at construction —
    // invalidate it (unless a host explicitly overrode `.transport`) so a
    // session assigned/reassigned after the transport was already
    // lazily-created doesn't leave it bearer-attached to stale/no auth.
    if (!this.#transportOverridden) this.#transport = undefined;
    this.render();
  }

  /**
   * The transport this console talks to the model through. Defaults to a
   * lazily-constructed `SseChatTransport` reading `/api`, bearer-attached
   * via `.auth` — override with a `FixtureChatTransport` for deterministic
   * dev/CI/demo replay (AD-4's no-model fixture-conversation mode), same
   * "own it vs. override for fixtures/tests" pattern as
   * `studio-app-element.ts`'s `.studioClient`.
   */
  public get transport(): ChatTransport {
    if (!this.#transport) this.#transport = new SseChatTransport({ baseUrl: runtimeServerBaseUrl(), auth: this.#auth });
    return this.#transport;
  }

  public set transport(transport: ChatTransport) {
    this.#transport = transport;
    this.#transportOverridden = true;
    // Explicit transport assignment is the deterministic fixture/test seam.
    // It always wins over an app-installed live session.
    this.detachAgentSession();
  }

  /** True when a host deliberately supplied deterministic chat transport. */
  public get hasCustomTransport(): boolean {
    return this.#transportOverridden;
  }

  /** Active SDK session, exposed read-only for hosts and diagnostics. */
  public get agentSession(): StudioAgentSession | undefined {
    return this.#agentSession;
  }

  /** Installs the SDK-owned multi-round model/tool loop. */
  public attachAgentSession(options: StudioAgentSessionOptions): StudioAgentSession {
    this.#activeAbort?.abort();
    const callerOnEvent = options.onEvent;
    this.#agentSession = createStudioAgentSession({
      ...options,
      onEvent: (event) => {
        callerOnEvent?.(event);
        this.#consumeAgentSessionEvent(event);
      },
    });
    return this.#agentSession;
  }

  public detachAgentSession(): void {
    this.#activeAbort?.abort();
    this.#agentSession = undefined;
    this.#agentMessageId = undefined;
  }

  /** This console's own replayable activity log (spec REQ-012) — read-only; assign a fresh `createActivityLog()` (e.g. with a deterministic `clock`) BEFORE sending any messages to control its timestamps. */
  public get activityLog(): ActivityLog {
    if (!this.#activityLog) this.#activityLog = createActivityLog();
    return this.#activityLog;
  }

  public set activityLog(log: ActivityLog) {
    this.#activityLog = log;
  }

  /** Current message list (user/assistant/tool-call turns), for hosts/tests that want state without parsing the DOM. */
  public get messages(): ChatState["messages"] {
    return this.#state.messages;
  }

  /** Annotation chips attached in the composer but not yet sent. */
  public get pendingAnnotations(): readonly AnnotationRef[] {
    return this.#state.pendingAnnotations;
  }

  /** Whether an assistant turn is currently streaming. */
  public get streaming(): boolean {
    return this.#state.streaming;
  }

  public attributeChangedCallback(): void {
    if (!this.isConnected) return;
    this.render();
  }

  protected onConnect(): void {
    if (!this.#auth) {
      const inherited = resolveInjectedAuth(this);
      if (inherited) this.auth = inherited;
      else this.dispatchTypedEvent("honua-studio-session-required", { reason: "honua-studio-chat has no session" });
    }
    // REQ-012: "added via a public element API/event so the canvas can
    // inject them later" — a canvas (or any host) that doesn't hold a
    // direct element reference can dispatch this instead of calling
    // `.addAnnotation()` directly. Listened on `window` because the event
    // is `bubbles:true, composed:true` and may originate anywhere in the
    // document, not only as a light-DOM descendant of this element.
    this.listen(window, "honua-studio-annotate", (event) => {
      const detail = (event as CustomEvent<HonuaStudioAnnotateDetail>).detail;
      // `detail.payload` is `unknown` on the wire (an untyped DOM event) —
      // the caller is responsible for supplying a payload matching `kind`,
      // exactly like `CreateAnnotationInput` documents for the direct
      // `.addAnnotation()` call.
      if (detail) this.addAnnotation(detail as CreateAnnotationInput);
    });
  }

  protected onDisconnect(): void {
    this.#authUnsubscribe?.();
    this.#authUnsubscribe = undefined;
    this.#activeAbort?.abort();
    this.#activeAbort = undefined;
  }

  /** Adds an annotation reference chip to the composer (spec REQ-012). Returns the resolved `AnnotationRef`. */
  public addAnnotation(input: CreateAnnotationInput): AnnotationRef {
    const id = input.id ?? this.#nextAnnotationId();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const annotation = createAnnotationRef({
      id,
      kind: input.kind,
      payload: input.payload,
      label: input.label,
      createdAt,
    });
    this.#state = chatReducer(this.#state, { type: "annotation-added", annotation });
    this.activityLog.append("annotation_added", {
      id: annotation.id,
      kind: annotation.kind,
      label: annotation.label ?? null,
      payload: annotation.payload,
    });
    this.dispatchTypedEvent<HonuaStudioChatAnnotationAddedDetail>("honua-studio-chat-annotation-added", { annotation });
    this.render();
    return annotation;
  }

  /** Removes an annotation chip from the composer (a no-op if `id` isn't currently pending). */
  public removeAnnotation(id: string): void {
    if (!this.#state.pendingAnnotations.some((a) => a.id === id)) return;
    this.#state = chatReducer(this.#state, { type: "annotation-removed", id });
    this.activityLog.append("annotation_removed", { id });
    this.dispatchTypedEvent<HonuaStudioChatAnnotationRemovedDetail>("honua-studio-chat-annotation-removed", { id });
    this.render();
  }

  /** Cancels the in-flight assistant turn, if any. A no-op when nothing is streaming. */
  public cancel(): void {
    this.#activeAbort?.abort();
  }

  /**
   * Sends `text` as a user turn (folding in any pending annotation chips —
   * REQ-012's "serialized into the outgoing message context") and streams
   * the assistant's reply through `.transport`, applying every event to
   * this console's state/activity log/DOM as it arrives. Resolves once the
   * turn reaches `messageStop`, `error`, or cancellation — never rejects
   * (transport failures surface as a `honua-studio-chat-turn-error` event
   * and an `error`-status message, matching how an in-band `{type:"error"}`
   * event is handled).
   *
   * Deliberately does NOT gate on `.streaming` — the composer's own
   * input/send button are `disabled` while streaming (see `render()`), so
   * a real user can't trigger overlapping turns through the UI; a caller
   * that invokes `.sendMessage()` directly (an API/test caller, or a
   * fixture player) while a turn is already in flight gets a second,
   * independent turn — `#runAssistantTurn()` is self-contained per call
   * (its own message id, its own `AbortController`) and `cancel()` always
   * targets whichever turn is most recently in flight.
   */
  public async sendMessage(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    // StudioAgentSession owns one ordered history. A second concurrent turn
    // would interleave events/tool results and corrupt that history.
    if (this.#agentSession && this.streaming) return;

    const annotations = this.#state.pendingAnnotations;
    const wireContent = composeMessageContent(trimmed, annotations);
    if (!this.#agentSession) this.#history.push({ role: "user", content: wireContent });

    const userMessageId = this.#nextMessageId();
    this.#state = chatReducer(this.#state, {
      type: "user-message-sent",
      id: userMessageId,
      text: trimmed,
      annotations,
    });
    this.activityLog.append("user_message_sent", { messageId: userMessageId, text: trimmed });
    if (annotations.length > 0) {
      this.activityLog.append("annotations_attached", {
        messageId: userMessageId,
        annotationIds: annotations.map((a) => a.id),
      });
    }
    this.dispatchTypedEvent<HonuaStudioChatMessageDetail>("honua-studio-chat-message", { text: trimmed });
    this.render();

    await this.#runAssistantTurn(wireContent);
  }

  async #runAssistantTurn(wireContent: string): Promise<void> {
    const assistantMessageId = this.#nextMessageId();
    this.#state = chatReducer(this.#state, { type: "assistant-turn-started", id: assistantMessageId });
    this.activityLog.append("assistant_turn_started", { messageId: assistantMessageId });
    this.render();

    const controller = new AbortController();
    this.#activeAbort = controller;
    let settled = false;

    if (this.#agentSession) {
      this.#agentMessageId = assistantMessageId;
      try {
        const turn = await this.#agentSession.chat(wireContent, { signal: controller.signal });
        if (turn.status === "completed") {
          settled = true;
          const event = { type: "messageStop" as const, stopReason: turn.stopReason ?? "endTurn" };
          this.#state = chatReducer(this.#state, { type: "ai-event", id: assistantMessageId, event });
          this.activityLog.append("assistant_turn_completed", {
            messageId: assistantMessageId,
            stopReason: event.stopReason,
            rounds: turn.rounds,
          });
          this.dispatchTypedEvent<HonuaStudioChatTurnCompleteDetail>("honua-studio-chat-turn-complete", {
            messageId: assistantMessageId,
            stopReason: event.stopReason,
          });
        } else if (turn.status !== "cancelled") {
          settled = true;
          const errorMessage = turn.errorMessage ?? `Studio agent turn ${turn.status}.`;
          this.#state = chatReducer(this.#state, {
            type: "ai-event",
            id: assistantMessageId,
            event: { type: "error", errorMessage },
          });
          this.activityLog.append("assistant_turn_error", { messageId: assistantMessageId, errorMessage });
          this.dispatchTypedEvent<HonuaStudioChatTurnErrorDetail>("honua-studio-chat-turn-error", {
            messageId: assistantMessageId,
            errorMessage,
          });
        }
      } finally {
        this.#agentMessageId = undefined;
        if (this.#activeAbort === controller) this.#activeAbort = undefined;
        if (!settled) {
          this.#state = chatReducer(this.#state, { type: "turn-cancelled", id: assistantMessageId });
          this.activityLog.append("assistant_turn_cancelled", { messageId: assistantMessageId });
          this.dispatchTypedEvent<HonuaStudioChatTurnCancelledDetail>("honua-studio-chat-turn-cancelled", {
            messageId: assistantMessageId,
          });
        }
        this.render();
      }
      return;
    }

    try {
      for await (const event of this.transport.streamChat({ messages: this.#history }, controller.signal)) {
        this.#state = chatReducer(this.#state, { type: "ai-event", id: assistantMessageId, event });

        if (event.type === "toolCallStart" && event.toolCallId && event.toolName) {
          this.activityLog.append("tool_call_started", {
            messageId: assistantMessageId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          });
          this.dispatchTypedEvent<HonuaStudioChatToolCallStartDetail>("honua-studio-chat-tool-call-start", {
            messageId: assistantMessageId,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          });
        } else if (event.type === "toolCallStop" && event.toolCallId) {
          const toolCall = this.#state.messages
            .find((m) => m.id === assistantMessageId)
            ?.toolCalls.find((t) => t.id === event.toolCallId);
          this.activityLog.append("tool_call_completed", {
            messageId: assistantMessageId,
            toolCallId: event.toolCallId,
            toolName: toolCall?.name,
            arguments: event.toolArguments,
          });
          this.dispatchTypedEvent<HonuaStudioChatToolCallResultDetail>("honua-studio-chat-tool-call-result", {
            messageId: assistantMessageId,
            toolCallId: event.toolCallId,
            toolName: toolCall?.name,
            arguments: event.toolArguments,
          });
        } else if (event.type === "messageStop") {
          settled = true;
          const message = this.#state.messages.find((m) => m.id === assistantMessageId);
          this.#history.push({ role: "assistant", content: message?.text ?? "" });
          this.activityLog.append("assistant_turn_completed", {
            messageId: assistantMessageId,
            stopReason: event.stopReason,
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            latencyMs: event.latencyMs,
          });
          this.dispatchTypedEvent<HonuaStudioChatTurnCompleteDetail>("honua-studio-chat-turn-complete", {
            messageId: assistantMessageId,
            stopReason: event.stopReason,
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            latencyMs: event.latencyMs,
          });
        } else if (event.type === "error") {
          settled = true;
          const errorMessage = event.errorMessage ?? "The Studio AI proxy reported an error.";
          this.activityLog.append("assistant_turn_error", { messageId: assistantMessageId, errorMessage });
          this.dispatchTypedEvent<HonuaStudioChatTurnErrorDetail>("honua-studio-chat-turn-error", {
            messageId: assistantMessageId,
            errorMessage,
          });
        }

        this.render();
      }
    } catch (error) {
      settled = true;
      const errorMessage = error instanceof Error ? error.message : "The Studio AI proxy stream failed.";
      this.#state = chatReducer(this.#state, {
        type: "ai-event",
        id: assistantMessageId,
        event: { type: "error", errorMessage },
      });
      this.activityLog.append("assistant_turn_error", { messageId: assistantMessageId, errorMessage });
      this.dispatchTypedEvent<HonuaStudioChatTurnErrorDetail>("honua-studio-chat-turn-error", {
        messageId: assistantMessageId,
        errorMessage,
      });
    } finally {
      if (this.#activeAbort === controller) this.#activeAbort = undefined;
      if (!settled) {
        // The loop ended without messageStop/error — either genuine
        // cancellation (`.cancel()`/disconnect) or the transport stopped
        // yielding early. Either way the turn cannot be "complete".
        this.#state = chatReducer(this.#state, { type: "turn-cancelled", id: assistantMessageId });
        this.activityLog.append("assistant_turn_cancelled", { messageId: assistantMessageId });
        this.dispatchTypedEvent<HonuaStudioChatTurnCancelledDetail>("honua-studio-chat-turn-cancelled", {
          messageId: assistantMessageId,
        });
      }
      this.render();
    }
  }

  #consumeAgentSessionEvent(sessionEvent: StudioAgentSessionEvent): void {
    const messageId = this.#agentMessageId;
    if (!messageId) return;
    if (sessionEvent.type === "toolResult") {
      this.#state = chatReducer(this.#state, {
        type: "tool-result",
        id: messageId,
        toolCallId: sessionEvent.result.toolCallId,
        ok: sessionEvent.result.ok,
        ...(sessionEvent.result.errorMessage ? { errorMessage: sessionEvent.result.errorMessage } : {}),
      });
      this.activityLog.append("tool_call_completed", {
        messageId,
        toolCallId: sessionEvent.result.toolCallId,
        toolName: sessionEvent.result.toolName,
        ok: sessionEvent.result.ok,
        plane: sessionEvent.result.plane,
        errorMessage: sessionEvent.result.errorMessage,
      });
      this.dispatchTypedEvent<HonuaStudioChatToolExecutionDetail>("honua-studio-chat-tool-execution", {
        messageId,
        toolCallId: sessionEvent.result.toolCallId,
        toolName: sessionEvent.result.toolName,
        ok: sessionEvent.result.ok,
        plane: sessionEvent.result.plane,
        ...(sessionEvent.result.errorMessage ? { errorMessage: sessionEvent.result.errorMessage } : {}),
      });
      this.render();
      return;
    }

    // Discovery/watch events describe the session's tool inventory rather
    // than streamed chat content. The session exposes their current state;
    // they must not be projected into the transcript reducer.
    if (sessionEvent.type !== "chat") return;

    const event = sessionEvent.event;
    // Intermediate stops separate tool rounds; chat() owns the final stop.
    if (event.type === "messageStop" || event.type === "error") return;
    this.#state = chatReducer(this.#state, { type: "ai-event", id: messageId, event });
    if (event.type === "toolCallStart" && event.toolCallId && event.toolName) {
      this.activityLog.append("tool_call_started", {
        messageId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
      this.dispatchTypedEvent<HonuaStudioChatToolCallStartDetail>("honua-studio-chat-tool-call-start", {
        messageId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
    }
    this.render();
  }

  #nextMessageId(): string {
    this.#messageSeq += 1;
    return `message-${this.#messageSeq}`;
  }

  #nextAnnotationId(): string {
    this.#annotationSeq += 1;
    return `annotation-${this.#annotationSeq}`;
  }

  protected render(): void {
    const label = this.getAttribute("label") ?? "Chat";
    const placeholder = this.getAttribute("placeholder") ?? "Describe the app you want…";
    const sessionStatus = this.#auth ? AUTH_STATUS_LABELS[this.#auth.getState().status] : "Signed out";
    const streaming = this.#state.streaming;

    this.setShadowHtml(`
      <style>${baseElementStyles()}${chatStyles()}</style>
      <section class="chat hn-panel" part="panel" aria-label="${escapeHtml(label)}" data-testid="studio-chat">
        <div>
          <h2 class="hn-panel-title">${escapeHtml(label)}</h2>
          <p class="hn-register" data-testid="studio-chat-session-status">${escapeHtml(sessionStatus)}</p>
        </div>
        <ul class="chat-log" aria-live="polite" data-testid="studio-chat-log">
          ${
            this.#state.messages.length === 0
              ? `<li class="hn-muted">No messages yet.</li>`
              : this.#state.messages.map((message) => renderMessage(message)).join("")
          }
        </ul>
        <form data-testid="studio-chat-form">
          <label class="hn-muted" for="honua-studio-chat-input" style="position:absolute;width:1px;height:1px;overflow:hidden;">${escapeHtml(label)}</label>
          ${
            this.#state.pendingAnnotations.length > 0
              ? `<ul class="chat-annotations" data-testid="studio-chat-pending-annotations">
                  ${this.#state.pendingAnnotations
                    .map(
                      (annotation) => `
                    <li class="chat-annotation-chip" data-testid="studio-chat-annotation-chip" data-annotation-id="${escapeHtml(annotation.id)}">
                      <span>${escapeHtml(annotationChipLabel(annotation))}</span>
                      <button type="button" aria-label="Remove annotation ${escapeHtml(annotationChipLabel(annotation))}" data-testid="studio-chat-annotation-remove" data-annotation-id="${escapeHtml(annotation.id)}">×</button>
                    </li>`,
                    )
                    .join("")}
                </ul>`
              : ""
          }
          <div class="chat-composer-row">
            <input id="honua-studio-chat-input" type="text" placeholder="${escapeHtml(placeholder)}" data-testid="studio-chat-input" autocomplete="off" ${streaming ? "disabled" : ""} />
            <button type="submit" class="hn-btn hn-btn--sm" data-testid="studio-chat-send" ${streaming ? "disabled" : ""}>Send</button>
            ${streaming ? `<button type="button" class="hn-btn hn-btn--sm" data-testid="studio-chat-cancel">Cancel</button>` : ""}
          </div>
        </form>
      </section>
    `);

    const root = this.shadowRoot;
    const signal = this.connectedSignal;
    root?.querySelector("form")?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        const input = root?.querySelector<HTMLInputElement>("#honua-studio-chat-input");
        const text = input?.value.trim();
        if (!input || !text) return;
        input.value = "";
        void this.sendMessage(text);
      },
      { signal },
    );
    root
      ?.querySelector('[data-testid="studio-chat-cancel"]')
      ?.addEventListener("click", () => this.cancel(), { signal });
    for (const button of root?.querySelectorAll<HTMLButtonElement>('[data-testid="studio-chat-annotation-remove"]') ??
      []) {
      button.addEventListener(
        "click",
        () => {
          const id = button.dataset.annotationId;
          if (id) this.removeAnnotation(id);
        },
        { signal },
      );
    }
  }
}

function renderMessage(message: ChatState["messages"][number]): string {
  const statusClass = message.status === "streaming" ? " chat-message--streaming" : "";
  const errorClass = message.status === "error" ? " chat-message--error" : "";
  const roleClass = message.role === "user" ? " chat-message--user" : " chat-message--assistant";
  const roleLabel = message.role === "user" ? "You" : "Assistant";
  return `
    <li class="chat-message${roleClass}${statusClass}${errorClass}" data-testid="studio-chat-message" data-message-id="${escapeHtml(message.id)}" data-role="${message.role}" data-status="${message.status}">
      <span class="chat-message-role">${roleLabel}${message.status === "cancelled" ? " · cancelled" : ""}</span>
      ${
        message.annotations.length > 0
          ? `<ul class="chat-message-annotations">
              ${message.annotations
                .map(
                  (annotation) =>
                    `<li class="chat-annotation-chip" data-testid="studio-chat-message-annotation">${escapeHtml(annotationChipLabel(annotation))}</li>`,
                )
                .join("")}
            </ul>`
          : ""
      }
      <p class="chat-message-text" data-testid="studio-chat-message-text">${escapeHtml(message.text)}</p>
      ${
        message.toolCalls.length > 0
          ? `<ul class="chat-tool-calls" data-testid="studio-chat-tool-calls">
              ${message.toolCalls
                .map(
                  (toolCall) => `
                <li class="chat-tool-call" data-testid="studio-chat-tool-call" data-tool-call-id="${escapeHtml(toolCall.id)}" data-status="${toolCall.status}">
                  <span class="chat-tool-call-name">${escapeHtml(toolCall.name)}</span>
                  <span class="hn-badge hn-badge--status">${toolCall.status === "complete" ? "Complete" : toolCall.status === "error" ? "Failed" : "Calling…"}</span>
                  <pre class="chat-tool-call-args" data-testid="studio-chat-tool-call-args">${escapeHtml(
                    toolCall.status === "complete" && toolCall.args !== undefined
                      ? JSON.stringify(toolCall.args, null, 2)
                      : toolCall.argumentsText,
                  )}</pre>
                  ${toolCall.errorMessage ? `<p class="hn-error">${escapeHtml(toolCall.errorMessage)}</p>` : ""}
                </li>`,
                )
                .join("")}
            </ul>`
          : ""
      }
      ${message.status === "error" ? `<p class="hn-error" data-testid="studio-chat-message-error">${escapeHtml(message.errorMessage ?? "Error")}</p>` : ""}
    </li>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
