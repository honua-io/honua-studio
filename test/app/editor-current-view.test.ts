// @vitest-environment happy-dom
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCompositionCommand } from "../../src/composition/reducer.js";
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioAppElement } from "../../src/elements/studio-app-element.js";
import type { HonuaStudioCanvasElement } from "../../src/elements/studio-canvas-element.js";
import type { HonuaStudioChatElement } from "../../src/elements/studio-chat-element.js";
import { StudioLifecycleClient } from "../../src/lifecycle/lifecycle-client.js";
import { StudioLifecycleApprovalPendingError } from "../../src/lifecycle/lifecycle-errors.js";

registerAllStudioElements();

const authoredView = { bbox: [-158, 21, -157, 22] };
const initialDraft = {
  draftId: "original",
  itemId: "item",
  generation: 1,
  packageKey: "saved-map",
  envelope: {
    family: "map",
    schemaVersion: "1.0",
    format: "honua_map_package.v1",
    body: {
      layers: [],
      view: authoredView,
      title: "Preserved title",
    },
  },
} as Awaited<ReturnType<StudioLifecycleClient["getDraft"]>>;
const camera = { center: [-157.85, 21.31] as const, zoom: 11, bearing: 325, pitch: 45 };
type Camera = { center: readonly [number, number]; zoom: number; bearing: number; pitch: number };
let currentCamera: Camera = camera;

let app: HonuaStudioAppElement;
let save: MockInstance<StudioLifecycleClient["saveAsVersion"]>;
let replace: MockInstance<StudioLifecycleClient["replaceDraft"]>;

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled")));
  vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockResolvedValue(initialDraft);
  save = vi.spyOn(StudioLifecycleClient.prototype, "saveAsVersion").mockResolvedValue({ versionId: "saved" } as never);
  replace = vi.spyOn(StudioLifecycleClient.prototype, "replaceDraft").mockImplementation(async (_, request) => ({
    ...initialDraft,
    ...request,
    generation: 2,
  }));
  app = document.createElement("honua-studio-app") as HonuaStudioAppElement;
  app.session = { getToken: async () => "fixture-token", onExpired: () => () => {} };
  document.body.appendChild(app);
  await app.attachEditorDraft("original");
  const canvas = app.querySelector("honua-studio-canvas") as HonuaStudioCanvasElement;
  vi.spyOn(canvas, "mapView", "get").mockReturnValue({
    camera: () => currentCamera,
    settleAuthoredView: async () => {},
  } as never);
});

