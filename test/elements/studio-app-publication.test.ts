// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioAppElement } from "../../src/elements/studio-app-element.js";
import { StudioLifecycleClient } from "../../src/lifecycle/lifecycle-client.js";
import type { StudioContentVersion, StudioPackageDraft } from "../../src/lifecycle/lifecycle-types.js";

registerAllStudioElements();
const draft = {
  draftId: "draft",
  itemId: "item",
  packageKey: "map",
  generation: 1,
  envelope: { family: "map", schemaVersion: "1.0", format: "honua_map_package.v1", body: { layers: [] } },
} as StudioPackageDraft;
const version = {
  itemId: "item",
  versionId: "version",
  versionNumber: 1,
  contentHash: "sealed-content",
  packageKey: "map",
  envelope: draft.envelope,
  validation: { status: "valid", diagnostics: [] },
  createdAt: "2026-01-01T00:00:00Z",
} as StudioContentVersion;
const input = { intent: { route: "/maps/map", visibility: "organization" } };
const receipt = { status: "awaiting-approval" as const, operationInstanceId: "operation", proposalId: "proposal" };

async function mount() {
  const getDraft = vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockResolvedValue(draft);
  const getVersion = vi.spyOn(StudioLifecycleClient.prototype, "getVersion").mockResolvedValue(version);
  const publish = vi.spyOn(StudioLifecycleClient.prototype, "requestPublish").mockResolvedValue(receipt);
  const app = document.createElement("honua-studio-app") as HonuaStudioAppElement;
  app.session = { getToken: async () => "fixture-token", onExpired: () => () => {} };
  document.body.append(app);
  await app.attachEditorDraft("draft");
  return { app, getDraft, getVersion, publish };
}

