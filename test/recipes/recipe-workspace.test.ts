// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioAppElement } from "../../src/elements/studio-app-element.js";
import { StudioLifecycleClient } from "../../src/lifecycle/lifecycle-client.js";
import type { StudioPackageDraft, StudioPackageDraftCreateRequest } from "../../src/lifecycle/lifecycle-types.js";
import type { ExploreDatasetInput, ExploreDatasetMetadata } from "../../src/recipes/explore-dataset.js";

registerAllStudioElements();
const metadata: ExploreDatasetMetadata = {
  source: { id: "actual/0", title: "Actual source", protocol: "geoservices-feature-service", geometryType: "Polygon", locator: { url: "/rest/services/actual/FeatureServer", serviceId: "actual", layerId: 0 } },
  fields: [{ name: "category", type: "String" }], rows: [{ properties: { category: "Read category" } }], truncated: false,
};
const input: ExploreDatasetInput = { recipeId: "explore-dataset", recipeVersion: 1, packageKey: "my-exploration", sourceId: "actual/0", categoryField: "category", tableFields: ["category"] };

function mount() {
  const app = document.createElement("honua-studio-app") as HonuaStudioAppElement;
  app.session = { getToken: async () => "fixture", onExpired: () => () => {} };
  document.body.append(app);
  vi.spyOn(app, "resolveRecipeSource").mockResolvedValue(metadata);
  vi.spyOn(StudioLifecycleClient.prototype, "getPackageFamilies").mockResolvedValue({ families: [{ family: "map", supportLevel: "supported", supportedOperations: ["draft.create"] }] } as never);
  return app;
}
function accepted(request: StudioPackageDraftCreateRequest): StudioPackageDraft {
  return { draftId: "accepted-recipe", itemId: "item", packageKey: request.packageKey, generation: 1, envelope: request.envelope } as StudioPackageDraft;
}

