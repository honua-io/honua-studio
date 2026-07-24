/**
 * `<honua-studio-app>` — the full Studio shell (honua-studio#5 REQ-001/002).
 *
 * The standalone shell (src/main.ts) is now exactly this element mounted by
 * a thin bootstrap: header chrome (brand, nav, session/auth controls,
 * optional theme switcher) plus a routed `#view` outlet, plus a persistent
 * composition area slotting in `<honua-studio-chat>` and
 * `<honua-studio-canvas>`. See docs/element-contract.md for the full
 * attribute/property/event contract and docs/embed-session.md for the
 * session contract this element drives; this file is the implementation,
 * not a second copy of either doc.
 *
 * Session/auth (honua-studio#4 REQ-001/003, reconciled here after #4 merged
 * ahead of this branch): `.session` is the embed injection surface — an
 * optional host-provided `SessionAdapter` (`../auth/types.js`), the SAME
 * type `window.__HONUA_STUDIO_HOST_SESSION__` already used, just promoted
 * to the primary path (see docs/embed-session.md). Internally this element
 * always resolves a full `AuthSession` via `createAuthSession()` — standalone
 * OIDC when no adapter is present (property or window global), a
 * `HostAdapterAuthSession` wrapping the adapter otherwise — and that's what
 * drives the auth-status label, the standalone sign-in/out controls (never
 * rendered in host-adapter mode — REQ-003), and gates the catalog/packages
 * fetch in `../pages/home.js`.
 */
import { type AuthSession, type SessionAdapter, createAuthSession } from "../auth/index.js";
import { StudioClient } from "../client/studio-client.js";
import { renderAbout } from "../pages/about.js";
import { renderHome } from "../pages/home.js";
import { Router } from "../router/router.js";
import { ThemeLoader } from "../theme/theme-loader.js";
import type { ThemeMode, ThemeSet } from "../theme/theme-loader.js";
import { AUTH_STATUS_LABELS } from "./auth-status.js";
import { HonuaStudioElementBase } from "./base-element.js";
import { appShellStyles, baseElementStyles } from "./styles.js";
import type {
  HonuaStudioNavigateDetail,
  HonuaStudioRoutingMode,
  HonuaStudioThemeChangeDetail,
  HonuaStudioThemeSwitcherVisibility,
} from "./types.js";

interface StudioRoute {
  path: string;
  navTestId: string;
  label: string;
  render: (root: HTMLElement, client: StudioClient, auth: AuthSession) => void;
}

const ROUTES: readonly StudioRoute[] = [
  {
    path: "/",
    navTestId: "nav-home",
    label: "Home",
    render: (root, client, auth) => renderHome(root, client, auth),
  },
  { path: "/about", navTestId: "nav-about", label: "About", render: (root) => renderAbout(root) },
];

const THEME_SETS: readonly ThemeSet[] = ["standalone", "console"];
const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "auto"];
const THEME_SET_LABELS: Record<ThemeSet, string> = { standalone: "Standalone", console: "Console" };
const THEME_MODE_LABELS: Record<ThemeMode, string> = { light: "Light", dark: "Dark", auto: "Auto" };

