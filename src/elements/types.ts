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
import type { CompositionCommand } from "../composition/commands.js";
import type { CompositionTarget } from "../composition/model.js";
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

/**
 * `honua-studio-selection-change` — dispatched by `<honua-studio-canvas>`
 * when the user picks something on the canvas: a row in the composition
 * readout, or (honua-studio#23) a feature on the MapLibre map itself.
 * `targets` is a list of {@link CompositionTarget}s — deictic references the
 * chat console (honua-studio#6) can attach to the next prompt as a "THIS"
 * chip (honua-studio#8 REQ-012). A map click yields the most specific target
 * available first: `{ kind: "feature", … }` when the hit feature carries an
 * id, followed by its `{ kind: "layer", … }`.
 */
export interface HonuaStudioSelectionChangeDetail {
  readonly targets: readonly CompositionTarget[];
}

/**
 * The outcome of a dispatched intrinsic mutation
 * ({@link HonuaStudioCommandDispatch}). A widget re-renders from real
 * composition state either way; `reason` is what it puts on the card when a
 * mutation did not land.
 */
export interface HonuaStudioCommandOutcome {
  readonly ok: boolean;
  /** Present only when `ok` is false — the reducer's or the server's own message, never a paraphrase. */
  readonly reason?: string;
}

/**
 * Where a widget's **intrinsic** mutation goes (honua-studio#24 REQ-003, made
 * durable by honua-studio#31): a TOC checkbox, a compare switch, a time
 * stepper. Each is a real composition command, and each has to travel the
 * same route an agent's command travels — through the tool bridge, so that in
 * live mode it reaches its `honua_studio_*` server tool and advances the
 * draft's generation instead of mutating client-local state a later sync
 * would overwrite.
 *
 * `<honua-studio-canvas>` sets this on its composed deck and control bar;
 * `<honua-studio-app>` sets the canvas's, pointing it at the one
 * `ToolCallOrchestrator`. Left unset — a widget used standalone — the widget
 * applies through its own `CompositionController`, which is exactly what
 * fixture/offline mode does anyway.
 *
 * Commands in one call are ordered and applied in order (a compare switch
 * hides one layer and shows another); the outcome describes the batch.
 */
export type HonuaStudioCommandDispatch = (
  commands: readonly CompositionCommand[],
) => Promise<HonuaStudioCommandOutcome>;

/**
 * `honua-studio-control-change` — dispatched by
 * `<honua-studio-control-bar>` (honua-studio#25) after a control gesture.
 *
 * **This is a notification, not the transport.** ADR-0030 bindings are driven
 * by the SDK's exploration context (a `FilterClause` published under the
 * control's id through `bindFilterControlsToExploration`), which is what
 * `@honua/sdk-js/interactions/declarative`'s compiler observes; this event
 * exists so a host can
 * watch controls without reaching into that context, and nothing downstream
 * of the control depends on anyone listening to it. Two event paths would be
 * two sources of truth — there is one, and this is not it.
 *
 * `source` carries the same discriminator `HonuaController` uses
 * (`controller | exploration | adapter | snapshot`): a control gesture is
 * always `"adapter"`, which is how a listener can tell a user's action from
 * an action-driven state change and honour ADR-0030's "actions never emit
 * events" rule.
 */
export interface HonuaStudioControlChangeDetail {
  readonly controlId: string;
  readonly kind: string;
  readonly source: "controller" | "exploration" | "adapter" | "snapshot";
  /** The value the control now holds. `undefined` means the control was cleared (an "All" option, an emptied date range). */
  readonly value: unknown;
}

/**
 * `honua-studio-composition-mode-change` — dispatched by
 * `<honua-studio-app>` when composition switches between fixture/offline
 * mode and the live server-draft path (honua-studio#23 REQ-004). Before #23
 * the only way to make that switch was `window.__honuaStudioApp`, a test
 * hook; the shell now owns a real control and announces the result, so an
 * embedding host can mirror the state in its own chrome instead of guessing.
 */
export interface HonuaStudioCompositionModeChangeDetail {
  readonly mode: "fixture" | "live";
  /** The Studio package the live session writes to. Present only for `"live"`. */
  readonly packageKey?: string;
  readonly family?: string;
}

/**
 * `honua-studio-open-item` — dispatched by `<honua-studio-content-browser>`
 * (honua-studio#9) when a user picks "Open" on a content-item or draft row.
 * At least one of `itemId`/`draftId` is always present; a draft row without
 * an immutable version yet has `draftId` only, a content item with no open
 * draft has `itemId` only, and reopening a version (from the lifecycle
 * panel, not this event) always produces both.
 */
export interface HonuaStudioOpenItemDetail {
  readonly itemId?: string;
  readonly draftId?: string;
  readonly family: string;
  readonly packageKey: string;
}

/**
 * `honua-studio-lifecycle-activity` — dispatched by
 * `<honua-studio-lifecycle-panel>` (honua-studio#9) after every lifecycle
 * action so a host can log it to a shared `<honua-studio-activity-log>`
 * (`studio-app-element.ts` wires this into the same log the chat console
 * and MCP orchestrator already append to — spec REQ-012's "recorded in the
 * activity log like any other context" extends to lifecycle actions here).
 * `kind: "publish-requested"` / `"rollback-requested"` only ever follow a
 * human-confirmed dialog inside the panel's own shadow DOM — see
 * `studio-lifecycle-panel-element.ts`'s module doc and
 * `test/lifecycle/human-gate.test.ts`.
 */
export interface HonuaStudioLifecycleActivityDetail {
  readonly kind:
    | "draft-loaded"
    | "draft-validated"
    | "version-saved"
    | "version-reopened"
    | "comparison-ready"
    | "publish-requested"
    | "publish-rejected"
    | "rollback-requested"
    | "error";
  readonly itemId?: string;
  readonly draftId?: string;
  readonly versionId?: string;
  readonly message?: string;
}

/**
 * `honua-studio-gp-activity` — dispatched by `<honua-studio-gp-panel>`
 * (honua-studio#10) after every GP authoring/validation/preview/execution
 * action, mirroring `HonuaStudioLifecycleActivityDetail`'s "recorded in the
 * activity log like any other context" pattern (spec REQ-012).
 * `kind: "job-submitted"` only ever follows the panel's own human-confirmed
 * dialog — see `studio-gp-panel-element.ts`'s module doc and
 * `test/gp/human-gate.test.ts`.
 */
export interface HonuaStudioGpActivityDetail {
  readonly kind:
    | "draft-loaded"
    | "draft-validated"
    | "preview-ready"
    | "job-submitted"
    | "job-status"
    | "job-cancelled"
    | "job-completed"
    | "error";
  readonly draftId?: string;
  readonly jobId?: string;
  readonly message?: string;
}

/**
 * `honua-studio-gp-add-output` — dispatched by `<honua-studio-gp-panel>`
 * when a user clicks "Add to composition" on a completed job's output
 * (honua-studio#10 REQ-004). A host forwards this into its own
 * `ToolCallOrchestrator` via the SAME `addLayer` composition command a chat
 * tool-call intent would use — see `studio-app-element.ts`'s listener.
 */
export interface HonuaStudioGpAddOutputDetail {
  readonly sourceId: string;
  readonly title?: string;
}

/** The minimal `CustomElementRegistry` surface the registry module needs — a real registry or a scoped/in-memory stand-in both satisfy this. */
export type HonuaStudioComponentRegistry = Pick<CustomElementRegistry, "get" | "define">;