describe("recipe canonical workspace creation", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No fixture network"); })));
  afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("writes once on concurrent submit, retains accepted identity after attach failure and never publishes", async () => {
    const app = mount();
    let created!: StudioPackageDraft;
    const create = vi.spyOn(StudioLifecycleClient.prototype, "createDraft").mockImplementation(async (request) => { created = accepted(request); return created; });
    vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockImplementation(async () => created);
    const attach = vi.spyOn(app, "attachWorkspaceDraft").mockRejectedValueOnce(new Error("Lost attach read"));
    const publish = vi.spyOn(StudioLifecycleClient.prototype, "requestPublish");
    const first = app.createRecipeDraft(input, "submission");
    expect(app.createRecipeDraft(input, "submission")).toBe(first);
    await expect(first).rejects.toThrow("Lost attach read");
    attach.mockRestore();
    expect(await app.createRecipeDraft(input, "submission")).toMatchObject({ draftId: "accepted-recipe" });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][1]).toMatch(/^[a-f0-9-]{36}$/);
    expect(app.composition.state.controls[0]).toMatchObject({ kind: "filterSelect", sourceId: "actual/0" });
    expect(publish).not.toHaveBeenCalled();
    await expect(app.createRecipeDraft({ ...input, categoryField: "changed" }, "submission")).rejects.toThrow("original inputs");
  });

  it("replays the original request/key after a lost create response", async () => {
    const app = mount(); let created!: StudioPackageDraft;
    const create = vi.spyOn(StudioLifecycleClient.prototype, "createDraft").mockImplementation(async (request) => {
      if (!created) { created = accepted(request); throw new Error("Lost create response"); }
      return created;
    });
    vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockImplementation(async () => created);
    await expect(app.createRecipeDraft(input, "lost-response")).rejects.toThrow("Lost create response");
    expect(await app.createRecipeDraft(input, "lost-response")).toMatchObject({ draftId: created.draftId });
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
    expect(app.resolveRecipeSource).toHaveBeenCalledOnce();
  });

  it("snapshots caller-owned input before asynchronous preparation and source verification", async () => {
    const app = mount();
    let complete!: (metadata: ExploreDatasetMetadata) => void;
    vi.mocked(app.resolveRecipeSource).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    let created!: StudioPackageDraft;
    const create = vi.spyOn(StudioLifecycleClient.prototype, "createDraft").mockImplementation(async (request) => { created = accepted(request); return created; });
    vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockImplementation(async () => created);
    const callerInput = { ...input, tableFields: [...input.tableFields] };
    const pending = app.createRecipeDraft(callerInput, "mutable-input");
    callerInput.packageKey = "host-mutated";
    callerInput.sourceId = "another-source";
    callerInput.tableFields.push("fabricated-column");
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    expect(app.resolveRecipeSource).toHaveBeenCalledWith("actual/0", expect.any(AbortSignal));
    complete(metadata);
    expect(await pending).toMatchObject({ packageKey: "my-exploration" });
    expect(create.mock.calls[0][0]).toMatchObject({ packageKey: "my-exploration", envelope: { body: { widgets: [{ config: { fields: ["category"] } }] } } });
  });

  it("blocks a forbidden source or missing draft capability before any create", async () => {
    const app = mount();
    const create = vi.spyOn(StudioLifecycleClient.prototype, "createDraft");
    vi.mocked(app.resolveRecipeSource).mockRejectedValueOnce(new Error("Denied source. Request read access."));
    await expect(app.createRecipeDraft(input, "denied")).rejects.toThrow("Request read access");
    vi.mocked(StudioLifecycleClient.prototype.getPackageFamilies).mockResolvedValueOnce({ families: [] } as never);
    await expect(app.createRecipeDraft(input, "missing-capability")).rejects.toThrow("creation is unavailable");
    expect(create).not.toHaveBeenCalled();
  });

  it("honors dirty edit guards, but prospective recipe inputs do not block explicit creation", async () => {
    const app = mount();
    const create = vi.spyOn(StudioLifecycleClient.prototype, "createDraft");
    const dirty = document.createElement("input"); dirty.value = "unsaved edit"; app.append(dirty);
    await expect(app.createRecipeDraft(input, "dirty")).rejects.toThrow("pending Studio edits");
    expect(create).not.toHaveBeenCalled();
    dirty.remove();
    const prospective = document.createElement("input"); prospective.value = "prospective recipe package";
    app.shadowRoot!.querySelector("[data-recipe-outlet]")!.append(prospective);
    await expect(app.prepareWorkspaceTurn()).resolves.toBeUndefined();
  });

  it("closing during create fences attachment and explicit retry attaches the same accepted draft", async () => {
    const app = mount(); let accept!: (draft: StudioPackageDraft) => void; let request!: StudioPackageDraftCreateRequest;
    const create = vi.spyOn(StudioLifecycleClient.prototype, "createDraft").mockImplementation((value) => { request = value; return new Promise((resolve) => { accept = resolve; }); });
    const pending = app.createRecipeDraft(input, "cancelled");
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    app.closeRecipePicker();
    const draft = accepted(request); accept(draft);
    await expect(pending).rejects.toThrow("picker was closed");
    expect(app.composition.state.layers).toHaveLength(0);
    vi.spyOn(StudioLifecycleClient.prototype, "getDraft").mockResolvedValue(draft);
    expect(await app.createRecipeDraft(input, "cancelled")).toMatchObject({ draftId: draft.draftId });
    expect(create).toHaveBeenCalledOnce();
  });

  it("cancels source verification before a create request is sent", async () => {
    const app = mount();
    let complete!: (metadata: ExploreDatasetMetadata) => void;
    let metadataSignal!: AbortSignal;
    vi.mocked(app.resolveRecipeSource).mockImplementation((_id, signal) => { metadataSignal = signal; return new Promise((resolve) => { complete = resolve; }); });
    const create = vi.spyOn(StudioLifecycleClient.prototype, "createDraft");
    const pending = app.createRecipeDraft(input, "cancel-before-post");
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    app.closeRecipePicker();
    expect(metadataSignal.aborted).toBe(true);
    complete(metadata);
    await expect(pending).rejects.toThrow("cancelled before submission");
    expect(create).not.toHaveBeenCalled();
  });

  it("retains the exact recipe outlet and prospective inputs on same-principal cookie renewal", async () => {
    const app = mount();
    const lease = { kind: "cookie" as const, baseUrl: "/api", sourcePathBase: "/api", environmentId: "environment", principalId: "principal", csrfToken: "csrf-1", expiresAt: new Date(Date.now() + 3600000).toISOString(), onExpired: () => () => {} };
    app.session = lease;
    vi.spyOn(app, "listRecipeSources").mockResolvedValue([metadata.source]);
    app.openRecipePicker();
    const outlet = app.shadowRoot!.querySelector<HTMLElement>("[data-recipe-outlet]")!;
    const key = outlet.querySelector<HTMLInputElement>('[name="packageKey"]')!;
    key.value = "prospective-input";
    app.session = { ...lease, csrfToken: "csrf-2", expiresAt: new Date(Date.now() + 7200000).toISOString() };
    app.openRecipePicker();
    expect(app.shadowRoot!.querySelector("[data-recipe-outlet]")).toBe(outlet);
    expect(outlet.querySelector('[data-testid="recipe-panel"]')).not.toBeNull();
    expect(outlet.querySelector<HTMLInputElement>('[name="packageKey"]')!.value).toBe("prospective-input");
  });

  it("fences stale authority before accepting a create response", async () => {
    const app = mount(); let accept!: (draft: StudioPackageDraft) => void; let request!: StudioPackageDraftCreateRequest;
    const create = vi.spyOn(StudioLifecycleClient.prototype, "createDraft").mockImplementation((value) => { request = value; return new Promise((resolve) => { accept = resolve; }); });
    const pending = app.createRecipeDraft(input, "authority");
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    app.session = { getToken: async () => "other-principal", onExpired: () => () => {} };
    accept(accepted(request));
    await expect(pending).rejects.toThrow("workspace authority changed");
    expect(app.composition.state.layers).toHaveLength(0);
    await expect(app.createRecipeDraft(input, "authority")).rejects.toThrow("original workspace authority");
  });
});
