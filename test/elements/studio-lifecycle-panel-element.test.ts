// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioLifecyclePanelElement } from "../../src/elements/studio-lifecycle-panel-element.js";
import type { HonuaStudioLifecycleActivityDetail } from "../../src/elements/types.js";
import type {
  StudioContentVersion,
  StudioContentVersionListResponse,
  StudioPackageDraft,
  StudioPublicationRequest,
  StudioPublicationRequestStatusResult,
  StudioRollbackRequest,
  StudioVersionComparison,
} from "../../src/lifecycle/lifecycle-types.js";

registerAllStudioElements();

function fakeDraft(overrides: Partial<StudioPackageDraft> = {}): StudioPackageDraft {
  return {
    draftId: "draft-1",
    itemId: "item-1",
    packageKey: "parcels-overview",
    family: "map",
    envelope: { family: "map", schemaVersion: "1.0", body: { layers: [], view: {}, widgets: [] } },
    validation: { status: "not-validated", diagnostics: [] },
    generation: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function fakeVersion(overrides: Partial<StudioContentVersion> = {}): StudioContentVersion {
  return {
    itemId: "item-1",
    packageKey: "parcels-overview",
    versionId: "version-1",
    versionNumber: 1,
    contentHash: "abc123def456",
    envelope: { family: "map", schemaVersion: "1.0", body: { layers: [], view: {}, widgets: [] } },
    validation: { status: "valid", diagnostics: [] },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/** A fake `StudioLifecycleClient` that tracks every call — used to assert the human gate: `requestPublish`/`requestRollback` call counts stay 0 until an explicit typed confirmation. */
class FakeLifecycleClient {
  public draft: StudioPackageDraft = fakeDraft();
  public versions: StudioContentVersion[] = [fakeVersion()];
  public comparison: StudioVersionComparison | undefined;
  public publishResponse: StudioPublicationRequest = {
    requestId: "req-1",
    itemId: "item-1",
    versionId: "version-1",
    status: "accepted",
    createdAt: "2026-01-01T00:00:00Z",
  };
  public publicationStatus: StudioPublicationRequestStatusResult = {
    requestId: "req-1",
    itemId: "item-1",
    versionId: "version-1",
    status: "published",
    publicUrl: "/api/v1/published/studio/parcels-overview",
  };
  public rollbackResponse: StudioRollbackRequest = {
    requestId: "req-2",
    itemId: "item-1",
    targetVersionId: "version-1",
    pointer: "both",
    pointers: { itemId: "item-1", currentVersionId: "version-1", publishedVersionId: "version-1" },
    createdAt: "2026-01-01T00:00:00Z",
  };

  public requestPublishCalls: unknown[] = [];
  public requestRollbackCalls: unknown[] = [];
  /** Tracks drafts created by `reopenVersion` so a subsequent `getDraft` (the element ALWAYS re-fetches after switching `.draftId` rather than trusting `reopenVersion`'s own return value) reflects the reopened `baseVersionId` — mirrors a real server's behavior. */
  #reopenedDrafts = new Map<string, StudioPackageDraft>();

  async getDraft(draftId: string): Promise<StudioPackageDraft> {
    const reopened = this.#reopenedDrafts.get(draftId);
    if (reopened) return reopened;
    return { ...this.draft, draftId };
  }

  async listVersions(itemId: string): Promise<StudioContentVersionListResponse> {
    return { itemId, versions: this.versions };
  }

  async validateDraft(): Promise<{ status: string }> {
    return { status: "valid" };
  }

  async saveAsVersion(): Promise<StudioContentVersion> {
    const version = fakeVersion({
      versionId: `version-${this.versions.length + 1}`,
      versionNumber: this.versions.length + 1,
    });
    this.versions.push(version);
    return version;
  }

  async reopenVersion(itemId: string, versionId: string): Promise<StudioPackageDraft> {
    const draft = fakeDraft({ draftId: "draft-2", itemId, baseVersionId: versionId, generation: 1 });
    this.#reopenedDrafts.set(draft.draftId, draft);
    return draft;
  }

  async compareVersions(): Promise<StudioVersionComparison> {
    return (
      this.comparison ?? {
        leftVersionId: "version-1",
        rightVersionId: "version-2",
        contentEqual: false,
        dependenciesEqual: true,
        validationEqual: true,
        provenanceEqual: true,
        changes: ["content"],
      }
    );
  }

  async requestPublish(itemId: unknown, versionId: unknown, input: unknown): Promise<StudioPublicationRequest> {
    this.requestPublishCalls.push({ itemId, versionId, input });
    return this.publishResponse;
  }

  async getPublicationRequest(): Promise<StudioPublicationRequestStatusResult> {
    return this.publicationStatus;
  }

  async requestRollback(itemId: unknown, input: unknown): Promise<StudioRollbackRequest> {
    this.requestRollbackCalls.push({ itemId, input });
    return this.rollbackResponse;
  }
}

function mount(client: FakeLifecycleClient): { el: HonuaStudioLifecyclePanelElement; client: FakeLifecycleClient } {
  const el = document.createElement("honua-studio-lifecycle-panel") as HonuaStudioLifecyclePanelElement;
  // FakeLifecycleClient satisfies the structural surface the element reads, not the full StudioLifecycleClient class.
  el.client = client as any;
  document.body.appendChild(el);
  return { el, client };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("<honua-studio-lifecycle-panel> (honua-studio#9)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("with no draftId/itemId set, renders the empty state", async () => {
    const { el } = mount(new FakeLifecycleClient());
    await flush();
    expect(el.shadowRoot?.querySelector('[data-testid="lifecycle-no-draft"]')).toBeTruthy();
  });

  it("setting .draftId loads the draft and renders generation/validation status", async () => {
    const { el } = mount(new FakeLifecycleClient());
    el.draftId = "draft-1";
    await flush();

    expect(el.shadowRoot?.querySelector('[data-testid="lifecycle-panel-generation"]')?.textContent).toContain("1");
    expect(el.shadowRoot?.querySelector('[data-testid="lifecycle-panel-validation-status"]')?.textContent).toContain(
      "not-validated",
    );
    expect(el.draft?.draftId).toBe("draft-1");
  });

  it("setting .draftId also loads the item's version list", async () => {
    const { el } = mount(new FakeLifecycleClient());
    el.draftId = "draft-1";
    await flush();

    expect(el.shadowRoot?.querySelectorAll('[data-testid="lifecycle-version-row"]')).toHaveLength(1);
  });

  it("Save as version calls client.saveAsVersion and refreshes the version list", async () => {
    const { el, client } = mount(new FakeLifecycleClient());
    el.draftId = "draft-1";
    await flush();
    expect(client.versions).toHaveLength(1);

    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-panel-save-version"]')?.click();
    await flush();

    expect(client.versions).toHaveLength(2);
    expect(el.shadowRoot?.querySelectorAll('[data-testid="lifecycle-version-row"]')).toHaveLength(2);
  });

  it("selecting left/right versions and clicking Compare renders the comparison", async () => {
    const client = new FakeLifecycleClient();
    client.versions = [
      fakeVersion({ versionId: "v1", versionNumber: 1 }),
      fakeVersion({ versionId: "v2", versionNumber: 2 }),
    ];
    const { el } = mount(client);
    el.draftId = "draft-1";
    await flush();

    const leftRadios = el.shadowRoot?.querySelectorAll<HTMLInputElement>('[data-testid="lifecycle-compare-left"]');
    const rightRadios = el.shadowRoot?.querySelectorAll<HTMLInputElement>('[data-testid="lifecycle-compare-right"]');
    expect(leftRadios).toHaveLength(2);
    leftRadios?.[0]?.click();
    leftRadios?.[0]?.dispatchEvent(new Event("change"));
    rightRadios?.[1]?.click();
    rightRadios?.[1]?.dispatchEvent(new Event("change"));
    await flush();

    const compareButton = el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-compare-button"]');
    expect(compareButton?.disabled).toBe(false);
    compareButton?.click();
    await flush();

    expect(el.shadowRoot?.querySelector('[data-testid="lifecycle-comparison"]')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[data-testid="lifecycle-comparison-changes"]')?.textContent).toContain(
      "content",
    );
  });

  it("Reopen as draft switches .draftId to the newly reopened draft", async () => {
    const { el } = mount(new FakeLifecycleClient());
    el.draftId = "draft-1";
    await flush();

    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-version-reopen"]')?.click();
    await flush();

    expect(el.draftId).toBe("draft-2");
    expect(el.draft?.baseVersionId).toBe("version-1");
  });

  it("renders the pending-publication banner when the draft carries a publicationIntent, WITHOUT calling requestPublish", async () => {
    const client = new FakeLifecycleClient();
    client.draft = fakeDraft({
      envelope: {
        family: "map",
        schemaVersion: "1.0",
        publicationIntent: { route: "/studio/parcels", visibility: "organization" },
      },
    });
    const { el } = mount(client);
    el.draftId = "draft-1";
    await flush();

    const banner = el.shadowRoot?.querySelector('[data-testid="lifecycle-pending-publication-banner"]');
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toContain("/studio/parcels");
    expect(client.requestPublishCalls).toHaveLength(0);
    expect(client.requestRollbackCalls).toHaveLength(0);
  });

  describe("THE HUMAN GATE (spec REQ-009)", () => {
    it("clicking 'Publish…' opens a confirm dialog and does NOT call requestPublish yet", async () => {
      const { el, client } = mount(new FakeLifecycleClient());
      el.draftId = "draft-1";
      await flush();

      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-version-publish"]')?.click();
      await flush();

      expect(el.shadowRoot?.querySelector('[data-testid="lifecycle-confirm-dialog"]')).toBeTruthy();
      expect(client.requestPublishCalls).toHaveLength(0);
    });

    it("the confirm-submit button is disabled until the typed text exactly matches the packageKey", async () => {
      const { el } = mount(new FakeLifecycleClient());
      el.draftId = "draft-1";
      await flush();
      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-version-publish"]')?.click();
      await flush();

      const submit = () => el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-confirm-submit"]');
      const input = el.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="lifecycle-confirm-input"]');
      expect(submit()?.disabled).toBe(true);

      if (input) {
        input.value = "wrong-key";
        input.dispatchEvent(new Event("input"));
      }
      await flush();
      expect(submit()?.disabled).toBe(true);

      const freshInput = el.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="lifecycle-confirm-input"]');
      if (freshInput) {
        freshInput.value = "parcels-overview"; // exact packageKey
        freshInput.dispatchEvent(new Event("input"));
      }
      await flush();
      expect(submit()?.disabled).toBe(false);
    });

    it("clicking Confirm publish (only once enabled) calls client.requestPublish exactly once with the selected version and intent", async () => {
      const { el, client } = mount(new FakeLifecycleClient());
      el.draftId = "draft-1";
      await flush();
      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-version-publish"]')?.click();
      await flush();

      const input = el.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="lifecycle-confirm-input"]');
      if (input) {
        input.value = "parcels-overview";
        input.dispatchEvent(new Event("input"));
      }
      await flush();

      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-confirm-submit"]')?.click();
      await flush();

      expect(client.requestPublishCalls).toEqual([
        { itemId: "item-1", versionId: "version-1", input: { intent: undefined } },
      ]);
      expect(client.requestRollbackCalls).toHaveLength(0);
      expect(el.shadowRoot?.querySelector('[data-testid="lifecycle-confirm-dialog"]')).toBeFalsy(); // dialog closes after success
      expect(el.shadowRoot?.querySelector('[data-testid="lifecycle-panel-message"]')?.textContent).toContain(
        "Human approval complete",
      );
      expect(
        el.shadowRoot?.querySelector<HTMLAnchorElement>('[data-testid="lifecycle-approved-public-link"]')?.href,
      ).toContain("/api/v1/published/studio/parcels-overview");
    });

    it("never renders or emits a link until the request status is approved or published", async () => {
      const client = new FakeLifecycleClient();
      client.publicationStatus = {
        ...client.publicationStatus,
        status: "pending",
        // A defensive contract case: even a premature server URL must not
        // cross Studio's approval boundary.
        publicUrl: "/api/v1/published/studio/not-approved",
      };
      const { el } = mount(client);
      const activity = vi.fn();
      el.addEventListener("honua-studio-lifecycle-activity", activity);
      el.draftId = "draft-1";
      await flush();
      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-version-publish"]')?.click();
      await flush();

      const input = el.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="lifecycle-confirm-input"]');
      if (input) {
        input.value = "parcels-overview";
        input.dispatchEvent(new Event("input"));
      }
      await flush();
      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-confirm-submit"]')?.click();
      await flush();

      expect(el.shadowRoot?.querySelector('[data-testid="lifecycle-approved-public-link"]')).toBeFalsy();
      expect(el.shadowRoot?.querySelector('[data-testid="lifecycle-publication-pending"]')).toBeTruthy();
      const statusEvent = activity.mock.calls
        .map((call) => (call[0] as CustomEvent<HonuaStudioLifecycleActivityDetail>).detail)
        .find((detail) => detail.kind === "publication-status");
      expect(statusEvent).toMatchObject({ kind: "publication-status", message: "pending" });
      expect(statusEvent).not.toHaveProperty("publicUrl");
    });

    it("Cancel closes the dialog without ever calling requestPublish", async () => {
      const { el, client } = mount(new FakeLifecycleClient());
      el.draftId = "draft-1";
      await flush();
      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-version-publish"]')?.click();
      await flush();

      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-confirm-cancel"]')?.click();
      await flush();

      expect(el.shadowRoot?.querySelector('[data-testid="lifecycle-confirm-dialog"]')).toBeFalsy();
      expect(client.requestPublishCalls).toHaveLength(0);
    });

    it("the rollback confirm flow requires the same typed confirmation before calling client.requestRollback", async () => {
      const { el, client } = mount(new FakeLifecycleClient());
      el.draftId = "draft-1";
      await flush();

      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-version-rollback"]')?.click();
      await flush();
      expect(client.requestRollbackCalls).toHaveLength(0);

      const submit = () => el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-confirm-submit"]');
      expect(submit()?.disabled).toBe(true);

      const input = el.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="lifecycle-confirm-input"]');
      if (input) {
        input.value = "parcels-overview";
        input.dispatchEvent(new Event("input"));
      }
      await flush();
      submit()?.click();
      await flush();

      expect(client.requestRollbackCalls).toEqual([
        { itemId: "item-1", input: { targetVersionId: "version-1", pointer: "both" } },
      ]);
    });

    it("no amount of loading/saving/comparing/reopening ever calls requestPublish or requestRollback on its own", async () => {
      const client = new FakeLifecycleClient();
      client.versions = [fakeVersion({ versionId: "v1" }), fakeVersion({ versionId: "v2", versionNumber: 2 })];
      const { el } = mount(client);
      el.draftId = "draft-1";
      await flush();
      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-panel-validate"]')?.click();
      await flush();
      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-panel-save-version"]')?.click();
      await flush();
      const leftRadios = el.shadowRoot?.querySelectorAll<HTMLInputElement>('[data-testid="lifecycle-compare-left"]');
      const rightRadios = el.shadowRoot?.querySelectorAll<HTMLInputElement>('[data-testid="lifecycle-compare-right"]');
      leftRadios?.[0]?.dispatchEvent(new Event("change"));
      rightRadios?.[1]?.dispatchEvent(new Event("change"));
      await flush();
      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-compare-button"]')?.click();
      await flush();
      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-version-reopen"]')?.click();
      await flush();

      expect(client.requestPublishCalls).toHaveLength(0);
      expect(client.requestRollbackCalls).toHaveLength(0);
    });
  });

  it("dispatches honua-studio-lifecycle-activity on draft-loaded/version-saved/publish-requested (composed, for the app's shared activity log)", async () => {
    const client = new FakeLifecycleClient();
    const { el } = mount(client);
    const kinds: HonuaStudioLifecycleActivityDetail["kind"][] = [];
    el.addEventListener("honua-studio-lifecycle-activity", (event) => {
      kinds.push((event as CustomEvent<HonuaStudioLifecycleActivityDetail>).detail.kind);
    });

    el.draftId = "draft-1";
    await flush();
    expect(kinds).toContain("draft-loaded");

    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="lifecycle-panel-save-version"]')?.click();
    await flush();
    expect(kinds).toContain("version-saved");
  });
});