function normalizePath(path: string): string {
  if (!path || path === "") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function stripBasePath(path: string, basePath: string | null): string {
  if (!basePath) return path;
  const trimmedBase = basePath.replace(/\/$/, "");
  if (trimmedBase && path.startsWith(trimmedBase)) {
    const rest = path.slice(trimmedBase.length);
    return normalizePath(rest === "" ? "/" : rest);
  }
  return path;
}

function withBasePath(path: string, basePath: string | null): string {
  if (!basePath) return path;
  const trimmedBase = basePath.replace(/\/$/, "");
  return path === "/" ? trimmedBase || "/" : `${trimmedBase}${path}`;
}

/** `AuthSession` implementations that own an external subscription (`HostAdapterAuthSession`) expose `dispose()`; `OidcAuthSession` doesn't need one. Duck-typed so this element never imports the concrete classes. */
function disposeAuthSession(auth: AuthSession | undefined): void {
  (auth as (AuthSession & { dispose?: () => void }) | undefined)?.dispose?.();
}

export class HonuaStudioAppElement extends HonuaStudioElementBase {
  static get observedAttributes(): string[] {
    return ["data-theme-set", "data-theme", "routing-mode", "current-path", "base-path", "theme-switcher"];
  }

  #session: SessionAdapter | undefined;
  #auth: AuthSession | undefined;
  #authUnsubscribe: (() => void) | undefined;
  #redirectCallbackHandled = false;
  #studioClient: StudioClient | undefined;
  #studioClientOverridden = false;
  #themeLoader: ThemeLoader | undefined;
  #hashRouter: Router | undefined;
  #currentPath = "/";
  #chromeBuilt = false;

  /**
   * Host-injected session adapter — the primary embed injection path
   * (docs/embed-session.md). `getToken()`/`onExpired()`, matching
   * `window.__HONUA_STUDIO_HOST_SESSION__`'s documented fallback shape
   * exactly (honua-studio#4 REQ-003) — a host may use either, never both.
   * Unset means: use the window global if present, else run standalone
   * OIDC. Assigning this after the element is already connected tears down
   * and rebuilds `.auth` (and disposes the previous session cleanly).
   */
  public get session(): SessionAdapter | undefined {
    return this.#session;
  }

  public set session(session: SessionAdapter | undefined) {
    if (this.#session === session) return;
    this.#session = session;
    if (!this.isConnected) return;
    this.resetAuth();
    // auth.mode may have just changed (standalone <-> host-adapter), and
    // the chrome's sign-in/out button markup depends on that — a
    // paintAuthControls()-only refresh (what auth.subscribe's listener
    // already triggers on every dispatch) only toggles [hidden] on existing
    // buttons, it can't add/remove them. Force a full chrome rebuild so a
    // `.session` reassignment after connection — a capability #4's original
    // app.ts never needed, since it built one fixed AuthSession per app
    // lifetime — is actually correct, not just "usually fine because nobody
    // does this". Also re-render the route content ONCE so it picks up the
    // new `.auth` (route render functions receive `auth` as a fresh
    // argument, not a live binding) — deliberately NOT done from inside
    // auth.subscribe's own listener below; see that listener's comment.
    this.#chromeBuilt = false;
    this.renderChrome();
    this.renderView();
  }

  /**
   * The resolved, live `AuthSession` this element (and, through
   * `src/elements/session.ts`'s `resolveInjectedAuth`, every descendant
   * placeholder) actually drives its UI from — standalone OIDC or a
   * `HostAdapterAuthSession` wrapping `.session`, decided by
   * `createAuthSession()`. Read-only; constructed lazily.
   */
  public get auth(): AuthSession {
    return this.#auth ?? this.resetAuth();
  }

  /** The `StudioClient` powering the catalog/packages view — bearer-attached via `.auth`. Defaults to a fresh instance reading from `/api`; override for fixtures/tests. */
  public get studioClient(): StudioClient {
    if (!this.#studioClient) this.#studioClient = new StudioClient("/api", this.auth);
    return this.#studioClient;
  }

  public set studioClient(client: StudioClient) {
    this.#studioClient = client;
    this.#studioClientOverridden = true;
    this.renderView();
  }

  /** `"hash"` (default, self-owned) or `"host"` (host-owned URL — see docs/element-contract.md § Routing). */
  public get routingMode(): HonuaStudioRoutingMode {
    return this.getAttribute("routing-mode") === "host" ? "host" : "hash";
  }

  public set routingMode(mode: HonuaStudioRoutingMode) {
    this.setAttribute("routing-mode", mode);
  }

  /**
   * The path currently rendered. In `"hash"` mode this mirrors
   * `window.location.hash` and is read-only in practice (the element is the
   * source of truth). In `"host"` mode the host is the source of truth:
   * assign this (or set the `current-path` attribute) whenever the host's
   * own router navigates, and listen for `honua-studio-navigate` to learn
   * when the element wants to navigate.
   */
  public get currentPath(): string {
    return this.#currentPath;
  }

  public set currentPath(path: string) {
    // Delegates entirely to the `current-path` attribute + attributeChangedCallback
    // — the single place base-path stripping happens (see stripBasePath()
    // below). honua-studio#5 finding: this setter used to normalize and
    // write `#currentPath` directly, WITHOUT stripping base-path, which
    // then immediately overwrote the correctly-stripped value
    // attributeChangedCallback had just computed for the same call —
    // harness/blazor-host's watchdog remount path calls `mount()` (sets the
    // attribute directly, base-path correctly stripped) followed by
    // `syncCurrentPath()` (used this setter, silently un-stripping it back
    // to the raw host path) on every single resync, so `<honua-studio-app>`
    // always rendered its home route instead of the one the URL said.
    if (this.getAttribute("current-path") === path) return;
    this.setAttribute("current-path", path);
  }

  public get themeSet(): ThemeSet {
    const value = this.getAttribute("data-theme-set");
    return value === "console" ? "console" : "standalone";
  }

  public set themeSet(value: ThemeSet) {
    (this.#themeLoader ?? this.ensureThemeLoader()).setThemeSet(value);
  }

  public get themeMode(): ThemeMode {
    const value = this.getAttribute("data-theme");
    return value === "light" || value === "dark" ? value : "auto";
  }

  public set themeMode(value: ThemeMode) {
    (this.#themeLoader ?? this.ensureThemeLoader()).setThemeMode(value);
  }

  public get themeSwitcherVisibility(): HonuaStudioThemeSwitcherVisibility {
    return this.getAttribute("theme-switcher") === "hidden" ? "hidden" : "visible";
  }

  public set themeSwitcherVisibility(value: HonuaStudioThemeSwitcherVisibility) {
    this.setAttribute("theme-switcher", value);
  }

  private ensureThemeLoader(): ThemeLoader {
    if (!this.#themeLoader) {
      this.#themeLoader = new ThemeLoader(this, safeLocalStorage());
    }
    return this.#themeLoader;
  }

  /** (Re)builds `.auth` from the current `.session`, disposing whatever was there before. Always leaves `#auth` set; returns it. */
  private resetAuth(): AuthSession {
    this.#authUnsubscribe?.();
    this.#authUnsubscribe = undefined;
    disposeAuthSession(this.#auth);
    if (!this.#studioClientOverridden) this.#studioClient = undefined;

    const auth = createAuthSession({ hostAdapter: this.#session });
    this.#auth = auth;
    // honua-studio#5 finding: paintAuthControls() ONLY here — never
    // renderView(). AuthSession implementations dispatch a state change on
    // EVERY getAccessToken() call, even when the token is unchanged
    // (HostAdapterAuthSession.getAccessToken() unconditionally re-dispatches
    // "credential-issued" — see src/auth/host-session.ts). renderView()
    // re-invokes the current route's render function, and the home route
    // (../pages/home.js) calls client.listCatalog()/listPackages(), each of
    // which calls auth.getAccessToken() to attach a bearer header — which
    // dispatches again — which (had this listener also called renderView())
    // would re-invoke the route render, re-fetch, re-dispatch, forever: a
    // tight synchronous-enough loop that hung page load solid in testing,
    // with no thrown error to surface it. The route-level view already
    // manages its OWN reactivity to auth changes via its own independent
    // `auth.subscribe()` (renderHome's `onAuthState`, unsubscribing itself
    // once its own DOM is replaced) — this top-level listener's only job is
    // the header's status label / sign-in-out button visibility.
    this.#authUnsubscribe = auth.subscribe(() => {
      this.paintAuthControls();
    });
    if (this.isConnected) void this.completeStandaloneRedirectCallback(auth);
    return auth;
  }

  /**
   * Completes an OIDC Authorization Code redirect back to this page
   * (honua-studio#4 REQ-001), ported from #4's src/main.ts into the element
   * itself so every host gets it, not just the standalone shell's own
   * bootstrap — "no privileged internal APIs" (REQ-002) cuts both ways:
   * nothing in main.ts does anything the element can't do for itself.
   * No-op outside standalone mode or when the URL isn't a redirect
   * callback; runs at most once per connection.
   */
  private async completeStandaloneRedirectCallback(auth: AuthSession): Promise<void> {
    if (this.#redirectCallbackHandled) return;
    if (auth.mode !== "standalone" || !auth.isRedirectCallback()) return;
    this.#redirectCallbackHandled = true;
    try {
      await auth.handleRedirectCallback();
    } catch {
      // The state machine already reflects the failure (auth.subscribe's
      // listener repaints "expired"); the shell still needs to work so the
      // user can retry sign-in.
    }
    window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
  }

  protected onConnect(signal: AbortSignal): void {
    // Auth must resolve before the FIRST renderChrome() build below — the
    // shell's markup depends on `auth.mode` (host-adapter mode renders no
    // sign-in/out controls at all, REQ-003) and its initial status label.
    this.resetAuth();

    // Chrome (and its #view outlet) must exist before the hash router below
    // can bind to it — render() (chrome + view) otherwise only runs AFTER
    // onConnect returns. renderChrome() is idempotent, so the base class's
    // own post-onConnect render() call is a cheap no-op sync, not a rebuild.
    this.renderChrome();

    const loader = this.ensureThemeLoader();
    // A host that already stamped data-theme-set/data-theme (markup, or a
    // property set before this element upgraded) owns that decision — only
    // fall back to persisted/default state when neither is present, so the
    // standalone bootstrap's persistence never fights an embed's own choice.
    if (!this.hasAttribute("data-theme-set") && !this.hasAttribute("data-theme")) {
      loader.boot();
    }

    const basePath = this.getAttribute("base-path");
    if (this.routingMode === "hash") {
      this.#hashRouter = new Router(
        this.viewRoot(),
        ROUTES.map((route) => ({
          path: route.path,
          render: (root) => {
            this.#currentPath = route.path;
            route.render(root, this.studioClient, this.auth);
            this.syncNavCurrent();
          },
        })),
        {
          path: "*",
          render: (root) => {
            this.#currentPath = "/";
            ROUTES[0]?.render(root, this.studioClient, this.auth);
            this.syncNavCurrent();
          },
        },
      );
      this.#hashRouter.start();
    } else {
      this.#currentPath = stripBasePath(normalizePath(this.getAttribute("current-path") ?? "/"), basePath);
    }

    // Every connection gets its own default chat/canvas composition unless a
    // host has already supplied its own light-DOM children — a host that
    // wants total control over the composed surfaces skips this by pre-populating them.
    if (!this.querySelector("honua-studio-chat")) {
      const chat = document.createElement("honua-studio-chat");
      chat.slot = "chat";
      chat.setAttribute("label", "Chat");
      this.appendChild(chat);
    }
    if (!this.querySelector("honua-studio-canvas")) {
      const canvas = document.createElement("honua-studio-canvas");
      canvas.slot = "canvas";
      canvas.setAttribute("label", "Canvas");
      this.appendChild(canvas);
    }
    void signal; // Router cleanup goes through router.stop() in onDisconnect, not this signal — Router owns its own listener bookkeeping.
  }

  protected onDisconnect(): void {
    this.#hashRouter?.stop();
    this.#hashRouter = undefined;
    this.#authUnsubscribe?.();
    this.#authUnsubscribe = undefined;
    disposeAuthSession(this.#auth);
    this.#auth = undefined;
    this.#themeLoader = undefined;
    this.#chromeBuilt = false;
  }

  public attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (!this.isConnected || oldValue === newValue) return;
    if (name === "data-theme-set" || name === "data-theme") {
      this.dispatchTypedEvent<HonuaStudioThemeChangeDetail>("honua-studio-theme-change", {
        themeSet: this.themeSet,
        mode: this.themeMode,
      });
      this.syncThemeControls();
      return;
    }
    if (name === "current-path" && this.routingMode === "host") {
      const basePath = this.getAttribute("base-path");
      this.#currentPath = stripBasePath(normalizePath(newValue ?? "/"), basePath);
      this.renderView();
      return;
    }
    if (name === "theme-switcher") {
      this.renderChrome();
      return;
    }
    if (name === "routing-mode" || name === "base-path") {
      // Mode/base-path changes mid-connection are unusual; re-run onConnect's
      // routing setup (stop any hash router, re-derive the current path) and
      // re-render. This reuses the connection's own AbortSignal — still
      // live, since disconnectedCallback (real unmount) hasn't run — so
      // listeners set up here still clean up correctly on the next
      // disconnect, and the chrome's own listeners are untouched.
      this.#hashRouter?.stop();
      this.#hashRouter = undefined;
      const signal = this.connectedSignal;
      if (signal) this.onConnect(signal);
      this.render();
    }
  }

  protected render(): void {
    this.renderChrome();
    this.renderView();
  }

  private viewRoot(): HTMLElement {
    const root = this.shadowRoot?.querySelector<HTMLElement>("#view");
    if (!root) throw new Error("honua-studio-app: shell markup is missing its #view outlet.");
    return root;
  }

  private renderChrome(): void {
    if (this.#chromeBuilt && this.shadowRoot?.querySelector(".app-shell")) {
      this.syncThemeControls();
      this.syncNavCurrent();
      this.paintAuthControls();
      return;
    }
    const switcherHidden = this.themeSwitcherVisibility === "hidden";
    // REQ-003: the embed host owns sign-in/out, so Studio never renders
    // interactive auth controls in host-adapter mode — only a status label.
    const authControlsMarkup =
      this.auth.mode === "standalone"
        ? `<button type="button" class="hn-btn hn-btn--sm" data-testid="auth-signin" hidden>Sign in</button>
           <button type="button" class="hn-btn hn-btn--sm" data-testid="auth-signout" hidden>Sign out</button>`
        : "";
    this.setShadowHtml(`
      <style>${baseElementStyles()}${appShellStyles()}</style>
      <div class="app-shell" data-testid="app-shell">
        <header class="app-header hn-panel">
          <div class="app-brand">
            <p class="hn-register">Honua Studio</p>
            <h1 class="app-title">Natural language to map app.</h1>
          </div>
          <nav class="app-nav" aria-label="Studio">
            ${ROUTES.map(
              (route) =>
                `<a href="#${route.path}" data-path="${route.path}" data-testid="${route.navTestId}">${route.label}</a>`,
            ).join("")}
          </nav>
          <div class="app-auth" data-testid="auth-controls" role="group" aria-label="Session">
            <span class="hn-muted" data-testid="auth-status"></span>
            ${authControlsMarkup}
          </div>
          <div class="app-theme-controls" data-testid="theme-controls" ${switcherHidden ? "hidden" : ""}>
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
          </div>
        </header>
        <main id="view" class="app-view" data-testid="app-view"></main>
        <div class="app-slots" data-testid="app-slots">
          <slot name="chat"></slot>
          <slot name="canvas"></slot>
        </div>
      </div>
    `);
    this.#chromeBuilt = true;

    const root = this.shadowRoot;
    const signal = this.connectedSignal;
    for (const button of root?.querySelectorAll<HTMLButtonElement>("[data-theme-set-option]") ?? []) {
      button.addEventListener(
        "click",
        () => {
          this.themeSet = button.dataset.themeSetOption as ThemeSet;
        },
        { signal },
      );
    }
    for (const button of root?.querySelectorAll<HTMLButtonElement>("[data-theme-mode-option]") ?? []) {
      button.addEventListener(
        "click",
        () => {
          this.themeMode = button.dataset.themeModeOption as ThemeMode;
        },
        { signal },
      );
    }
    for (const link of root?.querySelectorAll<HTMLAnchorElement>("[data-path]") ?? []) {
      link.addEventListener(
        "click",
        (event) => {
          const path = link.dataset.path;
          if (!path) return;
          if (this.routingMode === "host") {
            // Host owns the URL: never touch window.location, only request.
            event.preventDefault();
            const basePath = this.getAttribute("base-path");
            this.dispatchTypedEvent<HonuaStudioNavigateDetail>("honua-studio-navigate", {
              path: withBasePath(path, basePath),
            });
          }
          // In "hash" mode the anchor's own href does the navigating; the
          // Router's hashchange listener picks it up.
        },
        { signal },
      );
    }
    root?.querySelector('[data-testid="auth-signin"]')?.addEventListener(
      "click",
      () => {
        void this.auth.signIn();
      },
      { signal },
    );
    root?.querySelector('[data-testid="auth-signout"]')?.addEventListener(
      "click",
      () => {
        void this.auth.signOut();
      },
      { signal },
    );

    this.syncThemeControls();
    this.syncNavCurrent();
    this.paintAuthControls();
  }

  private syncThemeControls(): void {
    const root = this.shadowRoot;
    if (!root) return;
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-theme-set-option]")) {
      button.setAttribute("aria-pressed", String(button.dataset.themeSetOption === this.themeSet));
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-theme-mode-option]")) {
      button.setAttribute("aria-pressed", String(button.dataset.themeModeOption === this.themeMode));
    }
    const controls = root.querySelector<HTMLElement>('[data-testid="theme-controls"]');
    if (controls) controls.hidden = this.themeSwitcherVisibility === "hidden";
  }

  private syncNavCurrent(): void {
    const root = this.shadowRoot;
    if (!root) return;
    for (const link of root.querySelectorAll<HTMLAnchorElement>("[data-path]")) {
      if (link.dataset.path === this.#currentPath) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  private paintAuthControls(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const state = this.#auth?.getState() ?? { status: "signed-out" as const };
    const statusEl = root.querySelector<HTMLElement>('[data-testid="auth-status"]');
    if (statusEl) statusEl.textContent = AUTH_STATUS_LABELS[state.status];
    const signInButton = root.querySelector<HTMLButtonElement>('[data-testid="auth-signin"]');
    const signOutButton = root.querySelector<HTMLButtonElement>('[data-testid="auth-signout"]');
    const signedIn = state.status === "fresh" || state.status === "refreshing";
    if (signInButton) signInButton.hidden = signedIn;
    if (signOutButton) signOutButton.hidden = !signedIn;
  }

  private renderView(): void {
    if (!this.shadowRoot?.querySelector("#view")) return;
    const route = ROUTES.find((candidate) => candidate.path === this.#currentPath) ?? ROUTES[0];
    route?.render(this.viewRoot(), this.studioClient, this.auth);
    this.syncNavCurrent();
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}
