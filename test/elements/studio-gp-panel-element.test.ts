// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioGpPanelElement } from "../../src/elements/studio-gp-panel-element.js";
import type { HonuaStudioGpActivityDetail, HonuaStudioGpAddOutputDetail } from "../../src/elements/types.js";
import type { GpJobSnapshot } from "../../src/gp/gp-types.js";
import type { StudioPackageDraft, StudioPreviewPlan } from "../../src/lifecycle/lifecycle-types.js";

registerAllStudioElements();

function fakeDraft(overrides: Partial<StudioPackageDraft> = {}): StudioPackageDraft {
  return {
    draftId: "gp-draft-1",
    itemId: "gp-item-1",
    packageKey: "gp-buffer-intersect",
    family: "gp",
    envelope: {
      family: "gp",
      schemaVersion: "1.0",
      body: {
        title: "Buffer flood zones",
        inputs: [{ id: "flood-zones", title: "Flood zones", datasetRef: "hi-flood-zones" }],
        parameters: [{ id: "buffer-distance-m", title: "Buffer distance", type: "number", value: 500, unit: "meters" }],
        outputs: [{ id: "result", title: "Affected parcels" }],
        steps: [],
      },
    },
    validation: { status: "not-validated", diagnostics: [] },
    generation: 1,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

class FakeLifecycleClient {
  public draft: StudioPackageDraft = fakeDraft();
  public preview: StudioPreviewPlan = {
    draftId: "gp-draft-1",
    family: "gp",
    synchronous: false,
    requiresJob: true,
    steps: ["validate-envelope", "plan-background-preview-job"],
    validation: { status: "valid", diagnostics: [] },
  };
  public validateCalls = 0;
  public previewCalls = 0;

  async getDraft(draftId: string): Promise<StudioPackageDraft> {
    return { ...this.draft, draftId };
  }

  async validateDraft(): Promise<StudioPreviewPlan["validation"]> {
    this.validateCalls += 1;
    this.draft = { ...this.draft, validation: { status: "valid", diagnostics: [] } };
    return this.draft.validation as StudioPreviewPlan["validation"];
  }

  async previewPlan(): Promise<StudioPreviewPlan> {
    this.previewCalls += 1;
    return this.preview;
  }
}

class FakeGpJobClient {
  public submitCalls: unknown[] = [];
  public statusCalls: string[] = [];
  public cancelCalls: string[] = [];
  public pollCount = 0;
  public jobId = "fake-gp-job-1";

  async submit(input: unknown): Promise<GpJobSnapshot> {
    this.submitCalls.push(input);
    this.pollCount = 0;
    return { jobId: this.jobId, draftId: "gp-draft-1", status: "accepted", progress: { percent: 5 } };
  }

  async status(jobId: string): Promise<GpJobSnapshot> {
    this.statusCalls.push(jobId);
    this.pollCount += 1;
    if (this.pollCount >= 2) {
      return {
        jobId,
        draftId: "gp-draft-1",
        status: "successful",
        progress: { percent: 100 },
        result: {
          outputs: [{ outputId: "result", datasetId: "gp-output-fake-gp-job-1-result", title: "Affected parcels" }],
        },
      };
    }
    return { jobId, draftId: "gp-draft-1", status: "running", progress: { percent: 45 } };
  }

  async cancel(jobId: string): Promise<GpJobSnapshot> {
    this.cancelCalls.push(jobId);
    return { jobId, draftId: "gp-draft-1", status: "dismissed", progress: { percent: 100 } };
  }
}

function mount(
  lifecycle: FakeLifecycleClient,
  jobs: FakeGpJobClient,
): { el: HonuaStudioGpPanelElement; lifecycle: FakeLifecycleClient; jobs: FakeGpJobClient } {
  const el = document.createElement("honua-studio-gp-panel") as HonuaStudioGpPanelElement;
  // Fakes satisfy the structural surface the element reads, not the full classes.
  el.client = lifecycle as any;
  el.jobClient = jobs as any;
  document.body.appendChild(el);
  return { el, lifecycle, jobs };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("<honua-studio-gp-panel> (honua-studio#10)", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    window.sessionStorage.clear();
  });

  it("with no draftId set, renders the empty state", async () => {
    const { el } = mount(new FakeLifecycleClient(), new FakeGpJobClient());
    await flush();
    expect(el.shadowRoot?.querySelector('[data-testid="gp-no-draft"]')).toBeTruthy();
  });

  it("always surfaces the envelope-only validation caveat verbatim (the honesty note)", async () => {
    const { el } = mount(new FakeLifecycleClient(), new FakeGpJobClient());
    await flush();
    const caveat = el.shadowRoot?.querySelector('[data-testid="gp-validation-caveat"]')?.textContent ?? "";
    expect(caveat).toMatch(/envelope-only/i);
    expect(caveat).toMatch(/planning-only/i);
  });

  it("setting .draftId loads the draft and renders inputs/parameters/outputs", async () => {
    const { el } = mount(new FakeLifecycleClient(), new FakeGpJobClient());
    el.draftId = "gp-draft-1";
    await flush();
    expect(el.shadowRoot?.querySelector('[data-testid="gp-panel-generation"]')?.textContent).toContain("1");
    expect(el.shadowRoot?.querySelector('[data-testid="gp-inputs"]')?.textContent).toContain("Flood zones");
    expect(el.shadowRoot?.querySelector('[data-testid="gp-parameters"]')?.textContent).toContain("Buffer distance");
    expect(el.shadowRoot?.querySelector('[data-testid="gp-outputs"]')?.textContent).toContain("Affected parcels");
  });

  it("the Execute button only appears after a preview plan has been fetched (REQ-002)", async () => {
    const { el } = mount(new FakeLifecycleClient(), new FakeGpJobClient());
    el.draftId = "gp-draft-1";
    await flush();
    expect(el.shadowRoot?.querySelector('[data-testid="gp-execute-open"]')).toBeFalsy();

    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-panel-preview"]')?.click();
    await flush();
    expect(el.shadowRoot?.querySelector('[data-testid="gp-preview-requires-job"]')?.textContent).toContain(
      "requires a batch job",
    );
    expect(el.shadowRoot?.querySelector('[data-testid="gp-execute-open"]')).toBeTruthy();
  });

  describe("THE HUMAN GATE (spec REQ-009 discipline extended to GP execution)", () => {
    async function mountWithPreview() {
      const mounted = mount(new FakeLifecycleClient(), new FakeGpJobClient());
      mounted.el.draftId = "gp-draft-1";
      await flush();
      mounted.el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-panel-preview"]')?.click();
      await flush();
      return mounted;
    }

    it("clicking Execute… opens a confirm dialog and does NOT call jobClient.submit yet", async () => {
      const { el, jobs } = await mountWithPreview();
      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-execute-open"]')?.click();
      await flush();
      expect(el.shadowRoot?.querySelector('[data-testid="gp-confirm-dialog"]')).toBeTruthy();
      expect(jobs.submitCalls).toHaveLength(0);
    });

    it("the confirm-submit button is disabled until the typed text exactly matches the packageKey", async () => {
      const { el, jobs } = await mountWithPreview();
      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-execute-open"]')?.click();
      await flush();

      const submit = () => el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-confirm-submit"]');
      expect(submit()?.disabled).toBe(true);

      const input = el.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="gp-confirm-input"]');
      if (input) {
        input.value = "wrong-key";
        input.dispatchEvent(new Event("input"));
      }
      await flush();
      expect(submit()?.disabled).toBe(true);
      expect(jobs.submitCalls).toHaveLength(0);

      const freshInput = el.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="gp-confirm-input"]');
      if (freshInput) {
        freshInput.value = "gp-buffer-intersect";
        freshInput.dispatchEvent(new Event("input"));
      }
      await flush();
      expect(submit()?.disabled).toBe(false);
    });

    it("Cancel closes the dialog without ever calling jobClient.submit", async () => {
      const { el, jobs } = await mountWithPreview();
      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-execute-open"]')?.click();
      await flush();
      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-confirm-cancel"]')?.click();
      await flush();
      expect(el.shadowRoot?.querySelector('[data-testid="gp-confirm-dialog"]')).toBeFalsy();
      expect(jobs.submitCalls).toHaveLength(0);
    });

    it("confirming (only once enabled) calls jobClient.submit exactly once, then closes the dialog", async () => {
      const { el, jobs } = await mountWithPreview();
      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-execute-open"]')?.click();
      await flush();
      const input = el.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="gp-confirm-input"]');
      if (input) {
        input.value = "gp-buffer-intersect";
        input.dispatchEvent(new Event("input"));
      }
      await flush();
      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-confirm-submit"]')?.click();
      await flush();

      expect(jobs.submitCalls).toHaveLength(1);
      expect(el.shadowRoot?.querySelector('[data-testid="gp-confirm-dialog"]')).toBeFalsy();
      expect(el.shadowRoot?.querySelector('[data-testid="gp-job-status"]')?.textContent).toContain("accepted");
    });

    it("no amount of loading/validating/previewing ever calls jobClient.submit on its own", async () => {
      const { el, jobs } = await mountWithPreview();
      el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-panel-validate"]')?.click();
      await flush();
      expect(jobs.submitCalls).toHaveLength(0);
    });
  });

  it("Check status advances the job snapshot and eventually renders outputs with an Add-to-composition button", async () => {
    const { el } = mount(new FakeLifecycleClient(), new FakeGpJobClient());
    el.draftId = "gp-draft-1";
    await flush();
    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-panel-preview"]')?.click();
    await flush();
    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-execute-open"]')?.click();
    await flush();
    const input = el.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="gp-confirm-input"]');
    if (input) {
      input.value = "gp-buffer-intersect";
      input.dispatchEvent(new Event("input"));
    }
    await flush();
    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-confirm-submit"]')?.click();
    await flush();

    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-job-check-status"]')?.click();
    await flush();
    expect(el.shadowRoot?.querySelector('[data-testid="gp-job-status"]')?.textContent).toContain("running");

    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-job-check-status"]')?.click();
    await flush();
    expect(el.shadowRoot?.querySelector('[data-testid="gp-job-status"]')?.textContent).toContain("successful");
    expect(el.shadowRoot?.querySelector('[data-testid="gp-job-outputs"]')?.textContent).toContain("Affected parcels");
  });

  it("clicking Add to composition dispatches honua-studio-gp-add-output with the output's dataset id (REQ-004)", async () => {
    const { el } = mount(new FakeLifecycleClient(), new FakeGpJobClient());
    el.draftId = "gp-draft-1";
    await flush();
    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-panel-preview"]')?.click();
    await flush();
    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-execute-open"]')?.click();
    await flush();
    const input = el.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="gp-confirm-input"]');
    if (input) {
      input.value = "gp-buffer-intersect";
      input.dispatchEvent(new Event("input"));
    }
    await flush();
    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-confirm-submit"]')?.click();
    await flush();
    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-job-check-status"]')?.click();
    await flush();
    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-job-check-status"]')?.click();
    await flush();

    let captured: HonuaStudioGpAddOutputDetail | undefined;
    el.addEventListener("honua-studio-gp-add-output", (event) => {
      captured = (event as CustomEvent<HonuaStudioGpAddOutputDetail>).detail;
    });
    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-add-output"]')?.click();
    await flush();

    expect(captured).toEqual({ sourceId: "gp-output-fake-gp-job-1-result", title: "Affected parcels" });
  });

  it("cancelling a running job calls jobClient.cancel and renders the dismissed status", async () => {
    const { el, jobs } = mount(new FakeLifecycleClient(), new FakeGpJobClient());
    el.draftId = "gp-draft-1";
    await flush();
    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-panel-preview"]')?.click();
    await flush();
    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-execute-open"]')?.click();
    await flush();
    const input = el.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="gp-confirm-input"]');
    if (input) {
      input.value = "gp-buffer-intersect";
      input.dispatchEvent(new Event("input"));
    }
    await flush();
    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-confirm-submit"]')?.click();
    await flush();

    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-job-cancel"]')?.click();
    await flush();
    expect(jobs.cancelCalls).toEqual(["fake-gp-job-1"]);
    expect(el.shadowRoot?.querySelector('[data-testid="gp-job-status"]')?.textContent).toContain("dismissed");
  });

  it("resumes monitoring a job persisted in sessionStorage for this draft id, without a new submit", async () => {
    window.sessionStorage.setItem("honua-studio-gp-job:gp-draft-1", "fake-gp-job-1");
    const { el, jobs } = mount(new FakeLifecycleClient(), new FakeGpJobClient());
    el.draftId = "gp-draft-1";
    await flush();

    expect(jobs.submitCalls).toHaveLength(0);
    expect(jobs.statusCalls).toEqual(["fake-gp-job-1"]);
    expect(el.shadowRoot?.querySelector('[data-testid="gp-job-status"]')?.textContent).toContain("running");
  });

  it("dispatches honua-studio-gp-activity on draft-loaded/preview-ready/job-submitted", async () => {
    const { el } = mount(new FakeLifecycleClient(), new FakeGpJobClient());
    const kinds: HonuaStudioGpActivityDetail["kind"][] = [];
    el.addEventListener("honua-studio-gp-activity", (event) => {
      kinds.push((event as CustomEvent<HonuaStudioGpActivityDetail>).detail.kind);
    });
    el.draftId = "gp-draft-1";
    await flush();
    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-panel-preview"]')?.click();
    await flush();
    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-execute-open"]')?.click();
    await flush();
    const input = el.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="gp-confirm-input"]');
    if (input) {
      input.value = "gp-buffer-intersect";
      input.dispatchEvent(new Event("input"));
    }
    await flush();
    el.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="gp-confirm-submit"]')?.click();
    await flush();

    expect(kinds).toEqual(["draft-loaded", "preview-ready", "job-submitted"]);
  });
});
