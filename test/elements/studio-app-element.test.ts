// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioAppElement } from "../../src/elements/studio-app-element.js";
import type {
  HonuaStudioNavigateDetail,
  HonuaStudioThemeChangeDetail,
  SessionAdapter,
} from "../../src/elements/types.js";
import { StudioLifecycleClient } from "../../src/lifecycle/lifecycle-client.js";

registerAllStudioElements();

/**
 * A trivial `SessionAdapter` fixture — assigning it BEFORE `appendChild`
 * puts the element in host-adapter auth mode (synchronous, no OIDC
 * discovery fetch), so these element-contract tests never depend on network
 * access or race an unawaited standalone `OidcAuthSession` discovery
 * promise (honua-studio#4 owns testing the OIDC path itself — see
 * test/auth/*.test.ts).
 */
function fixtureSession(): SessionAdapter {
  return {
    getToken: async () => "fixture-token",
    onExpired: () => () => {},
  };
}

function mount(attrs: Record<string, string> = {}): HonuaStudioAppElement {
  const app = document.createElement("honua-studio-app") as HonuaStudioAppElement;
  app.session = fixtureSession();
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

  it("attaches an authorized draft as a fresh undo baseline and clears it on principal change", async () => {
    const get = vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockResolvedValue({
      draftId: "draft",
      generation: 2,
      packageKey: "map",
      envelope: {
        family: "map",
        schemaVersion: "1.0",
        format: "honua_map_package.v1",
        body: { layers: [] },
      },
    } as Awaited<ReturnType<StudioLifecycleClient["getDraft"]>>);
    try {
      const app = mount();
      app.composition.apply({ name: "addLayer", layer: { id: "old", sourceId: "old" } });
      await app.attachWorkspaceDraft("draft");
      expect(app.composition.canUndo()).toBe(false);
      expect(await app.applyHistoryAction("undo")).toBe(false);
      expect(await app.prepareWorkspaceTurn()).toEqual({ draftId: "draft", generation: 2, packageKey: "map" });
      app.session = fixtureSession();
      expect(await app.prepareWorkspaceTurn()).toBeUndefined();
      expect(app.composition.canUndo()).toBe(false);
    } finally {
      get.mockRestore();
    }
  });

  it("creates a server map only through the explicit human action and observes its actual identity", async () => {
    const draft = {
      draftId: "created",
      generation: 0,
      packageKey: "new-map",
      envelope: {
        family: "map",
        schemaVersion: "1.0",
        format: "honua_map_package.v1",
        body: { layers: [] },
      },
    } as Awaited<ReturnType<StudioLifecycleClient["getDraft"]>>;
    const create = vi.spyOn(StudioLifecycleClient.prototype, "createDraft").mockResolvedValue(draft);
    const get = vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockResolvedValue(draft);
    try {
      const app = mount();
      expect(create).not.toHaveBeenCalled();
      await expect(app.createWorkspaceDraft("bad key")).rejects.toThrow("package key");
      const identity = await app.createWorkspaceDraft("new-map");
      expect(identity).toEqual({ draftId: "created", generation: 0, packageKey: "new-map" });
      expect(create.mock.calls[0]?.[0].envelope.body).toMatchObject({ mapPackageId: "new-map", layers: [] });
      expect(get).toHaveBeenCalledWith("created");
      expect(app.composition.canUndo()).toBe(false);
    } finally {
      create.mockRestore();
      get.mockRestore();
    }
  });

  it("ignores an old in-flight draft observation after a session swap", async () => {
    let resolve!: (value: Awaited<ReturnType<StudioLifecycleClient["getDraft"]>>) => void;
    const get = vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    try {
      const app = mount();
      const pending = app.attachWorkspaceDraft("old");
      await vi.waitFor(() => expect(get).toHaveBeenCalled());
      app.session = fixtureSession();
      resolve({ draftId: "old", generation: 0, packageKey: "old", envelope: { body: { layers: [] } } } as Awaited<
        ReturnType<StudioLifecycleClient["getDraft"]>
      >);
      await expect(pending).rejects.toThrow("session changed");
      expect(await app.prepareWorkspaceTurn()).toBeUndefined();
    } finally {
      get.mockRestore();
    }
  });

  it("pins a New map gesture before waiting for pending writes", async () => {
    const app = mount();
    let release!: () => void;
    const prepare = vi.spyOn(app, "prepareWorkspaceTurn").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    const create = vi.spyOn(StudioLifecycleClient.prototype, "createDraft");
    try {
      const pending = app.createWorkspaceDraft("new-map");
      app.session = fixtureSession();
      release();
      await expect(pending).rejects.toThrow("session changed");
      expect(create).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      create.mockRestore();
    }
  });

  it("does not discard a form edited during GET or advance the active draft generation", async () => {
    const draft = {
      draftId: "shared",
      generation: 1,
      packageKey: "map",
      envelope: { body: { layers: [] } },
    } as Awaited<ReturnType<StudioLifecycleClient["getDraft"]>>;
    const get = vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockResolvedValue(draft);
    try {
      const app = mount();
      await app.attachWorkspaceDraft("shared");
      let resolve!: (value: typeof draft) => void;
      get.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const pending = app.attachWorkspaceDraft("shared");
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
      const field = document.createElement("textarea");
      field.value = "unsaved edit";
      app.appendChild(field);
      resolve({ ...draft, generation: 2 });
      await expect(pending).rejects.toThrow("pending Studio edits");
      expect(field.value).toBe("unsaved edit");
      field.remove();
      expect((await app.prepareWorkspaceTurn())?.generation).toBe(1);
    } finally {
      get.mockRestore();
    }
  });

  it("does not detach a host-owned agent session on view disconnect", () => {
    const app = mount();
    app.agentSessionAdapter = {
      submitTurn: async () => {
        throw new Error("unused");
      },
    };
    const chat = app.querySelector("honua-studio-chat")!;
    const detach = vi.spyOn(chat as unknown as { detachAgentSession(): void }, "detachAgentSession");
    app.remove();
    expect(detach).not.toHaveBeenCalled();
  });

  it("does not announce an authority swap on first pre-connect session assignment", () => {
    const app = document.createElement("honua-studio-app") as HonuaStudioAppElement;
    const listener = vi.fn();
    app.addEventListener("honua-workspace-draft-change", listener);
    app.session = fixtureSession();
    expect(listener).not.toHaveBeenCalled();
    app.session = fixtureSession();
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]![0] as CustomEvent).detail).toBeNull();
  });

  it("prepares host turns without fetching or discarding unsaved authoring fields", async () => {
    const app = mount();
    await expect(app.prepareWorkspaceTurn()).resolves.toBeUndefined();
    const pending = document.createElement("textarea");
    pending.value = "unsaved authoring value";
    app.appendChild(pending);
    await expect(app.prepareWorkspaceTurn()).rejects.toThrow("pending Studio edits");
    expect(pending.value).toBe("unsaved authoring value");
    expect(await app.refreshWorkspaceDraft()).toBe(false);
    pending.remove();
    const chat = app.querySelector("honua-studio-chat");
    const composer = chat?.shadowRoot?.querySelector("textarea");
    if (composer) composer.value = "user-authored pending prompt";
    await expect(app.prepareWorkspaceTurn()).resolves.toBeUndefined();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("package-drafts"))).toBe(false);
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

  describe("auth integration (honua-studio#4/#5 reconciliation)", () => {
    it("host-adapter mode (.session set): renders a status label but NO sign-in/out controls (REQ-003)", async () => {
      const app = mount(); // mount() injects a fixture SessionAdapter — host-adapter mode.
      // The fixture's fake token resolves synchronously-ish; flush microtasks.
      await Promise.resolve();
      await Promise.resolve();
      expect(app.auth.mode).toBe("host-adapter");
      expect(app.shadowRoot?.querySelector('[data-testid="auth-signin"]')).toBeNull();
      expect(app.shadowRoot?.querySelector('[data-testid="auth-signout"]')).toBeNull();
      const status = app.shadowRoot?.querySelector('[data-testid="auth-status"]');
      expect(status?.textContent).toBe("Signed in");
    });

    it("standalone mode (no .session, no window host adapter): renders sign-in/out controls", () => {
      // A resolving (not rejecting) discovery fetch — OidcAuthSession's own
      // discovery/refresh flow is honua-studio#4's to test
      // (test/auth/oidc-session.test.ts); this only needs `auth.mode` to
      // read "standalone" synchronously, which doesn't require discovery to
      // actually finish.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({
            authorization_endpoint: "https://issuer.example/authorize",
            token_endpoint: "https://issuer.example/token",
          }),
        })),
      );
      const app = document.createElement("honua-studio-app") as HonuaStudioAppElement;
      document.body.appendChild(app);

      expect(app.auth.mode).toBe("standalone");
      expect(app.shadowRoot?.querySelector('[data-testid="auth-signin"]')).not.toBeNull();
      expect(app.shadowRoot?.querySelector('[data-testid="auth-signout"]')).not.toBeNull();
      expect(app.shadowRoot?.querySelector('[data-testid="auth-status"]')?.textContent).toBe("Signed out");
    });

    it(".session assigned after connection tears down and rebuilds .auth", async () => {
      const app = document.createElement("honua-studio-app") as HonuaStudioAppElement;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({
            authorization_endpoint: "https://issuer.example/authorize",
            token_endpoint: "https://issuer.example/token",
          }),
        })),
      );
      document.body.appendChild(app);
      expect(app.auth.mode).toBe("standalone");

      app.session = fixtureSession();
      await Promise.resolve();
      await Promise.resolve();
      expect(app.auth.mode).toBe("host-adapter");
      // Standalone's sign-in/out controls are gone now that the shell knows it's embedded.
      expect(app.shadowRoot?.querySelector('[data-testid="auth-signin"]')).toBeNull();
    });
  });
});
