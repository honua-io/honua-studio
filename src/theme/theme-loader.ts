/**
 * Theme-token loader (honua-studio#3 REQ-002).
 *
 * Owns exactly two DOM attributes on the theme target (normally
 * `document.documentElement`):
 *
 * - `data-theme-set`  — which token SET is active: "standalone" (the
 *   open-source shell's Honua brand palette) or "console" (the denser
 *   restyle Honua Console's `/studio` embed applies). See
 *   src/theme/theme-standalone.css and src/theme/theme-console.css.
 * - `data-theme`      — an explicit light/dark override. Left unset, the
 *   token sets fall back to `prefers-color-scheme`; setting it always wins
 *   over the OS preference, in either direction.
 *
 * Framework-free and DOM-free by construction (the target and storage are
 * injected) so this is unit-testable without jsdom — see
 * test/theme-loader.test.ts.
 */

export type ThemeSet = "standalone" | "console";
export type ThemeMode = "light" | "dark" | "auto";

/** The minimal DOM surface this module touches — real elements satisfy it. */
export interface ThemeTarget {
  dataset: Record<string, string | undefined>;
}

/** The minimal storage surface this module touches — `localStorage` satisfies it. */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const THEME_SETS: readonly ThemeSet[] = ["standalone", "console"];
export const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "auto"];

export const DEFAULT_THEME_SET: ThemeSet = "standalone";
export const DEFAULT_THEME_MODE: ThemeMode = "auto";

const THEME_SET_STORAGE_KEY = "honua-studio:theme-set";
const THEME_MODE_STORAGE_KEY = "honua-studio:theme-mode";

function isThemeSet(value: string | null | undefined): value is ThemeSet {
  return value === "standalone" || value === "console";
}

function isThemeMode(value: string | null | undefined): value is ThemeMode {
  return value === "light" || value === "dark" || value === "auto";
}

/** Reads the persisted theme set, falling back to {@link DEFAULT_THEME_SET}. */
export function resolveInitialThemeSet(storage?: ThemeStorage | null): ThemeSet {
  const stored = storage?.getItem(THEME_SET_STORAGE_KEY) ?? null;
  return isThemeSet(stored) ? stored : DEFAULT_THEME_SET;
}

/** Reads the persisted theme mode, falling back to {@link DEFAULT_THEME_MODE} ("auto" = follow the OS). */
export function resolveInitialThemeMode(storage?: ThemeStorage | null): ThemeMode {
  const stored = storage?.getItem(THEME_MODE_STORAGE_KEY) ?? null;
  return isThemeMode(stored) ? stored : DEFAULT_THEME_MODE;
}

/** Stamps `data-theme-set` on the target and persists the choice. */
export function applyThemeSet(target: ThemeTarget, themeSet: ThemeSet, storage?: ThemeStorage | null): void {
  target.dataset.themeSet = themeSet;
  storage?.setItem(THEME_SET_STORAGE_KEY, themeSet);
}

/**
 * Stamps `data-theme` on the target and persists the choice. "auto" clears
 * the attribute so the CSS `prefers-color-scheme` rule takes over.
 */
export function applyThemeMode(target: ThemeTarget, mode: ThemeMode, storage?: ThemeStorage | null): void {
  if (mode === "auto") {
    delete target.dataset.theme;
  } else {
    target.dataset.theme = mode;
  }
  storage?.setItem(THEME_MODE_STORAGE_KEY, mode);
}

export interface ThemeState {
  themeSet: ThemeSet;
  mode: ThemeMode;
}

/** Small stateful convenience wrapper over the pure functions above. */
export class ThemeLoader {
  constructor(
    private readonly target: ThemeTarget,
    private readonly storage: ThemeStorage | null = null,
  ) {}

  /** Applies the persisted (or default) theme to the target and returns it. */
  boot(): ThemeState {
    const themeSet = resolveInitialThemeSet(this.storage);
    const mode = resolveInitialThemeMode(this.storage);
    applyThemeSet(this.target, themeSet, this.storage);
    applyThemeMode(this.target, mode, this.storage);
    return { themeSet, mode };
  }

  setThemeSet(themeSet: ThemeSet): void {
    applyThemeSet(this.target, themeSet, this.storage);
  }

  setThemeMode(mode: ThemeMode): void {
    applyThemeMode(this.target, mode, this.storage);
  }
}
