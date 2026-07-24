/**
 * `<honua-studio-app>` — the full Studio shell (honua-studio#5 REQ-001/002).
 *
 * The standalone shell (src/main.ts) is now exactly this element mounted by
 * a thin bootstrap: header chrome (brand, nav, optional theme switcher) plus
 * a routed `#view` outlet, plus a persistent composition area slotting in
 * `<honua-studio-chat>` and `<honua-studio-canvas>`. See
 * docs/element-contract.md for the full attribute/property/event contract;
 * this file is the implementation, not a second copy of that doc.
 */
import { StudioClient } from "../client/studio-client.js";
import { renderAbout } from "../pages/about.js";
import { renderHome } from "../pages/home.js";
import { Router } from "../router/router.js";
import { ThemeLoader } from "../theme/theme-loader.js";
import type { ThemeMode, ThemeSet } from "../theme/theme-loader.js";
import { HonuaStudioElementBase } from "./base-element.js";
import { appShellStyles, baseElementStyles } from "./styles.js";
import type {
  HonuaStudioNavigateDetail,
  HonuaStudioRoutingMode,
  HonuaStudioSessionAdapter,
  HonuaStudioThemeChangeDetail,
  HonuaStudioThemeSwitcherVisibility,
} from "./types.js";

interface StudioRoute {
  path: string;
  navTestId: string;
  label: string;
  render: (root: HTMLElement, client: StudioClient) => void;
}

const ROUTES: readonly StudioRoute[] = [
  { path: "/", navTestId: "nav-home", label: "Home", render: (root, client) => renderHome(root, client) },
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

export class HonuaStudioAppElement extends HonuaStudioElementBase {
  static get observedAttributes(): string[] {
    return ["data-theme-set", "data-theme", "routing-mode", "current-path", "base-path", "theme-switcher"];
  }

  #session: HonuaStudioSessionAdapter | undefined;
  #sessionUnsubscribe: { remove(): void } | undefined;
  #studioClient: StudioClient | undefined;
  #themeLoader: ThemeLoader | undefined;
  #hashRouter: Router | undefined;
  #currentPath = "/";
  #chromeBuilt = false;

  /** Host-injected session adapter. See docs/embed-session.md. Unset means anonymous/fixture mode. */
  public get session(): HonuaStudioSessionAdapter | undefined {
    return this.#session;
  }

  public set session(session: HonuaStudioSessionAdapter | undefined) {
    if (this.#session === session) return;
    this.#sessionUnsubscribe?.remove();
    this.#session = session;
    this.#sessionUnsubscribe = session?.onChange(() => this.renderView());
    this.renderView();
  }

  /** The `StudioClient` powering the catalog/packages view. Defaults to a fresh instance reading from `/api`; override for fixtures/tests. */
  public get studioClient(): StudioClient {
    if (!this.#studioClient) this.#studioClient = new StudioClient();
    return this.#studioClient;
  }

  public set studioClient(client: StudioClient) {
    this.#studioClient = client;
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

  protected onConnect(signal: AbortSignal): void {
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
            route.render(root, this.studioClient);
            this.syncNavCurrent();
          },
        })),
        {
          path: "*",
          render: (root) => {
            this.#currentPath = "/";
            ROUTES[0]?.render(root, this.studioClient);
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
    this.#sessionUnsubscribe?.remove();
    this.#sessionUnsubscribe = undefined;
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
      return;
    }
    const switcherHidden = this.themeSwitcherVisibility === "hidden";
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

    const signal = this.connectedSignal;
    for (const button of this.shadowRoot?.querySelectorAll<HTMLButtonElement>("[data-theme-set-option]") ?? []) {
      button.addEventListener(
        "click",
        () => {
          this.themeSet = button.dataset.themeSetOption as ThemeSet;
        },
        { signal },
      );
    }
    for (const button of this.shadowRoot?.querySelectorAll<HTMLButtonElement>("[data-theme-mode-option]") ?? []) {
      button.addEventListener(
        "click",
        () => {
          this.themeMode = button.dataset.themeModeOption as ThemeMode;
        },
        { signal },
      );
    }
    for (const link of this.shadowRoot?.querySelectorAll<HTMLAnchorElement>("[data-path]") ?? []) {
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
    this.syncThemeControls();
    this.syncNavCurrent();
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

  private renderView(): void {
    if (!this.shadowRoot?.querySelector("#view")) return;
    if (this.routingMode === "host") {
      const route = ROUTES.find((candidate) => candidate.path === this.#currentPath) ?? ROUTES[0];
      route?.render(this.viewRoot(), this.studioClient);
      this.syncNavCurrent();
      return;
    }
    // Hash mode: the Router already renders on hashchange / start(); this
    // covers session/studioClient changes that should refresh the current
    // route's content without a navigation.
    const route = ROUTES.find((candidate) => candidate.path === this.#currentPath) ?? ROUTES[0];
    route?.render(this.viewRoot(), this.studioClient);
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
