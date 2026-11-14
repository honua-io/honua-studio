// @vitest-environment happy-dom
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCompositionCommand } from "../../src/composition/reducer.js";
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioAppElement } from "../../src/elements/studio-app-element.js";
import type { HonuaStudioCanvasElement } from "../../src/elements/studio-canvas-element.js";
import type { HonuaStudioChatElement } from "../../src/elements/studio-chat-element.js";
import { StudioLifecycleClient } from "../../src/lifecycle/lifecycle-client.js";

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
    camera: () => camera,
    settleAuthoredView: async () => {},
  } as never);
});

afterEach(() => {
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
    const accepted = chat.activityLog.entries().find((entry) => entry.type === "composition_command_applied");
    expect(applyCompositionCommand(before, accepted!.detail.commandInput).state.view).toEqual(camera);
    expect(await app.prepareEditorTurn()).toMatchObject({ generation: 2 });
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
