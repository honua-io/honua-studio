import type { AuthSession, AuthStatus } from "../auth/index.js";
import type { CompositionController } from "../composition/controller.js";
import type { EditorAgentSessionAdapter } from "../editor-agent.js";
import { AUTH_STATUS_LABELS } from "../elements/auth-status.js";
import { appShellStyles, baseElementStyles } from "../elements/styles.js";
import type { HonuaStudioThemeSwitcherVisibility } from "../elements/types.js";
import type { StudioPackageFamilyWire } from "../mcp/studio-tools.js";
import type { ThemeMode, ThemeSet } from "../theme/theme-loader.js";
import { STUDIO_ROUTES } from "./shell-router.js";

/** Package families whose drafts carry a composition body; mirrors the server gate and `mock-server.mjs`. */
const LIVE_COMPOSITION_FAMILIES: readonly StudioPackageFamilyWire[] = ["map", "app"];
const FIXTURE_MODE_LABEL = "Fixture mode";
const THEME_SETS: readonly ThemeSet[] = ["standalone", "console"];
const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "auto"];
const THEME_SET_LABELS: Record<ThemeSet, string> = { standalone: "Standalone", console: "Console" };
const THEME_MODE_LABELS: Record<ThemeMode, string> = { light: "Light", dark: "Dark", auto: "Auto" };
const HISTORY_ACTIONS = ["undo", "redo"] as const;

/** The public `<honua-studio-app>` surface the header reads and drives. */
export interface ShellChromeHost {
  readonly shadowRoot: ShadowRoot | null;
  readonly auth: AuthSession;
  themeSet: ThemeSet;
  themeMode: ThemeMode;
  readonly themeSwitcherVisibility: HonuaStudioThemeSwitcherVisibility;
  readonly currentPath: string;
  readonly agentSessionAdapter: EditorAgentSessionAdapter | undefined;
  readonly hasUnsavedStyleChanges: boolean;
  readonly composition: CompositionController;
  readonly toolCallOrchestrator: { readonly isLive: boolean };
  openRecipePicker(): void;
  closeRecipePicker(): void;
  openDesignInspector(): Promise<void>;
  closeDesignInspector(): void;
  applyHistoryAction(action: "undo" | "redo"): Promise<boolean>;
  enableLiveEditing(options: { readonly packageKey: string; readonly family?: StudioPackageFamilyWire }): void;
  disableLiveEditing(): void;
}

export interface ShellChromeOptions {
  readonly host: ShellChromeHost;
  readonly setShadowHtml: (html: string) => void;
  readonly connectedSignal: () => AbortSignal | undefined;
  readonly authStatus: () => AuthStatus;
  readonly isDesignInspectorOpen: () => boolean;
  readonly isHistoryBusy: () => boolean;
  readonly liveStatus: () => { readonly live: boolean; readonly packageKey?: string };
  readonly onNavigate: (path: string, event: Event) => void;
}

/** The shell header and slot layout: builds the shadow markup once, binds its controls and repaints them. */
export class ShellChrome {
  #built = false;
  #historyUnsubscribe: (() => void) | undefined;

  constructor(private readonly options: ShellChromeOptions) {}

