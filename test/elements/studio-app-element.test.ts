// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioAppElement } from "../../src/elements/studio-app-element.js";
import type { HonuaStudioCanvasElement } from "../../src/elements/studio-canvas-element.js";
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

  it.each(["command", "undo"] as const)(
    "keeps an accepted %s coherent across same-principal cookie renewal",
    async (mode) => {
      const draft = {
        draftId: "shared",
        generation: 1,
        packageKey: "map",
        envelope: {
          family: "map",
          schemaVersion: "1.0",
          format: "honua_map_package.v1",
          body: { mapPackageId: "map", layers: [] },
        },
      } as Awaited<ReturnType<StudioLifecycleClient["getDraft"]>>;
      const get = vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockResolvedValue(draft);
      let finish!: () => void;
      const replace = vi
        .spyOn(StudioLifecycleClient.prototype, "replaceDraft")
        .mockImplementation(async (_id, request) => ({ ...draft, generation: 3, envelope: request.envelope }))
        .mockImplementationOnce(
          (_id, request) =>
            new Promise((resolve) => {
              finish = () => resolve({ ...draft, generation: 2, envelope: request.envelope });
            }),
        );
      try {
        const app = document.createElement("honua-studio-app") as HonuaStudioAppElement;
        const cookie = {
          kind: "cookie" as const,
          baseUrl: "/api/studio",
          environmentId: "server",
          principalId: "opaque-owner",
          csrfToken: "old",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          onExpired: () => () => {},
        };
        app.session = cookie;
        document.body.appendChild(app);
        await app.attachWorkspaceDraft("shared");
        const dispatch = (app.querySelector("honua-studio-canvas") as HonuaStudioCanvasElement).commandDispatch!;
        if (mode === "undo") app.composition.apply({ name: "addLayer", layer: { id: "human", sourceId: "source" } });
        const pending =
          mode === "command"
            ? dispatch([{ name: "addLayer", layer: { id: "human", sourceId: "source" } }]).then((outcome) => outcome.ok)
            : app.applyHistoryAction("undo");
        await vi.waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
        app.session = { ...cookie, csrfToken: "renewed", expiresAt: new Date(Date.now() + 120000).toISOString() };
        finish();
        expect(await pending).toBe(true);
        const accepted = mode === "command" ? ["human"] : [];
        expect(app.composition.state.layers.map((layer) => layer.id)).toEqual(accepted);
        expect(await app.prepareWorkspaceTurn()).toEqual({ draftId: "shared", generation: 2, packageKey: "map" });
        expect((await dispatch([{ name: "addLayer", layer: { id: "next", sourceId: "source" } }])).ok).toBe(true);
        const next = replace.mock.calls[1]![1];
        expect(next.generation).toBe(2);
        expect((next.envelope.body as { layers: { id: string }[] }).layers.map((layer) => layer.id)).toEqual([
          ...accepted,
          "next",
        ]);
      } finally {
        get.mockRestore();
        replace.mockRestore();
      }
    },
  );

  it("uses the renewed cookie transport when a prospective draft GET spans lease renewal", async () => {
    const draft = {
      draftId: "shared",
      generation: 1,
      packageKey: "map",
      envelope: {
        family: "map",
        schemaVersion: "1.0",
        format: "honua_map_package.v1",
        body: { mapPackageId: "map", layers: [] },
      },
    } as Awaited<ReturnType<StudioLifecycleClient["getDraft"]>>;
    let finish!: () => void;
    const get = vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(draft);
        }),
    );
    const writes: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        if (init?.method !== "PUT") throw new Error("Unrelated network disabled.");
        writes.push(init);
        const request = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ success: true, data: { ...draft, generation: 2, envelope: request.envelope } }),
        );
      }),
    );
    try {
      const app = document.createElement("honua-studio-app") as HonuaStudioAppElement;
      const cookie = {
        kind: "cookie" as const,
        baseUrl: "/api/studio",
        environmentId: "server",
        principalId: "opaque-owner",
        csrfToken: "old",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        onExpired: () => () => {},
      };
      app.session = cookie;
      document.body.appendChild(app);
      const pending = app.attachWorkspaceDraft("shared");
      await vi.waitFor(() => expect(get).toHaveBeenCalled());
      app.session = { ...cookie, csrfToken: "renewed", expiresAt: new Date(Date.now() + 120000).toISOString() };
      finish();
      await pending;
      const dispatch = (app.querySelector("honua-studio-canvas") as HonuaStudioCanvasElement).commandDispatch!;
      expect((await dispatch([{ name: "addLayer", layer: { id: "next", sourceId: "source" } }])).ok).toBe(true);
      expect(writes).toHaveLength(1);
      expect(new Headers(writes[0]!.headers).get("X-CSRF-Token")).toBe("renewed");
      expect(await app.prepareWorkspaceTurn()).toEqual({ draftId: "shared", generation: 2, packageKey: "map" });
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

  it("returns false from idle refresh when a form becomes dirty during GET", async () => {
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
      const pending = app.refreshWorkspaceDraft();
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
      const field = document.createElement("textarea");
      field.value = "unsaved refresh edit";
      app.appendChild(field);
      resolve({ ...draft, generation: 2 });
      await expect(pending).resolves.toBe(false);
      expect(field.value).toBe("unsaved refresh edit");
      field.remove();
      expect((await app.prepareWorkspaceTurn())?.generation).toBe(1);
    } finally {
      get.mockRestore();
    }
  });

  it.each(["before", "after"] as const)(
    "hides the standalone composer when the host owns chat %s mounting",
    (timing) => {
      const app = document.createElement("honua-studio-app") as HonuaStudioAppElement;
      app.session = fixtureSession();
      const adapter = {
        submitTurn: async () => {
          throw new Error("unused");
        },
      };
      if (timing === "before") app.agentSessionAdapter = adapter;
      document.body.appendChild(app);
      const slot = app.shadowRoot!.querySelector<HTMLSlotElement>('slot[name="chat"]')!;
      if (timing === "after") {
        expect(slot.hidden).toBe(false);
        app.agentSessionAdapter = adapter;
      }
      expect(slot.hidden).toBe(true);
      const chat = app.querySelector("honua-studio-chat") as unknown as { agentSessionAdapter: unknown };
      expect(chat.agentSessionAdapter).toBe(adapter);
      expect(app.shadowRoot!.querySelector<HTMLSlotElement>('slot[name="canvas"]')!.hidden).toBe(false);
      app.agentSessionAdapter = undefined;
      expect(slot.hidden).toBe(false);
      expect(app.querySelector("honua-studio-chat")).toBe(chat);
    },
  );

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

  it("preserves pending visual field text and blocks history across cookie lease renewal", async () => {
    const style = {
      version: 8,
      sources: {},
      layers: [{ id: "background", type: "background", paint: { "background-color": "#ffffff" } }],
    };
    const get = vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockResolvedValue({
      draftId: "shared",
      generation: 1,
      packageKey: "map",
      envelope: { family: "map", schemaVersion: "1.0", body: { layers: [], mapSpec: style } },
    } as Awaited<ReturnType<StudioLifecycleClient["getDraft"]>>);
    const app = document.createElement("honua-studio-app") as HonuaStudioAppElement;
    const cookie = {
      kind: "cookie" as const,
      baseUrl: "/api/studio",
      environmentId: "server",
      principalId: "owner",
      csrfToken: "old",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    try {
      app.session = cookie;
      document.body.appendChild(app);
      await app.attachWorkspaceDraft("shared");
      const canvas = app.querySelector("honua-studio-canvas") as HonuaStudioCanvasElement;
      const editable = vi.spyOn(canvas, "editableMapStyle").mockResolvedValue(style);
      await app.openStyleEditor();
      const frame = app.shadowRoot!.querySelector("iframe")!;
      const channel = new URLSearchParams(new URL(frame.src).hash.slice(1)).get("channel");
      const raw = frame.contentDocument!.createElement("textarea");
      raw.value = "unaccepted visual expression";
      frame.contentDocument!.body.append(raw);
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "null",
          data: { type: "honua:style-input", channel },
        }),
      );
      expect(app.hasUnsavedStyleChanges).toBe(true);
      app.session = { ...cookie, csrfToken: "renewed", expiresAt: new Date(Date.now() + 120000).toISOString() };
      expect(app.shadowRoot!.querySelector("iframe")).toBe(frame);
      expect(raw.isConnected).toBe(true);
      expect(raw.value).toBe("unaccepted visual expression");
      expect(await app.applyHistoryAction("undo")).toBe(false);
      await expect(app.prepareWorkspaceTurn()).rejects.toThrow("pending Studio edits");
      await expect(app.closeStyleEditor()).rejects.toThrow("Save or discard");
      editable.mockRestore();
    } finally {
      get.mockRestore();
    }
  });

  it("waits for the actual typed style save before capturing a workspace turn", async () => {
    const style = {
      version: 8,
      sources: {},
      layers: [{ id: "background", type: "background", paint: { "background-color": "#ffffff" } }],
    };
    const draft = {
      draftId: "shared",
      generation: 1,
      packageKey: "map",
      itemId: "item",
      family: "map" as const,
      createdAt: "2026-10-17T00:00:00Z",
      updatedAt: "2026-10-17T00:00:00Z",
      envelope: { family: "map" as const, schemaVersion: "1.0", body: { layers: [], mapSpec: style } },
    };
    const get = vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockResolvedValue(draft);
    let finish!: (value: Awaited<ReturnType<StudioLifecycleClient["setMapStyle"]>>) => void;
    const save = vi.spyOn(StudioLifecycleClient.prototype, "setMapStyle").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    try {
      const app = mount();
      await app.attachWorkspaceDraft("shared");
      const canvas = app.querySelector("honua-studio-canvas") as HonuaStudioCanvasElement;
      vi.spyOn(canvas, "editableMapStyle").mockResolvedValue(style);
      await app.openStyleEditor();
      const frame = app.shadowRoot!.querySelector("iframe")!;
      const channel = new URLSearchParams(new URL(frame.src).hash.slice(1)).get("channel");
      const next = structuredClone(style);
      next.layers[0].paint["background-color"] = "#000000";
      vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((message: unknown) => {
        const value = message as { type: string; requestId: string };
        if (value.type === "honua:style-flush")
          queueMicrotask(() =>
            window.dispatchEvent(
              new MessageEvent("message", {
                source: frame.contentWindow,
                origin: "null",
                data: { type: "honua:style-flushed", channel, requestId: value.requestId, settled: true, style: next },
              }),
            ),
          );
      });
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "null",
          data: { type: "honua:style-change", channel, style: next },
        }),
      );
      const button = [...app.shadowRoot!.querySelectorAll("button")].find(
        (item) => item.textContent === "Save map style",
      )!;
      button.click();
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      let captured = false;
      const pending = app.prepareWorkspaceTurn().then((value) => {
        captured = true;
        return value;
      });
      await Promise.resolve();
      expect(captured).toBe(false);
      finish({ ...draft, generation: 2, envelope: { ...draft.envelope, body: { layers: [], mapSpec: next } } });
      expect(await pending).toEqual({ draftId: "shared", generation: 2, packageKey: "map" });
      expect(app.hasUnsavedStyleChanges).toBe(false);
      expect(app.composition.state.mapSpec).toEqual(next);
    } finally {
      get.mockRestore();
      save.mockRestore();
    }
  });

  it("uses only the host product surface when a shared workspace adapter is supplied", () => {
    const app = mount();
    expect(app.hasAttribute("data-workspace-host")).toBe(false);
    app.agentSessionAdapter = {
      async submitTurn() {
        throw new Error("unused");
      },
    };
    expect(app.hasAttribute("data-workspace-host")).toBe(true);
    expect(app.shadowRoot!.querySelector("#view")!.childElementCount).toBe(0);
    expect(app.shadowRoot!.querySelector('[data-testid="history-undo"]')).not.toBeNull();
    expect(app.shadowRoot!.querySelector('[data-testid="history-status"]')).not.toBeNull();
    expect(app.querySelector("honua-studio-canvas")).not.toBeNull();
    app.agentSessionAdapter = undefined;
    expect(app.hasAttribute("data-workspace-host")).toBe(false);
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
