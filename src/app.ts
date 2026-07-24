import { StudioClient } from "./client/studio-client.js";
import { renderAbout } from "./pages/about.js";
import { renderHome } from "./pages/home.js";
import { Router } from "./router/router.js";
import type { ThemeLoader, ThemeMode, ThemeSet, ThemeState } from "./theme/theme-loader.js";
import { THEME_MODES, THEME_SETS } from "./theme/theme-loader.js";

export interface AppOptions {
  root: HTMLElement;
  themeLoader: ThemeLoader;
  initialThemeState: ThemeState;
  studioClient?: StudioClient;
}

const THEME_SET_LABELS: Record<ThemeSet, string> = {
  standalone: "Standalone",
  console: "Console",
};

const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  light: "Light",
  dark: "Dark",
  auto: "Auto",
};

/**
 * Mounts the app shell: persistent header chrome (brand, nav, theme
 * controls) plus a `#view` outlet the router renders pages into. Theme
 * controls live in the shell, not per-page, so switching themes never
 * re-fetches or re-renders route content.
 */
export function mountApp(options: AppOptions): Router {
  const { root, themeLoader, initialThemeState } = options;
  const studioClient = options.studioClient ?? new StudioClient();

  root.innerHTML = `
    <div class="app-shell" data-testid="app-shell">
      <header class="app-header hn-panel">
        <div class="app-brand">
          <p class="hn-register">Honua Studio</p>
          <h1 class="app-title">Natural language to map app.</h1>
        </div>
        <nav class="app-nav" aria-label="Studio">
          <a href="#/" data-testid="nav-home">Home</a>
          <a href="#/about" data-testid="nav-about">About</a>
        </nav>
        <div class="app-theme-controls" data-testid="theme-controls">
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
    </div>
  `;

  const themeSetButtons = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-theme-set-option]"));
  const themeModeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-theme-mode-option]"));

  function paintThemeControls(state: ThemeState): void {
    for (const button of themeSetButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.themeSetOption === state.themeSet));
    }
    for (const button of themeModeButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.themeModeOption === state.mode));
    }
  }

  let currentThemeState = initialThemeState;
  paintThemeControls(currentThemeState);

  for (const button of themeSetButtons) {
    button.addEventListener("click", () => {
      const themeSet = button.dataset.themeSetOption as ThemeSet;
      themeLoader.setThemeSet(themeSet);
      currentThemeState = { ...currentThemeState, themeSet };
      paintThemeControls(currentThemeState);
    });
  }
  for (const button of themeModeButtons) {
    button.addEventListener("click", () => {
      const mode = button.dataset.themeModeOption as ThemeMode;
      themeLoader.setThemeMode(mode);
      currentThemeState = { ...currentThemeState, mode };
      paintThemeControls(currentThemeState);
    });
  }

  const viewRoot = root.querySelector<HTMLElement>("#view");
  if (!viewRoot) throw new Error("App shell markup is missing its #view outlet.");

  const router = new Router(
    viewRoot,
    [
      { path: "/", render: (view) => renderHome(view, studioClient) },
      { path: "/about", render: renderAbout },
    ],
    { path: "*", render: (view) => renderHome(view, studioClient) },
  );
  router.start();
  return router;
}
