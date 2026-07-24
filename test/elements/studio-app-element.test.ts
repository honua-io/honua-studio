// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioAppElement } from "../../src/elements/studio-app-element.js";
import type { HonuaStudioNavigateDetail, HonuaStudioThemeChangeDetail } from "../../src/elements/types.js";

registerAllStudioElements();

function mount(attrs: Record<string, string> = {}): HonuaStudioAppElement {
  const app = document.createElement("honua-studio-app") as HonuaStudioAppElement;
  for (const [name, value] of Object.entries(attrs)) app.setAttribute(name, value);
  document.body.appendChild(app);
  return app;
}

describe("elements/studio-app-element HonuaStudioAppElement", () => {
  beforeEach(() => {
    // The default StudioClient fetches /api/* — stub it out so these
    // contract tests never depend on (or noisily fail to reach) a real
    // server; renderHome()'s own catch path renders an error state, which
    // is fine and unrelated to what these tests assert.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network disabled in unit tests"))),
    );
  });

  afterEach(() => {
    document.body.innerHTML = "";
    window.location.hash = "";
    window.localStorage.clear(); // theme choices persist across mounts by design — isolate tests from each other
    vi.unstubAllGlobals();
  });

  it("mounts a shadow shell with the documented data-testids", () => {
    const app = mount();
    const shell = app.shadowRoot?.querySelector('[data-testid="app-shell"]');
    expect(shell).toBeTruthy();
    expect(app.shadowRoot?.querySelector('[data-testid="app-view"]')).toBeTruthy();
    expect(app.shadowRoot?.querySelector('[data-testid="theme-controls"]')).toBeTruthy();
    // Default composition: chat + canvas placeholders, slotted as light-DOM children.
    expect(app.querySelector("honua-studio-chat")).toBeTruthy();
    expect(app.querySelector("honua-studio-canvas")).toBeTruthy();
  });

  it("defaults to routing-mode=hash and reflects window.location.hash into currentPath", () => {
    window.location.hash = "#/about";
    const app = mount();
    expect(app.routingMode).toBe("hash");
    expect(app.currentPath).toBe("/about");
    expect(app.shadowRoot?.querySelector('[data-testid="about-section"]')).toBeTruthy();
  });

  it("routing-mode=host: never touches window.location, and clicking a nav link only dispatches honua-studio-navigate", () => {
    const app = mount({ "routing-mode": "host", "current-path": "/" });
    const before = window.location.hash;
    const navigateListener = vi.fn();
    app.addEventListener("honua-studio-navigate", navigateListener);

    const aboutLink = app.shadowRoot?.querySelector<HTMLAnchorElement>('[data-testid="nav-about"]');
    expect(aboutLink).toBeTruthy();
    aboutLink?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(window.location.hash).toBe(before); // untouched — host owns the URL
    expect(navigateListener).toHaveBeenCalledTimes(1);
    const detail = (navigateListener.mock.calls[0]?.[0] as CustomEvent<HonuaStudioNavigateDetail>).detail;
    expect(detail.path).toBe("/about");

    // The view does not change until the host reflects its own decision back.
    expect(app.shadowRoot?.querySelector('[data-testid="about-section"]')).toBeFalsy();
    app.currentPath = "/about";
    expect(app.shadowRoot?.querySelector('[data-testid="about-section"]')).toBeTruthy();
    expect(app.getAttribute("current-path")).toBe("/about");
  });

  it("routing-mode=host honors base-path when the host reflects a prefixed current-path", () => {
    const app = mount({ "routing-mode": "host", "base-path": "/studio", "current-path": "/studio/about" });
    expect(app.currentPath).toBe("/about");
    expect(app.shadowRoot?.querySelector('[data-testid="about-section"]')).toBeTruthy();

    const navigateListener = vi.fn();
    app.addEventListener("honua-studio-navigate", navigateListener);
    app.shadowRoot
      ?.querySelector<HTMLAnchorElement>('[data-testid="nav-home"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const detail = (navigateListener.mock.calls[0]?.[0] as CustomEvent<HonuaStudioNavigateDetail>).detail;
    expect(detail.path).toBe("/studio"); // base-path re-applied for the host's own router
  });

  it("theme-set/theme-mode: scoped to the element itself, never to document.documentElement", () => {
    const app = mount();
    expect(document.documentElement.hasAttribute("data-theme-set")).toBe(false);

    app.themeSet = "console";
    app.themeMode = "dark";
    expect(app.getAttribute("data-theme-set")).toBe("console");
    expect(app.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.hasAttribute("data-theme-set")).toBe(false);

    const setButton = app.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="theme-set-console"]');
    expect(setButton?.getAttribute("aria-pressed")).toBe("true");
  });

  it("dispatches honua-studio-theme-change whenever the theme attributes change, from any cause", () => {
    const app = mount();
    const listener = vi.fn();
    app.addEventListener("honua-studio-theme-change", listener);

    app.setAttribute("data-theme-set", "console"); // external host mutation, not the built-in switcher
    expect(listener).toHaveBeenCalledTimes(1);
    const detail = (listener.mock.calls[0]?.[0] as CustomEvent<HonuaStudioThemeChangeDetail>).detail;
    expect(detail).toEqual({ themeSet: "console", mode: "auto" });
  });

  it("theme-switcher=hidden hides the built-in chrome but the property API still works", () => {
    const app = mount({ "theme-switcher": "hidden" });
    const controls = app.shadowRoot?.querySelector<HTMLElement>('[data-testid="theme-controls"]');
    expect(controls?.hidden).toBe(true);
    app.themeSet = "console";
    expect(app.themeSet).toBe("console");
  });

  it("full mount/unmount lifecycle removes the hash router's window listener", () => {
    const app = mount();
    const removeSpy = vi.spyOn(window, "removeEventListener");
    document.body.removeChild(app);
    expect(removeSpy).toHaveBeenCalledWith("hashchange", expect.any(Function));
    removeSpy.mockRestore();
  });
});