describe("embedded workspace publication review", () => {
  beforeEach(() =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network disabled in unit tests");
      }),
    ),
  );
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reviews without mutating and submits the exact version only on an explicit host action", async () => {
    const { app, getVersion, publish } = await mount();
    const review = await app.reviewEditorRelease("version");
    expect(review).toEqual(version);
    expect(Object.isFrozen(review)).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    expect(await app.releaseEditorVersion(review, input, "original-command")).toEqual(receipt);
    expect(getVersion).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledExactlyOnceWith("item", "version", input, "original-command");
  });

  it("refuses forged reviews and versions from another map", async () => {
    const { app, getVersion, publish } = await mount();
    await expect(app.releaseEditorVersion(version, input, "command")).rejects.toThrow("Review the saved version");
    getVersion.mockResolvedValue({ ...version, itemId: "other-item" });
    await expect(app.reviewEditorRelease("version")).rejects.toThrow("does not belong");
    expect(publish).not.toHaveBeenCalled();
  });

  it("reads the bound receipt without submitting or flushing draft edits", async () => {
    const { app, publish } = await mount();
    const saved = {
      requestId: "request",
      itemId: "item",
      versionId: "version",
      status: "accepted" as const,
      createdAt: "2026-01-01T00:00:00Z",
    };
    const read = vi.spyOn(StudioLifecycleClient.prototype, "getPublicationRequest").mockResolvedValue(saved);
    const prepare = vi.spyOn(app, "prepareEditorTurn");
    expect(await app.readEditorRelease("version", "request")).toEqual(saved);
    expect(read).toHaveBeenCalledExactlyOnceWith("item", "version", "request");
    expect(publish).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    await expect(app.readEditorRelease("version", "bad/request")).rejects.toThrow("request IDs are required");
  });

  it.each(["itemId", "versionId", "requestId"] as const)("refuses a receipt with a different %s", async (field) => {
    const { app } = await mount();
    vi.spyOn(StudioLifecycleClient.prototype, "getPublicationRequest").mockResolvedValue({
      requestId: "request",
      itemId: "item",
      versionId: "version",
      status: "accepted",
      createdAt: "2026-01-01T00:00:00Z",
      [field]: "other",
    });
    await expect(app.readEditorRelease("version", "request")).rejects.toThrow("does not belong");
  });

  it("discards a receipt if the session changes during its read", async () => {
    const { app } = await mount();
    vi.spyOn(StudioLifecycleClient.prototype, "getPublicationRequest").mockImplementation(async () => {
      app.session = { getToken: async () => "other-token", onExpired: () => () => {} };
      return {
        requestId: "request",
        itemId: "item",
        versionId: "version",
        status: "accepted",
        createdAt: "2026-01-01T00:00:00Z",
      };
    });
    await expect(app.readEditorRelease("version", "request")).rejects.toThrow("session or map changed");
  });

  it.each(["session", "map"])("invalidates a review after the %s changes", async (change) => {
    const { app, getDraft, publish } = await mount();
    const review = await app.reviewEditorRelease("version");
    if (change === "session") app.session = { getToken: async () => "other-token", onExpired: () => () => {} };
    else {
      getDraft.mockResolvedValue({ ...draft, draftId: "other-draft", itemId: "other-item" });
      await app.attachEditorDraft("other-draft");
    }
    await expect(app.releaseEditorVersion(review, input, "command")).rejects.toThrow("original editor session");
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects changed immutable content before submission", async () => {
    const { app, getVersion, publish } = await mount();
    const review = await app.reviewEditorRelease("version");
    getVersion.mockResolvedValue({ ...version, contentHash: "different-content" });
    await expect(app.releaseEditorVersion(review, input, "command")).rejects.toThrow(
      "changed after publication review",
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it("retains original input and command after a lost response; does not retry automatically", async () => {
    const { app, publish } = await mount();
    const review = await app.reviewEditorRelease("version");
    publish.mockRejectedValueOnce(new Error("connection lost"));
    await expect(app.releaseEditorVersion(review, input, "original-command")).rejects.toThrow("connection lost");
    expect(publish).toHaveBeenCalledTimes(1);
    await expect(app.releaseEditorVersion(review, input, "new-command")).rejects.toThrow("original publication");
    await expect(
      app.releaseEditorVersion(review, { intent: { ...input.intent, visibility: "public" } }, "original-command"),
    ).rejects.toThrow("original publication");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await app.releaseEditorVersion(review, input, "original-command")).toEqual(receipt);
    expect(publish.mock.calls).toEqual([
      ["item", "version", input, "original-command"],
      ["item", "version", input, "original-command"],
    ]);
  });

  it("rechecks the session after the final version read and does not send authority overrides", async () => {
    const { app, getVersion, publish } = await mount();
    const review = await app.reviewEditorRelease("version");
    let finish!: (value: StudioContentVersion) => void;
    getVersion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = app.releaseEditorVersion(review, input, "command");
    const refused = expect(pending).rejects.toThrow("session or map changed");
    await vi.waitFor(() => expect(getVersion).toHaveBeenCalledTimes(2));
    app.session = { getToken: async () => "other-token", onExpired: () => () => {} };
    finish(version);
    await refused;
    expect(publish).not.toHaveBeenCalled();
  });

  it("sends only canonical publication inputs without caller-supplied approval fields", async () => {
    const { app, publish } = await mount();
    const review = await app.reviewEditorRelease("version");
    const candidate = { ...input, approved: true, approvalId: "invented", bypassPolicy: true };
    await app.releaseEditorVersion(review, candidate, "command");
    expect(publish).toHaveBeenCalledExactlyOnceWith("item", "version", input, "command");
  });

  it("coalesces double submission and refuses a receipt after the session changes", async () => {
    const { app, publish } = await mount();
    const review = await app.reviewEditorRelease("version");
    let finish!: (value: typeof receipt) => void;
    publish.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = app.releaseEditorVersion(review, input, "command");
    const second = app.releaseEditorVersion(review, input, "command");
    const refused = Promise.all([
      expect(first).rejects.toThrow("session or map changed"),
      expect(second).rejects.toThrow("session or map changed"),
    ]);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    app.session = { getToken: async () => "other-token", onExpired: () => () => {} };
    finish(receipt);
    await refused;
  });

  it.each([undefined, "", "command\n", "bad/key", "x".repeat(129)])(
    "refuses invalid command identity %j",
    async (command) => {
      const { app, publish } = await mount();
      const review = await app.reviewEditorRelease("version");
      await expect(app.releaseEditorVersion(review, input, command as string)).rejects.toThrow(
        "stable publication command ID",
      );
      expect(publish).not.toHaveBeenCalled();
    },
  );
});
