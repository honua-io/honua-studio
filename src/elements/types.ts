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
import type { CompositionTarget } from "../composition/model.js";
import type { ThemeMode, ThemeSet } from "../theme/theme-loader.js";

export type { ThemeMode, ThemeSet };
/** Re-exported from `../auth/types.js` (honua-studio#4) — the one session contract every Studio element uses. See docs/embed-session.md. */
export type { AuthSession, AuthState, AuthStatus, SessionAdapter };

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

/** `honua-studio-chat-message` — dispatched by `<honua-studio-chat>` when the placeholder composer submits. */
export interface HonuaStudioChatMessageDetail {
  readonly text: string;
}

/** `honua-studio-canvas-resize` — dispatched by `<honua-studio-canvas>` on every observed size change. */
export interface HonuaStudioCanvasResizeDetail {
  readonly width: number;
  readonly height: number;
}

/**
 * `honua-studio-selection-change` — dispatched by `<honua-studio-canvas>`
 * when the user clicks a rendered layer/widget/annotation row in the
 * composition readout. `targets` is a list of {@link CompositionTarget}s —
 * deictic references the chat console (honua-studio#6) can attach to the
 * next prompt as a "THIS" chip (honua-studio#8 REQ-012).
 */
export interface HonuaStudioSelectionChangeDetail {
  readonly targets: readonly CompositionTarget[];
}

/** The minimal `CustomElementRegistry` surface the registry module needs — a real registry or a scoped/in-memory stand-in both satisfy this. */
export type HonuaStudioComponentRegistry = Pick<CustomElementRegistry, "get" | "define">;
