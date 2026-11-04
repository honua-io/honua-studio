// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioAppElement } from "../../src/elements/studio-app-element.js";
import type { HonuaStudioCanvasElement } from "../../src/elements/studio-canvas-element.js";
import { StudioLifecycleClient } from "../../src/lifecycle/lifecycle-client.js";

registerAllStudioElements();

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
      view: { bbox: [-158, 21, -157, 22] },
      title: "Preserved title",
    },
  },
} as Awaited<ReturnType<StudioLifecycleClient["getDraft"]>>;
const camera = { center: [-157.85, 21.31] as const, zoom: 11, bearing: 325, pitch: 45 };

let app: HonuaStudioAppElement;
let save: ReturnType<typeof vi.spyOn<StudioLifecycleClient, "saveAsVersion">>;
let replace: ReturnType<typeof vi.spyOn<StudioLifecycleClient, "replaceDraft">>;

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
  await app.attachWorkspaceDraft("original");
  const canvas = app.querySelector("honua-studio-canvas") as HonuaStudioCanvasElement;
  vi.spyOn(canvas, "mapView", "get").mockReturnValue({ camera: () => camera } as never);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("workspace saved camera", () => {
  it("persists the camera before the immutable version and drops the old bbox", async () => {
    await app.saveWorkspaceVersion();
    expect(replace).toHaveBeenCalledOnce();
    expect(replace.mock.calls[0]?.[1]).toMatchObject({
      generation: 1,
      envelope: { body: { view: camera, title: "Preserved title" } },
    });
    expect((replace.mock.calls[0]?.[1].envelope.body as { view: unknown }).view).toEqual(camera);
    expect(replace.mock.invocationCallOrder[0]).toBeLessThan(save.mock.invocationCallOrder[0]!);
    expect(app.composition.state.view).toEqual(camera);
    expect(await app.prepareWorkspaceTurn()).toMatchObject({ generation: 2 });
  });

  it("keeps an authored view when there is no rendered camera", async () => {
    const canvas = app.querySelector("honua-studio-canvas") as HonuaStudioCanvasElement;
    vi.spyOn(canvas, "mapView", "get").mockReturnValue(undefined);
    await app.saveWorkspaceVersion();
    expect(replace).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
    expect(app.composition.state.view).toEqual(initialDraft.envelope.body.view);
  });

  it("does not create a version after a rejected camera write", async () => {
    replace.mockRejectedValue(new Error("generation conflict"));
    await expect(app.saveWorkspaceVersion()).rejects.toThrow("generation conflict");
    expect(save).not.toHaveBeenCalled();
    expect(app.composition.state.view).toEqual(initialDraft.envelope.body.view);
    await expect(app.saveWorkspaceVersion()).rejects.toThrow("pending");
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
    const pending = app.saveWorkspaceVersion();
    const rejected = expect(pending).rejects.toThrow("session or map changed");
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce());
    app.session = { getToken: async () => "replacement-token", onExpired: () => () => {} };
    finish({ ...initialDraft, generation: 2 });
    await rejected;
    expect(save).not.toHaveBeenCalled();
    expect(app.composition.state.view).toEqual({});
  });
});
