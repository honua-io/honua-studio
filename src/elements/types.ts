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
 *  - session injection via {@link HonuaStudioSessionAdapter} — see
 *    docs/embed-session.md, the host-session adapter coordination note for
 *    honua-studio#4. That issue's branch has not merged as of honua-studio#5,
 *    so the interface is defined here first, identically to what #4's own
 *    doc commits to shipping.
 *    TODO(honua-studio#4): once #4 lands its own session module, re-export
 *    that module's type from here (or delete this copy in favor of an
 *    import) so there is exactly one `HonuaStudioSessionAdapter` definition.
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

import type { ThemeMode, ThemeSet } from "../theme/theme-loader.js";

export type { ThemeMode, ThemeSet };

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

/**
 * A snapshot of the host-provided session's authentication state. Read-only
 * from the element's point of view — Studio elements never mutate auth
 * state, they only render it and react to `onChange`.
 */
export interface HonuaStudioSessionSnapshot {
  readonly status: "anonymous" | "authenticated" | "expired";
  /** Opaque subject/user identifier for display only — never an authz decision input inside the element. */
  readonly subject?: string;
  readonly expiresAt?: string;
}

/**
 * The host-session adapter interface (honua-studio#4 coordination point;
 * see docs/embed-session.md). A host — the standalone bootstrap itself, the
 * bare embed harness fixture, the Blazor test host, or eventually
 * honua-console — constructs one of these and assigns it to
 * `<honua-studio-app>.session` (or any standalone surface element's
 * `.session` property) before or after the element connects. Elements never
 * construct their own adapter and never initiate a login flow themselves
 * (that responsibility stays entirely with the host, per honua-studio#4
 * REQ-003).
 */
export interface HonuaStudioSessionAdapter {
  /** The honua-server base URL this session's SDK clients should target. */
  readonly baseUrl: string;
  /** Synchronous read of the current auth state. */
  getSnapshot(): HonuaStudioSessionSnapshot;
  /** Resolves the current bearer token, or `undefined` when anonymous/expired. May trigger a silent refresh. */
  getAccessToken(): Promise<string | undefined>;
  /** Subscribes to session changes (login, logout, refresh, expiry). Returns an unsubscribe handle. */
  onChange(listener: (snapshot: HonuaStudioSessionSnapshot) => void): { remove(): void };
}

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

/** `honua-studio-session-required` — dispatched when an element needs a session but `.session` is still unset once connected. */
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

/** The minimal `CustomElementRegistry` surface the registry module needs — a real registry or a scoped/in-memory stand-in both satisfy this. */
export type HonuaStudioComponentRegistry = Pick<CustomElementRegistry, "get" | "define">;