  get #root(): ShadowRoot | null {
    return this.options.host.shadowRoot;
  }

  render(): void {
    if (this.#built && this.#root?.querySelector(".app-shell")) {
      this.syncTheme();
      this.syncNav();
      this.paintAuth();
      return;
    }
    this.options.setShadowHtml(this.#markup());
    this.#built = true;
    this.#bindControls();
    this.#historyUnsubscribe?.();
    this.#historyUnsubscribe = this.options.host.composition.subscribe(() => this.paintHistory());
    this.paintHistory();
    this.syncTheme();
    this.syncNav();
    this.paintAuth();
    this.paintLiveComposition();
  }

  /** Forces the next `render()` to rebuild the markup. */
  invalidate(): void {
    this.#built = false;
  }

  dispose(): void {
    this.#historyUnsubscribe?.();
    this.#historyUnsubscribe = undefined;
    this.invalidate();
  }

  hasView(): boolean {
    return Boolean(this.#root?.querySelector("#view"));
  }

  viewRoot(): HTMLElement {
    const root = this.#root?.querySelector<HTMLElement>("#view");
    if (!root) throw new Error("honua-studio-app: shell markup is missing its #view outlet.");
    return root;
  }

  appSlots(): HTMLElement | null {
    return this.#root?.querySelector<HTMLElement>(".app-slots") ?? null;
  }

  lifecyclePanel(): HTMLElement | null {
    return this.#root?.querySelector<HTMLElement>("honua-studio-lifecycle-panel") ?? null;
  }

  focusStyleEditorReturn(): void {
    this.lifecyclePanel()
      ?.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-panel-edit-style"]')
      ?.focus();
  }

  recipeOutlet(): HTMLElement | null {
    return this.#root?.querySelector<HTMLElement>("[data-recipe-outlet]") ?? null;
  }

  markExpanded(testId: string): void {
    this.#control(testId)?.setAttribute("aria-expanded", "true");
  }

  markCollapsed(testId: string): void {
    this.#control(testId)?.setAttribute("aria-expanded", "false");
  }

  focus(testId: string): void {
    this.#control(testId)?.focus();
  }

  hideChatSlot(): void {
    this.#chatSlot()?.setAttribute("hidden", "");
  }

  showChatSlot(): void {
    this.#chatSlot()?.removeAttribute("hidden");
  }

  #chatSlot(): Element | null | undefined {
    return this.#root?.querySelector('slot[name="chat"]');
  }

  setHistoryStatus(text: string): void {
    const status = this.#control("history-status");
    if (status) status.textContent = text;
  }

  paintHistory(): void {
    const { host } = this.options;
    for (const action of HISTORY_ACTIONS) {
      const button = this.#control<HTMLButtonElement>(`history-${action}`);
      if (button)
        button.disabled =
          this.options.isHistoryBusy() ||
          host.hasUnsavedStyleChanges ||
          !(action === "undo" ? host.composition.canUndo() : host.composition.canRedo());
    }
  }

  syncTheme(): void {
    const root = this.#root;
    if (!root) return;
    const { host } = this.options;
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-theme-set-option]")) {
      button.setAttribute("aria-pressed", String(button.dataset.themeSetOption === host.themeSet));
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-theme-mode-option]")) {
      button.setAttribute("aria-pressed", String(button.dataset.themeModeOption === host.themeMode));
    }
    const controls = this.#control("theme-controls");
    if (controls) controls.hidden = host.themeSwitcherVisibility === "hidden";
  }

  syncNav(): void {
    for (const link of this.#root?.querySelectorAll<HTMLAnchorElement>("[data-path]") ?? []) {
      if (link.dataset.path === this.options.host.currentPath) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  paintAuth(): void {
    if (!this.#root) return;
    const status = this.options.authStatus();
    const label = this.#control("auth-status");
    if (label) label.textContent = AUTH_STATUS_LABELS[status];
    const signedIn = status === "fresh" || status === "refreshing";
    const signIn = this.#control("auth-signin");
    const signOut = this.#control("auth-signout");
    if (signIn) signIn.hidden = signedIn;
    if (signOut) signOut.hidden = !signedIn;
  }

  paintLiveComposition(): void {
    if (!this.#root) return;
    const { live, packageKey } = this.options.liveStatus();
    const status = this.#control("live-composition-status");
    if (status) {
      status.textContent = live ? `Live · ${packageKey ?? "connected"}` : FIXTURE_MODE_LABEL;
      status.setAttribute("data-mode", live ? "live" : "fixture");
    }
    const toggle = this.#control("live-composition-toggle");
    if (toggle) toggle.textContent = live ? "Return to fixture" : "Go live…";
    if (live) this.#closeLiveForm();
  }

  #control<T extends HTMLElement = HTMLElement>(testId: string): T | null {
    return this.#root?.querySelector<T>(`[data-testid="${testId}"]`) ?? null;
  }

  #on(target: EventTarget | null | undefined, type: string, listener: (event: Event) => void): void {
    target?.addEventListener(type, listener, { signal: this.options.connectedSignal() });
  }

  #markup(): string {
    return `
      <style>${baseElementStyles()}${appShellStyles()}</style>
      <div class="app-shell" data-testid="app-shell">
        <header class="app-header hn-panel">
          <div class="app-brand">
            <p class="hn-register">Honua Studio</p>
            <h1 class="app-title">Natural language to map app.</h1>
          </div>
          <nav class="app-nav" aria-label="Studio">
            ${STUDIO_ROUTES.map(
              (route) =>
                `<a href="#${route.path}" data-path="${route.path}" data-testid="${route.navTestId}">${route.label}</a>`,
            ).join("")}
          </nav>
          <div class="app-auth" data-testid="auth-controls" role="group" aria-label="Session">
            <span class="hn-muted" data-testid="auth-status"></span>
            ${this.#authControlsMarkup()}
          </div>
          ${this.#compositionModeMarkup()}
          ${this.#themeControlsMarkup()}
        </header>
        <main id="view" class="app-view" data-testid="app-view"></main>
        <div id="recipe-outlet" data-recipe-outlet hidden></div>
        <div class="app-slots" data-testid="app-slots">
          <slot name="chat" ${this.options.host.agentSessionAdapter ? "hidden" : ""}></slot>
          <slot name="canvas"></slot>
        </div>
      </div>
    `;
  }

  /** An embed host owns sign-in/out, so host-adapter mode renders only a status label. */
  #authControlsMarkup(): string {
    return this.options.host.auth.mode === "standalone"
      ? `<button type="button" class="hn-btn hn-btn--sm" data-testid="auth-signin" hidden>Sign in</button>
           <button type="button" class="hn-btn hn-btn--sm" data-testid="auth-signout" hidden>Sign out</button>`
      : "";
  }

  #compositionModeMarkup(): string {
    return `<div class="app-composition-mode" data-testid="live-composition" role="group" aria-label="Editing mode">
            <span class="hn-badge" data-testid="live-composition-status">${FIXTURE_MODE_LABEL}</span>
            <button type="button" class="hn-btn hn-btn--sm" data-testid="history-undo" disabled>Undo</button>
            <button type="button" class="hn-btn hn-btn--sm" data-testid="history-redo" disabled>Redo</button>
            <button type="button" class="hn-btn hn-btn--sm" data-testid="design-inspector-toggle" aria-expanded="false" aria-controls="design-inspector-panel">Inspect data and interactions</button>
            <span class="hn-muted" data-testid="history-status" role="status"></span>
            <button type="button" class="hn-btn hn-btn--sm" data-testid="recipe-toggle" aria-expanded="false" aria-controls="recipe-outlet">Start from a recipe</button>
            <button
              type="button"
              class="hn-btn hn-btn--sm"
              data-testid="live-composition-toggle"
              aria-expanded="false"
              aria-controls="live-composition-form"
            >Go live…</button>
            <form class="live-form" id="live-composition-form" data-testid="live-composition-form" hidden>
              <label class="live-field">
                <span class="hn-muted">Content key</span>
                <input type="text" required data-testid="live-composition-package-key" placeholder="pkg-…" />
              </label>
              <label class="live-field">
                <span class="hn-muted">Kind</span>
                <select data-testid="live-composition-family">
                  ${LIVE_COMPOSITION_FAMILIES.map((family) => `<option value="${family}">${family}</option>`).join("")}
                </select>
              </label>
              <div class="live-actions">
                <button type="submit" class="hn-btn hn-btn--sm" data-testid="live-composition-submit">Connect</button>
                <button type="button" class="hn-btn hn-btn--sm" data-testid="live-composition-cancel">Cancel</button>
              </div>
              <p class="hn-muted live-note">
                Tool calls will mutate a real Studio draft on the connected server instead of local fixture state.
              </p>
            </form>
          </div>`;
  }

  #themeControlsMarkup(): string {
    const hidden = this.options.host.themeSwitcherVisibility === "hidden";
    return `<div class="app-theme-controls" data-testid="theme-controls" ${hidden ? "hidden" : ""}>
            <div class="theme-group" role="group" aria-label="Theme set">
              ${THEME_SETS.map(
                (set) =>
                  `<button type="button" class="hn-btn hn-btn--sm" data-theme-set-option="${set}" data-testid="theme-set-${set}">${THEME_SET_LABELS[set]}</button>`,
              ).join("")}
            </div>
            <div class="theme-group" role="group" aria-label="Theme mode">
              ${THEME_MODES.map(
                (mode) =>
                  `<button type="button" class="hn-btn hn-btn--sm" data-theme-mode-option="${mode}" data-testid="theme-mode-${mode}">${THEME_MODE_LABELS[mode]}</button>`,
              ).join("")}
            </div>
          </div>`;
  }

  /** Listeners are `connectedSignal`-scoped, so a rebuild never doubles them up. */
  #bindControls(): void {
    const { host } = this.options;
    this.#on(this.#control("recipe-toggle"), "click", () => {
      if (this.recipeOutlet()?.hidden) host.openRecipePicker();
      else host.closeRecipePicker();
    });
    this.#bindThemeControls();
    for (const link of this.#root?.querySelectorAll<HTMLAnchorElement>("[data-path]") ?? []) {
      this.#on(link, "click", (event) => {
        const path = link.dataset.path;
        // In hash mode the anchor's own href navigates and the router's hashchange listener follows.
        if (path) this.options.onNavigate(path, event);
      });
    }
    this.#on(this.#control("auth-signin"), "click", () => void host.auth.signIn());
    this.#on(this.#control("auth-signout"), "click", () => void host.auth.signOut());
    this.#bindLiveCompositionControls();
    this.#on(this.#control("design-inspector-toggle"), "click", () => {
      if (this.options.isDesignInspectorOpen()) host.closeDesignInspector();
      else void host.openDesignInspector();
    });
    for (const action of HISTORY_ACTIONS) {
      this.#on(this.#control(`history-${action}`), "click", () => void host.applyHistoryAction(action));
    }
  }

  #bindThemeControls(): void {
    const { host } = this.options;
    for (const button of this.#root?.querySelectorAll<HTMLButtonElement>("[data-theme-set-option]") ?? []) {
      this.#on(button, "click", () => {
        host.themeSet = button.dataset.themeSetOption as ThemeSet;
      });
    }
    for (const button of this.#root?.querySelectorAll<HTMLButtonElement>("[data-theme-mode-option]") ?? []) {
      this.#on(button, "click", () => {
        host.themeMode = button.dataset.themeModeOption as ThemeMode;
      });
    }
  }

  #bindLiveCompositionControls(): void {
    const { host } = this.options;
    const form = this.#control<HTMLFormElement>("live-composition-form");
    const toggle = this.#control("live-composition-toggle");
    this.#on(toggle, "click", () => {
      // One button: open the connect form in fixture mode, return to fixture mode when live.
      if (host.toolCallOrchestrator.isLive) {
        host.disableLiveEditing();
        return;
      }
      if (!form || !toggle) return;
      form.hidden = !form.hidden;
      toggle.setAttribute("aria-expanded", String(!form.hidden));
      if (!form.hidden) this.focus("live-composition-package-key");
    });
    this.#on(this.#control("live-composition-cancel"), "click", () => this.#closeLiveForm());
    this.#on(form, "submit", (event) => {
      event.preventDefault();
      const packageKey = this.#control<HTMLInputElement>("live-composition-package-key")?.value.trim();
      if (!packageKey) return;
      const family = this.#control<HTMLSelectElement>("live-composition-family")?.value as
        | StudioPackageFamilyWire
        | undefined;
      this.#closeLiveForm();
      host.enableLiveEditing({ packageKey, ...(family ? { family } : {}) });
    });
  }

  #closeLiveForm(): void {
    const form = this.#control<HTMLFormElement>("live-composition-form");
    if (form) form.hidden = true;
    this.markCollapsed("live-composition-toggle");
  }
}
