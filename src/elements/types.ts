/**
 * The embeddable web-component contract (honua-studio#5, REQ-001; see
 * docs/element-contract.md for the prose version of everything below).
 *
 * Every Studio surface — the full shell `<honua-studio-app>` and each
 * placeholder surface element (`<honua-studio-chat>`, `<honua-studio-canvas>`)
 * — is a plain custom element built on {@link ../base-element.js} with:
 *
 *  - typed attributes/properties (this module + each element module),
 *  - typed `CustomEvent` detail shapes (this module),
 *  - session injection via {@link SessionAdapter} (re-exported here from
 *    `../auth/types.js`, honua-studio#4's session module — that issue merged
 *    ahead of this one, so the interface lives there now; this module used
 *    to define its own near-identical `HonuaStudioSessionAdapter` as a
 *    coordination placeholder, since deleted in favor of this re-export, so
 *    there's exactly one adapter type, not two that could drift apart). See
 *    docs/embed-session.md for the full contract.
 *  - theming via the existing `data-theme-set` / `data-theme` token
 *    attributes (src/theme/tokens.css, theme-standalone.css,
 *    theme-console.css — unchanged by this issue) applied to the element
 *    itself, not the host document's `<html>`, so embedding never mutates
 *    global host state,
 *  - routing integration: host-owned ("host") or self-owned ("hash") URL
 *    mode — see {@link HonuaStudioRoutingMode},
 *  - an explicit mount (`connectedCallback`) / unmount (`disconnectedCallback`)
 *    lifecycle with full listener/observer cleanup (base-element.ts).
 *
 * @module
 */

import type { AuthSession, AuthState, AuthStatus, SessionAdapter } from "../auth/types.js";
import type { ActivityLogEntry } from "../chat/activity-log.js";
import type { StudioAiStopReason } from "../chat/ai-contract.js";
import type { AnnotationRef } from "../chat/annotation.js";
import type { ThemeMode, ThemeSet } from "../theme/theme-loader.js";

export type { ThemeMode, ThemeSet };
/** Re-exported from `../auth/types.js` (honua-studio#4) — the one session contract every Studio element uses. See docs/embed-session.md. */
export type { AuthSession, AuthState, AuthStatus, SessionAdapter };
/** Re-exported from `../chat/*.js` (honua-studio#6) — the chat console's typed public surface. */
export type { ActivityLogEntry, AnnotationRef, StudioAiStopReason };

/**
 * Who owns the browser URL:
 *
 * - `"hash"` (default) — the element runs its own internal hash router
 *   (`#/…`) and reads/writes `window.location`. Correct for the standalone
 *   shell, where nothing else owns the URL.
 * - `"host"` — the element NEVER touches `window.location`. It renders
 *   whatever `current-path` says, and asks to navigate by dispatching
 *   `honua-studio-navigate` (never applying the change itself). Correct for
 *   any embed where a host router (Blazor's, console's, or a bare harness
 *   stub) owns the URL — the Blazor Web App test host in
 *   harness/blazor-host is the reference integration for this mode.
 */
export type HonuaStudioRoutingMode = "hash" | "host";

/** Whether `<honua-studio-app>` renders its own theme-set/mode switcher chrome. */
export type HonuaStudioThemeSwitcherVisibility = "visible" | "hidden";

/** `honua-studio-ready` — dispatched once after an element's first successful render. */
export interface HonuaStudioReadyDetail {
  readonly tagName: string;
}

/**
 * `honua-studio-navigate` — dispatched by any Studio element that wants to
 * change the current view. In `routing-mode="hash"` the element also applies
 * the change itself (updates `window.location.hash`); in `"host"` mode this
 * event is a REQUEST ONLY — the element does not touch the URL, and the host
 * is responsible for updating its own router and then reflecting the result
 * back via the `current-path` attribute/property.
 */
export interface HonuaStudioNavigateDetail {
  readonly path: string;
  readonly replace?: boolean;
}

/** `honua-studio-theme-change` — dispatched whenever the element's own theme-set/mode attributes change, from any cause (attribute set externally, or the built-in switcher). */
export interface HonuaStudioThemeChangeDetail {
  readonly themeSet: ThemeSet;
  readonly mode: ThemeMode;
}

