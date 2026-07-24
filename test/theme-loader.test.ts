import { describe, expect, it } from "vitest";

import {
  DEFAULT_THEME_MODE,
  DEFAULT_THEME_SET,
  ThemeLoader,
  applyThemeMode,
  applyThemeSet,
  resolveInitialThemeMode,
  resolveInitialThemeSet,
} from "../src/theme/theme-loader.js";
import type { ThemeStorage, ThemeTarget } from "../src/theme/theme-loader.js";

function createTarget(): ThemeTarget {
  return { dataset: {} };
}

function createStorage(seed: Record<string, string> = {}): ThemeStorage & { data: Record<string, string> } {
  const data: Record<string, string> = { ...seed };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe("theme-loader", () => {
  it("defaults to the standalone theme set and auto mode with no storage", () => {
    expect(resolveInitialThemeSet(null)).toBe(DEFAULT_THEME_SET);
    expect(resolveInitialThemeSet(null)).toBe("standalone");
    expect(resolveInitialThemeMode(null)).toBe(DEFAULT_THEME_MODE);
    expect(resolveInitialThemeMode(null)).toBe("auto");
  });

  it("ignores garbage storage values and falls back to defaults", () => {
    const storage = createStorage({ "honua-studio:theme-set": "not-a-real-set", "honua-studio:theme-mode": "sepia" });
    expect(resolveInitialThemeSet(storage)).toBe("standalone");
    expect(resolveInitialThemeMode(storage)).toBe("auto");
  });

  it("reads a previously persisted theme set and mode", () => {
    const storage = createStorage({ "honua-studio:theme-set": "console", "honua-studio:theme-mode": "dark" });
    expect(resolveInitialThemeSet(storage)).toBe("console");
    expect(resolveInitialThemeMode(storage)).toBe("dark");
  });

  it("applyThemeSet stamps data-theme-set and persists it", () => {
    const target = createTarget();
    const storage = createStorage();
    applyThemeSet(target, "console", storage);
    expect(target.dataset.themeSet).toBe("console");
    expect(storage.data["honua-studio:theme-set"]).toBe("console");
  });

  it("applyThemeMode stamps data-theme for light/dark and clears it for auto", () => {
    const target = createTarget();
    const storage = createStorage();

    applyThemeMode(target, "dark", storage);
    expect(target.dataset.theme).toBe("dark");
    expect(storage.data["honua-studio:theme-mode"]).toBe("dark");

    applyThemeMode(target, "auto", storage);
    expect(target.dataset.theme).toBeUndefined();
    expect(storage.data["honua-studio:theme-mode"]).toBe("auto");
  });

  it("ThemeLoader.boot applies persisted state to the target", () => {
    const target = createTarget();
    const storage = createStorage({ "honua-studio:theme-set": "console", "honua-studio:theme-mode": "light" });
    const loader = new ThemeLoader(target, storage);

    const state = loader.boot();

    expect(state).toEqual({ themeSet: "console", mode: "light" });
    expect(target.dataset.themeSet).toBe("console");
    expect(target.dataset.theme).toBe("light");
  });

  it("ThemeLoader.setThemeSet / setThemeMode mutate the target and persist", () => {
    const target = createTarget();
    const storage = createStorage();
    const loader = new ThemeLoader(target, storage);
    loader.boot();

    loader.setThemeSet("console");
    loader.setThemeMode("dark");

    expect(target.dataset.themeSet).toBe("console");
    expect(target.dataset.theme).toBe("dark");
    expect(storage.data["honua-studio:theme-set"]).toBe("console");
    expect(storage.data["honua-studio:theme-mode"]).toBe("dark");

    loader.setThemeMode("auto");
    expect(target.dataset.theme).toBeUndefined();
  });

  it("works with no storage at all (in-memory only)", () => {
    const target = createTarget();
    const loader = new ThemeLoader(target);
    const state = loader.boot();
    expect(state).toEqual({ themeSet: "standalone", mode: "auto" });
    loader.setThemeSet("console");
    expect(target.dataset.themeSet).toBe("console");
  });
});
