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
  await app.attachWorkspaceDraft("draft");
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
    const review = await app.reviewWorkspacePublication("version");
    expect(review).toEqual(version);
    expect(Object.isFrozen(review)).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    expect(await app.publishWorkspaceVersion(review, input, "original-command")).toEqual(receipt);
    expect(getVersion).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledExactlyOnceWith("item", "version", input, "original-command");
  });

  it("refuses forged reviews and versions from another map", async () => {
    const { app, getVersion, publish } = await mount();
    await expect(app.publishWorkspaceVersion(version, input, "command")).rejects.toThrow("Review the saved version");
    getVersion.mockResolvedValue({ ...version, itemId: "other-item" });
    await expect(app.reviewWorkspacePublication("version")).rejects.toThrow("does not belong");
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(["session", "map"])("invalidates a review after the %s changes", async (change) => {
    const { app, getDraft, publish } = await mount();
    const review = await app.reviewWorkspacePublication("version");
    if (change === "session") app.session = { getToken: async () => "other-token", onExpired: () => () => {} };
    else {
      getDraft.mockResolvedValue({ ...draft, draftId: "other-draft", itemId: "other-item" });
      await app.attachWorkspaceDraft("other-draft");
    }
    await expect(app.publishWorkspaceVersion(review, input, "command")).rejects.toThrow("original workspace session");
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects changed immutable content before submission", async () => {
    const { app, getVersion, publish } = await mount();
    const review = await app.reviewWorkspacePublication("version");
    getVersion.mockResolvedValue({ ...version, contentHash: "different-content" });
    await expect(app.publishWorkspaceVersion(review, input, "command")).rejects.toThrow(
      "changed after publication review",
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it("retains original input and command after a lost response; does not retry automatically", async () => {
    const { app, publish } = await mount();
    const review = await app.reviewWorkspacePublication("version");
    publish.mockRejectedValueOnce(new Error("connection lost"));
    await expect(app.publishWorkspaceVersion(review, input, "original-command")).rejects.toThrow("connection lost");
    expect(publish).toHaveBeenCalledTimes(1);
    await expect(app.publishWorkspaceVersion(review, input, "new-command")).rejects.toThrow("original publication");
    await expect(
      app.publishWorkspaceVersion(review, { intent: { ...input.intent, visibility: "public" } }, "original-command"),
    ).rejects.toThrow("original publication");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await app.publishWorkspaceVersion(review, input, "original-command")).toEqual(receipt);
    expect(publish.mock.calls).toEqual([
      ["item", "version", input, "original-command"],
      ["item", "version", input, "original-command"],
    ]);
  });

  it("rechecks the session after the final version read and does not send authority overrides", async () => {
    const { app, getVersion, publish } = await mount();
    const review = await app.reviewWorkspacePublication("version");
    let finish!: (value: StudioContentVersion) => void;
    getVersion.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = app.publishWorkspaceVersion(review, input, "command");
    const refused = expect(pending).rejects.toThrow("session or map changed");
    await vi.waitFor(() => expect(getVersion).toHaveBeenCalledTimes(2));
    app.session = { getToken: async () => "other-token", onExpired: () => () => {} };
    finish(version);
    await refused;
    expect(publish).not.toHaveBeenCalled();
  });

  it("sends only canonical publication inputs without caller-supplied approval fields", async () => {
    const { app, publish } = await mount();
    const review = await app.reviewWorkspacePublication("version");
    const candidate = { ...input, approved: true, approvalId: "invented", bypassPolicy: true };
    await app.publishWorkspaceVersion(review, candidate, "command");
    expect(publish).toHaveBeenCalledExactlyOnceWith("item", "version", input, "command");
  });

  it("coalesces double submission and refuses a receipt after the session changes", async () => {
    const { app, publish } = await mount();
    const review = await app.reviewWorkspacePublication("version");
    let finish!: (value: typeof receipt) => void;
    publish.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = app.publishWorkspaceVersion(review, input, "command");
    const second = app.publishWorkspaceVersion(review, input, "command");
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
      const review = await app.reviewWorkspacePublication("version");
      await expect(app.publishWorkspaceVersion(review, input, command as string)).rejects.toThrow(
        "stable publication command ID",
      );
      expect(publish).not.toHaveBeenCalled();
    },
  );
});