/** `honua-studio-session-required` — dispatched by a standalone placeholder element (`<honua-studio-chat>` / `<honua-studio-canvas>` used without a `<honua-studio-app>` ancestor) that has no `.auth` of its own to inherit or fall back to once connected. */
export interface HonuaStudioSessionRequiredDetail {
  readonly reason: string;
}

/** `honua-studio-error` — dispatched on any internal failure a host may want to surface (network, invalid attribute, etc). */
export interface HonuaStudioErrorDetail {
  readonly message: string;
  readonly error?: unknown;
}

/** `honua-studio-chat-message` — dispatched by `<honua-studio-chat>` whenever the composer submits a user turn (unchanged shape since honua-studio#5 — see docs/element-contract.md). */
export interface HonuaStudioChatMessageDetail {
  readonly text: string;
}

/** `honua-studio-chat-annotation-added` — dispatched by `<honua-studio-chat>` whenever an annotation chip is added, whether via `.addAnnotation()` or the `honua-studio-annotate` injection event (spec REQ-012). */
export interface HonuaStudioChatAnnotationAddedDetail {
  readonly annotation: AnnotationRef;
}

/** `honua-studio-chat-annotation-removed` — dispatched by `<honua-studio-chat>` whenever a chip is removed (composer "×", or `.removeAnnotation()`). */
export interface HonuaStudioChatAnnotationRemovedDetail {
  readonly id: string;
}

/** `honua-studio-annotate` — the injection event a canvas (or any host) dispatches (bubbles+composed, so it reaches `<honua-studio-chat>` from anywhere in the document) to add an annotation chip without holding a direct element reference. Detail matches `CreateAnnotationInput`. */
export interface HonuaStudioAnnotateDetail {
  readonly kind: AnnotationRef["kind"];
  readonly payload: unknown;
  readonly label?: string;
  readonly id?: string;
  readonly createdAt?: string;
}

/** `honua-studio-chat-tool-call-start` — dispatched the moment a streamed turn begins a tool call. */
export interface HonuaStudioChatToolCallStartDetail {
  readonly messageId: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

/**
 * `honua-studio-chat-tool-call-result` — the tool-call INTENT the chat
 * console emits once a tool call's arguments are fully assembled. Per the
 * issue's framing, the chat console emits tool-call intents and renders
 * results; it does not own composition state — a future composition engine
 * (honua-studio#8) is the intended consumer of this event.
 */
export interface HonuaStudioChatToolCallResultDetail {
  readonly messageId: string;
  readonly toolCallId: string;
  readonly toolName?: string;
  readonly arguments: unknown;
}

/** `honua-studio-chat-turn-complete` — dispatched when an assistant turn reaches a normal `messageStop`. */
export interface HonuaStudioChatTurnCompleteDetail {
  readonly messageId: string;
  readonly stopReason?: StudioAiStopReason;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly latencyMs?: number;
}

/** `honua-studio-chat-turn-error` — dispatched when a turn ends via an `error` event or a transport-level failure. */
export interface HonuaStudioChatTurnErrorDetail {
  readonly messageId: string;
  readonly errorMessage: string;
}

/** `honua-studio-chat-turn-cancelled` — dispatched when `.cancel()` aborts an in-flight turn. */
export interface HonuaStudioChatTurnCancelledDetail {
  readonly messageId: string;
}

/** `honua-studio-activity-replay-step` — dispatched by `<honua-studio-activity-log>` on every `replayNext()` call that emits an entry. */
export interface HonuaStudioActivityReplayStepDetail {
  readonly entry: ActivityLogEntry;
  readonly index: number;
  readonly total: number;
}

/** `honua-studio-activity-replay-complete` — dispatched once a replay session's last entry has been emitted. */
export interface HonuaStudioActivityReplayCompleteDetail {
  readonly total: number;
}

/** `honua-studio-canvas-resize` — dispatched by `<honua-studio-canvas>` on every observed size change. */
export interface HonuaStudioCanvasResizeDetail {
  readonly width: number;
  readonly height: number;
}

/** The minimal `CustomElementRegistry` surface the registry module needs — a real registry or a scoped/in-memory stand-in both satisfy this. */
export type HonuaStudioComponentRegistry = Pick<CustomElementRegistry, "get" | "define">;
