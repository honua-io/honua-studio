// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioAppElement } from "../../src/elements/studio-app-element.js";
import type { HonuaStudioCanvasElement } from "../../src/elements/studio-canvas-element.js";
import type { SessionAdapter } from "../../src/elements/types.js";
import { StudioLifecycleClient } from "../../src/lifecycle/lifecycle-client.js";

registerAllStudioElements();

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

function styleFor(color: string) {
  return {
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": color } }],
  };
}

function draftEnvelope(draftId: string, mapSpec: ReturnType<typeof styleFor>) {
  return {
    draftId,
    itemId: "item",
    generation: 1,
    packageKey: "map",
    envelope: {
      family: "map",
      schemaVersion: "1.0",
      format: "honua_map_package.v1",
      body: { layers: [], mapSpec },
    },
  } as Awaited<ReturnType<StudioLifecycleClient["getDraft"]>>;
}

async function mountedContentApp(): Promise<HonuaStudioAppElement> {
  window.location.hash = "#/content";
  const app = mount();
  app.setAttribute("data-theme-set", "");
  await vi.waitFor(() => expect(app.shadowRoot?.querySelector("honua-studio-lifecycle-panel")?.isConnected).toBe(true));
  return app;
}

async function panelDraft(app: HonuaStudioAppElement, draftId: string): Promise<HTMLElement> {
  let panel: HTMLElement | undefined;
  await vi.waitFor(() => {
    const current = app.shadowRoot?.querySelector("honua-studio-lifecycle-panel");
    expect(current?.isConnected).toBe(true);
    if (current instanceof HTMLElement && current.getAttribute("draft-id") !== draftId)
      (current as HTMLElement & { draftId: string }).draftId = draftId;
    expect(current?.shadowRoot?.querySelector('[data-testid="lifecycle-panel-edit-style"]')).toBeTruthy();
    panel = current as HTMLElement;
  });
  if (!panel) throw new Error("The content route did not keep a lifecycle panel.");
  return panel;
}

function openContentDraft(app: HonuaStudioAppElement, draftId: string): void {
  const browser = app.shadowRoot?.querySelector("honua-studio-content-browser");
  if (!browser) throw new Error("The content route did not mount a browser.");
  browser.dispatchEvent(
    new CustomEvent("honua-studio-open-item", {
      bubbles: true,
      detail: { draftId, itemId: "item", family: "map", packageKey: "map" },
    }),
  );
}

function markStyleDirty(app: HonuaStudioAppElement) {
  const frame = app.shadowRoot?.querySelector("iframe");
  if (!frame) throw new Error("The style editor did not open a frame.");
  const channel = new URLSearchParams(new URL(frame.src).hash.slice(1)).get("channel");
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "null",
      data: { type: "honua:style-input", channel },
    }),
  );
  return frame;
}