afterEach(() => {
  currentCamera = camera;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("workspace saved camera", () => {
  it("persists the camera before the immutable version and drops the old bbox", async () => {
    const before = app.composition.state;
    await app.saveEditorVersion();
    expect(replace).toHaveBeenCalledOnce();
    expect(replace.mock.calls[0]?.[1]).toMatchObject({
      generation: 1,
      envelope: { body: { view: camera, title: "Preserved title" } },
    });
    expect((replace.mock.calls[0]?.[1].envelope.body as { view: unknown }).view).toEqual(camera);
    expect(replace.mock.invocationCallOrder[0]).toBeLessThan(save.mock.invocationCallOrder[0]!);
    expect(app.composition.state.view).toEqual(camera);
    expect(app.composition.history.revisions().some((revision) => revision.command?.name === "setView")).toBe(true);
    const chat = app.querySelector("honua-studio-chat") as HonuaStudioChatElement;
    expect(chat.activityLog.entries()).toContainEqual(
      expect.objectContaining({
        type: "composition_command_applied",
        detail: expect.objectContaining({ commandInput: { name: "setView", view: camera }, generation: 2 }),
      }),
    );
    const commands = chat.activityLog.entries().filter((entry) => entry.type === "composition_command_applied");
    expect(commands).toHaveLength(1);
    const accepted = commands[0];
    expect(applyCompositionCommand(before, accepted!.detail.commandInput).state.view).toEqual(camera);
    expect(await app.prepareEditorTurn()).toMatchObject({ generation: 2 });
  });

  it("sends the generation the version save advanced on the next save", async () => {
    let generation = 1;
    let body = initialDraft.envelope.body;
    vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockImplementation(async () => ({
      ...initialDraft,
      generation,
      envelope: { ...initialDraft.envelope, body },
    }));
    replace.mockImplementation(async (_draftId, request) => {
      expect(request.generation).toBe(generation);
      generation += 1;
      body = request.envelope.body;
      return { ...initialDraft, ...request, generation };
    });
    save.mockImplementation(async () => {
      generation += 1;
      return { versionId: `saved-${generation}` } as never;
    });

    await app.saveEditorVersion();
    expect(replace.mock.calls.map((call) => call[1].generation)).toEqual([1]);
    currentCamera = { ...camera, zoom: 12 };
    await app.saveEditorVersion();
    expect(replace.mock.calls.map((call) => call[1].generation)).toEqual([1, 3]);
    expect(app.composition.state.view).toEqual(currentCamera);
    expect(await app.prepareEditorTurn()).toMatchObject({ generation: 5 });
  });

  it("saves the version without a draft write when the camera has not moved", async () => {
    await app.saveEditorVersion();
    expect(replace).toHaveBeenCalledOnce();

    // A reloaded map reads its camera back with float noise; that is still the stored view.
    currentCamera = { ...camera, center: [camera.center[0] + 1e-9, camera.center[1]], zoom: camera.zoom - 1e-9 };
    await app.saveEditorVersion();

    expect(replace).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("writes a view changed only locally, such as a bookmark, before saving the version", async () => {
    await app.saveEditorVersion();
    expect(replace).toHaveBeenCalledOnce();

    const bookmark = { center: [-157.8, 21.3] as const, zoom: 13, bearing: 0, pitch: 0 };
    app.composition.apply({ name: "setView", view: bookmark });
    currentCamera = bookmark;
    await app.saveEditorVersion();

    expect(replace).toHaveBeenCalledTimes(2);
    expect((replace.mock.calls[1]?.[1].envelope.body as { view: unknown }).view).toEqual(bookmark);
  });

  it("asks for one approval for the saved view, then saves without another proposal", async () => {
    const held = { status: "awaiting-approval", operationInstanceId: "operation-1", proposalId: "proposal-1" } as const;
    replace.mockRejectedValueOnce(new StudioLifecycleApprovalPendingError(held));

    await expect(app.saveEditorVersion()).rejects.toThrow(/proposal-1/);
    expect(save).not.toHaveBeenCalled();

    // The person approves the held view in the Inbox; reloading reads the draft it produced.
    const sent = replace.mock.calls[0]?.[1];
    vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockResolvedValue({
      ...initialDraft,
      generation: 2,
      envelope: sent!.envelope,
    } as never);
    // Reloading at a newer generation ends the hold, as Check approval and reload map does.
    await app.attachEditorDraft("original");
    replace.mockClear();

    await expect(app.saveEditorVersion()).resolves.toMatchObject({ versionId: "saved" });
    expect(replace).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
  });

  it("blocks the next edit when the version refresh belongs to another draft", async () => {
    vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockResolvedValue({
      ...initialDraft,
      draftId: "someone-else",
      generation: 9,
    });
    await expect(app.saveEditorVersion()).resolves.toMatchObject({ versionId: "saved" });
    await expect(app.saveEditorVersion()).rejects.toThrow(/pending|reload/i);
    expect(save).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledOnce();
  });

  it("blocks the next edit when the version refresh shows someone else's map", async () => {
    vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockResolvedValue({
      ...initialDraft,
      generation: 9,
      envelope: {
        ...initialDraft.envelope,
        body: { layers: [{ id: "other", sourceId: "src", visible: true }], view: {} },
      },
    });
    await expect(app.saveEditorVersion()).resolves.toMatchObject({ versionId: "saved" });
    await expect(app.prepareEditorTurn()).rejects.toThrow(/pending|reload/i);
    await expect(app.saveEditorVersion()).rejects.toThrow(/pending|reload/i);
    expect(replace).toHaveBeenCalledOnce();
  });

  it("keeps a saved version when the generation refresh fails", async () => {
    vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockRejectedValue(new Error("refresh failed"));
    await expect(app.saveEditorVersion()).resolves.toMatchObject({ versionId: "saved" });
    await expect(app.saveEditorVersion()).rejects.toThrow(/pending|reload/i);
    expect(save).toHaveBeenCalledOnce();
  });

  it("does not adopt a generation refresh after the session changes", async () => {
    let finish!: (draft: typeof initialDraft) => void;
    vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = app.saveEditorVersion();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    app.session = { getToken: async () => "replacement-token", onExpired: () => () => {} };
    finish({ ...initialDraft, generation: 9 });
    await expect(pending).resolves.toMatchObject({ versionId: "saved" });
    await expect(app.prepareEditorTurn()).resolves.toBeUndefined();
  });

  it("waits for the rendered authored view before reading the camera", async () => {
    let finish!: () => void;
    const settling = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const readCamera = vi.fn(() => camera);
    const canvas = app.querySelector("honua-studio-canvas") as HonuaStudioCanvasElement;
    const settle = vi.fn(() => settling);
    vi.spyOn(canvas, "mapView", "get").mockReturnValue({ camera: readCamera, settleAuthoredView: settle } as never);
    const pending = app.saveEditorVersion();
    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce());
    expect(readCamera).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(readCamera).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });

  it("does not capture the camera when its session changes while rendering settles", async () => {
    let finish!: () => void;
    const settling = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const canvas = app.querySelector("honua-studio-canvas") as HonuaStudioCanvasElement;
    const settle = vi.fn(() => settling);
    vi.spyOn(canvas, "mapView", "get").mockReturnValue({ camera: () => camera, settleAuthoredView: settle } as never);
    const pending = app.saveEditorVersion();
    const rejected = expect(pending).rejects.toThrow(/session.*changed/);
    await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce());
    app.session = { getToken: async () => "replacement-token", onExpired: () => () => {} };
    finish();
    await rejected;
    expect(replace).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps an authored view when there is no rendered camera", async () => {
    const canvas = app.querySelector("honua-studio-canvas") as HonuaStudioCanvasElement;
    vi.spyOn(canvas, "mapView", "get").mockReturnValue(undefined);
    await app.saveEditorVersion();
    expect(replace).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
    expect(app.composition.state.view).toEqual(authoredView);
  });

  it("does not create a version after a rejected camera write", async () => {
    replace.mockRejectedValue(new Error("generation conflict"));
    await expect(app.saveEditorVersion()).rejects.toThrow("generation conflict");
    expect(save).not.toHaveBeenCalled();
    expect(app.composition.state.view).toEqual(authoredView);
    await expect(app.saveEditorVersion()).rejects.toThrow("pending");
    expect(replace).toHaveBeenCalledOnce();
  });

  it("does not adopt a camera write or save a version after the session changes", async () => {
    let finish!: (draft: typeof initialDraft) => void;
    replace.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = app.saveEditorVersion();
    const rejected = expect(pending).rejects.toThrow(/session.*changed/);
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
    app.session = { getToken: async () => "replacement-token", onExpired: () => () => {} };
    finish({ ...initialDraft, generation: 2 });
    await rejected;
    expect(save).not.toHaveBeenCalled();
    expect(app.composition.state.view).toEqual({});
  });
});

function manualElementForm() {
  app.shadowRoot!.querySelector<HTMLButtonElement>('[data-testid="manual-elements-toggle"]')!.click();
  return app.shadowRoot!.querySelector<HTMLFormElement>("#manual-elements-panel form")!;
}

it("keeps manual element forms editable after refreshing the same draft", async () => {
  const form = manualElementForm();
  await app.attachEditorDraft("original");
  const kind = form.querySelector<HTMLSelectElement>('[name="kind"]')!;
  kind.value = "legend";
  kind.dispatchEvent(new Event("change", { bubbles: true }));
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(app.composition.state.widgets[0]?.kind).toBe("legend"));
});

it("preserves unsaved manual input when a different draft attach is refused", async () => {
  const form = manualElementForm();
  const title = form.querySelector<HTMLInputElement>('[name="title"]')!;
  title.value = "Unsaved chart";
  title.dispatchEvent(new Event("input", { bubbles: true }));
  await expect(app.attachEditorDraft("other")).rejects.toThrow("Save pending Studio edits");
  expect(form.isConnected).toBe(true);
  expect(title.value).toBe("Unsaved chart");
  expect(app.shadowRoot!.querySelector("#manual-elements-panel form")).toBe(form);
  expect(replace).not.toHaveBeenCalled();
});
