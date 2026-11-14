// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioAppElement } from "../../src/elements/studio-app-element.js";
import { StudioLifecycleClient } from "../../src/lifecycle/lifecycle-client.js";
import { StudioLifecycleError } from "../../src/lifecycle/lifecycle-errors.js";

registerAllStudioElements();

function mount(): HonuaStudioAppElement {
  const app = document.createElement("honua-studio-app") as HonuaStudioAppElement;
  app.session = { getToken: async () => "fixture-token", onExpired: () => () => {} };
  document.body.appendChild(app);
  return app;
}

describe("host draft approval and attachment", () => {
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
  });
  it("checks the host attachment guard before queued reads and before adopting their results", async () => {
    const app = mount();
    const draft = {
      draftId: "first",
      generation: 0,
      packageKey: "map",
      envelope: {
        family: "map",
        schemaVersion: "1.0",
        format: "honua_map_package.v1",
        body: { layers: [] },
      },
    } as Awaited<ReturnType<StudioLifecycleClient["getDraft"]>>;
    let finish!: () => void;
    const get = vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(draft);
        }),
    );
    let current = true;
    const guard = () => {
      if (!current) throw new Error("Host navigated");
    };
    try {
      const first = app.attachEditorDraft("first", guard);
      await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
      const queued = app.attachEditorDraft("second", guard);
      const firstRefused = expect(first).rejects.toThrow("Host navigated");
      const queuedRefused = expect(queued).rejects.toThrow("Host navigated");
      current = false;
      finish();
      await Promise.all([firstRefused, queuedRefused]);
      expect(get).toHaveBeenCalledTimes(1);
      await expect(app.prepareEditorTurn()).resolves.toBeUndefined();
    } finally {
      get.mockRestore();
    }
  });

  it.each(["prepare", "attach"])("does not mark a %s failure as a rejected creation", async (phase) => {
    const app = mount();
    const error = new StudioLifecycleError("validation", "Read refused", { status: 400 });
    const prepare = vi.spyOn(app, "prepareEditorTurn");
    const attach = vi.spyOn(app, "attachEditorDraft").mockRejectedValue(error);
    const create = vi.spyOn(StudioLifecycleClient.prototype, "createDraftWithApproval").mockResolvedValue({
      draftId: "already-created",
    } as Awaited<ReturnType<StudioLifecycleClient["createDraft"]>>);
    if (phase === "prepare") prepare.mockRejectedValue(error);
    else prepare.mockResolvedValue(undefined);
    try {
      await expect(app.createEditorDraft("map", "command")).rejects.toBe(error);
      expect(error.createDraftRejected).not.toBe(true);
      expect(create).toHaveBeenCalledTimes(phase === "prepare" ? 0 : 1);
      expect(attach).toHaveBeenCalledTimes(phase === "prepare" ? 0 : 1);
    } finally {
      prepare.mockRestore();
      attach.mockRestore();
      create.mockRestore();
    }
  });

  it("returns a pending draft approval without attaching it as a map", async () => {
    const receipt = { status: "awaiting-approval" as const, operationInstanceId: "operation", proposalId: "proposal" };
    const create = vi.spyOn(StudioLifecycleClient.prototype, "createDraftWithApproval").mockResolvedValue(receipt);
    const get = vi.spyOn(StudioLifecycleClient.prototype, "getDraft");
    try {
      const app = mount();
      expect(await app.createEditorDraft("approval-map", "original-command")).toEqual(receipt);
      expect(create.mock.calls[0]?.[1]).toBe("original-command");
      expect(get).not.toHaveBeenCalled();
    } finally {
      create.mockRestore();
      get.mockRestore();
    }
  });
});