describe("style editor follows the lifecycle panel draft", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network disabled in unit tests"))),
    );
  });

  afterEach(() => {
    document.body.innerHTML = "";
    window.location.hash = "";
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("removes a refused host path when current-path was absent, then accepts the retry", async () => {
    const style = styleFor("#ffffff");
    vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockResolvedValue({
      draftId: "shared",
      generation: 1,
      packageKey: "map",
      envelope: { family: "map", schemaVersion: "1.0", body: { layers: [], mapSpec: style } },
    } as Awaited<ReturnType<StudioLifecycleClient["getDraft"]>>);
    const app = mount({ "routing-mode": "host" });
    expect(app.hasAttribute("current-path")).toBe(false);
    await app.attachWorkspaceDraft("shared");
    const canvas = app.querySelector("honua-studio-canvas") as HonuaStudioCanvasElement;
    vi.spyOn(canvas, "editableMapStyle").mockResolvedValue(style);
    await app.openStyleEditor();
    markStyleDirty(app);
    expect(app.hasUnsavedStyleChanges).toBe(true);
    app.setAttribute("current-path", "/about");
    expect(app.hasAttribute("current-path")).toBe(false);
    expect(app.currentPath).toBe("/");
    expect(app.shadowRoot?.querySelector('[data-testid="about-section"]')).toBeFalsy();
    await app.discardStyleChanges();
    expect(app.hasUnsavedStyleChanges).toBe(false);
    app.setAttribute("current-path", "/about");
    expect(app.getAttribute("current-path")).toBe("/about");
    expect(app.currentPath).toBe("/about");
    expect(app.shadowRoot?.querySelector('[data-testid="about-section"]')).toBeTruthy();
  });

  it("reopens a clean style editor against the lifecycle panel draft", async () => {
    const active = { id: "draft-a" };
    const styles = { "draft-a": styleFor("#aaaaaa"), "draft-b": styleFor("#bbbbbb") };
    vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockImplementation(async (draftId: string) =>
      draftEnvelope(draftId, styles[draftId as "draft-a" | "draft-b"]),
    );
    vi.spyOn(StudioLifecycleClient.prototype, "listVersions").mockResolvedValue({ itemId: "item", versions: [] });
    const app = await mountedContentApp();
    await app.attachWorkspaceDraft("draft-a");
    const canvas = app.querySelector("honua-studio-canvas") as HonuaStudioCanvasElement;
    const readStyle = vi
      .spyOn(canvas, "editableMapStyle")
      .mockImplementation(async () => styles[active.id as "draft-a"]);
    await app.openStyleEditor();
    const firstFrame = app.shadowRoot?.querySelector("iframe");
    expect(firstFrame).toBeTruthy();
    const attach = app.attachWorkspaceDraft.bind(app);
    const trace: string[] = [];
    vi.spyOn(app, "attachWorkspaceDraft").mockImplementation(async (draftId: string) => {
      trace.push(`attach:${draftId}`);
      await attach(draftId);
      active.id = draftId;
    });
    readStyle.mockImplementation(async () => {
      trace.push(`read:${active.id}`);
      return styles[active.id as "draft-a" | "draft-b"];
    });
    const panel = await panelDraft(app, "draft-b");
    panel.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-panel-edit-style"]')?.click();
    await vi.waitFor(() => expect(trace).toContain("read:draft-b"));
    expect(trace.indexOf("attach:draft-b")).toBeLessThan(trace.indexOf("read:draft-b"));
    const nextFrame = app.shadowRoot?.querySelector("iframe");
    expect(nextFrame).toBeTruthy();
    expect(nextFrame).not.toBe(firstFrame);
    expect(nextFrame?.isConnected).toBe(true);
  });

  it("closes a clean style editor before the content list opens another draft", async () => {
    vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockImplementation(async (draftId: string) =>
      draftEnvelope(draftId, styleFor("#aaaaaa")),
    );
    vi.spyOn(StudioLifecycleClient.prototype, "listVersions").mockResolvedValue({ itemId: "item", versions: [] });
    const app = await mountedContentApp();
    await app.attachWorkspaceDraft("draft-a");
    const canvas = app.querySelector("honua-studio-canvas") as HonuaStudioCanvasElement;
    vi.spyOn(canvas, "editableMapStyle").mockResolvedValue(styleFor("#aaaaaa"));
    openContentDraft(app, "draft-a");
    await panelDraft(app, "draft-a");
    await app.openStyleEditor();
    expect(app.shadowRoot?.querySelector("iframe")?.isConnected).toBe(true);
    app.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="content-route-back"]')?.click();
    expect(app.shadowRoot?.querySelector("iframe")).toBeFalsy();
    openContentDraft(app, "draft-b");
    await vi.waitFor(() =>
      expect(app.shadowRoot?.querySelector("honua-studio-lifecycle-panel")?.getAttribute("draft-id")).toBe("draft-b"),
    );
    expect(app.shadowRoot?.querySelector("iframe")).toBeFalsy();
  });

  it("keeps the open draft when content navigation would leave a dirty style editor", async () => {
    vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockImplementation(async (draftId: string) =>
      draftEnvelope(draftId, styleFor("#aaaaaa")),
    );
    vi.spyOn(StudioLifecycleClient.prototype, "listVersions").mockResolvedValue({ itemId: "item", versions: [] });
    const app = await mountedContentApp();
    await app.attachWorkspaceDraft("draft-a");
    const canvas = app.querySelector("honua-studio-canvas") as HonuaStudioCanvasElement;
    vi.spyOn(canvas, "editableMapStyle").mockResolvedValue(styleFor("#aaaaaa"));
    openContentDraft(app, "draft-a");
    await panelDraft(app, "draft-a");
    await app.openStyleEditor();
    const frame = markStyleDirty(app);
    expect(app.hasUnsavedStyleChanges).toBe(true);
    openContentDraft(app, "draft-a");
    const revealed = app.shadowRoot?.querySelector<HTMLElement>('[data-testid="content-route-panel"]');
    expect(revealed?.hidden).toBe(false);
    app.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="content-route-back"]')?.click();
    const panelSlot = app.shadowRoot?.querySelector<HTMLElement>('[data-testid="content-route-panel"]');
    expect(panelSlot?.hidden).toBe(false);
    expect(frame.isConnected).toBe(true);
    expect(app.shadowRoot?.querySelector("honua-studio-lifecycle-panel")?.getAttribute("draft-id")).toBe("draft-a");
    openContentDraft(app, "draft-b");
    expect(app.shadowRoot?.querySelector("honua-studio-lifecycle-panel")?.getAttribute("draft-id")).toBe("draft-a");
    expect(frame.isConnected).toBe(true);
    expect(app.shadowRoot?.querySelector("[aria-label='Map style editor'] [role='status']")?.textContent).toContain(
      "Save or discard visual style edits before leaving.",
    );
  });

  it("keeps a dirty style editor when the lifecycle panel names another draft", async () => {
    vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockImplementation(async (draftId: string) =>
      draftEnvelope(draftId, styleFor("#aaaaaa")),
    );
    vi.spyOn(StudioLifecycleClient.prototype, "listVersions").mockResolvedValue({ itemId: "item", versions: [] });
    const app = await mountedContentApp();
    await app.attachWorkspaceDraft("draft-a");
    const canvas = app.querySelector("honua-studio-canvas") as HonuaStudioCanvasElement;
    vi.spyOn(canvas, "editableMapStyle").mockResolvedValue(styleFor("#aaaaaa"));
    await app.openStyleEditor();
    const frame = markStyleDirty(app);
    expect(app.hasUnsavedStyleChanges).toBe(true);
    const panel = await panelDraft(app, "draft-b");
    panel.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-panel-edit-style"]')?.click();
    await vi.waitFor(() =>
      expect(app.shadowRoot?.querySelector("[aria-label='Map style editor'] [role='status']")?.textContent).toContain(
        "Save pending Studio edits",
      ),
    );
    expect(app.hasUnsavedStyleChanges).toBe(true);
    expect(frame.isConnected).toBe(true);
  });
});
