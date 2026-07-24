import { gpValidationCaveat } from "../gp/gp-model.js";
import type { GpJobSnapshot, GpPackageBody } from "../gp/gp-types.js";
import { StudioGpJobClient } from "../gp/job-client.js";
import type { GpJobClient } from "../gp/job-client.js";
/**
 * `<honua-studio-gp-panel>` (honua-studio#10 build item 2) — renders an
 * agent-authored `gp`-family package (inputs/parameters/outputs, the GP
 * analog of the SQL preview `studio-lifecycle-panel-element.ts` doesn't have
 * a per-family equivalent of yet), its validation state (with the honest
 * "envelope-only validation" caveat — `gp-model.ts`'s `gpValidationCaveat()`
 * — surfaced verbatim, never paraphrased away), the preview plan, and drives
 * batch execution + monitoring.
 *
 * ## THE HUMAN GATE — spec REQ-009 discipline extended to GP execution
 * (honua-studio#10 build item 3; mirrors `studio-lifecycle-panel-element.ts`'s
 * module doc and dialog discipline EXACTLY)
 *
 * "EXECUTION of a GP job is a human action after a confirmed preview plan —
 * the agent can author and validate the package and propose execution, but
 * the run button is the human's." Concretely:
 *
 *  - The "Execute" button only renders once a preview plan has been fetched
 *    (`#preview !== undefined`) — REQ-002's "dry-run/preview-plan is
 *    mandatory before first execution".
 *  - Clicking it opens THIS element's own typed-confirmation dialog
 *    (`#openExecuteConfirm`/`#submitExecute`) — the human must type the
 *    exact package key into `#confirmInput`, same discipline as the
 *    publish/rollback dialogs. `#confirmSubmit` is the ONLY button wired to
 *    `#submitExecute`, itself the ONLY call site anywhere in this file (and,
 *    per `test/gp/human-gate.test.ts`'s static scan, anywhere in
 *    `src/mcp/**`, `src/chat/**`, or `src/composition/**`) that calls
 *    `GpJobClient.submit()`.
 *  - `GpAuthoringSession` (`../gp/gp-authoring-session.js`, the agent's
 *    entire reach into GP) never imports `../gp/job-client.js` at all — it
 *    structurally cannot reach `submit` even transitively. See
 *    `job-client.ts`'s module doc.
 *
 * @module
 */
import { StudioLifecycleClient } from "../lifecycle/lifecycle-client.js";
import type { StudioPackageDraft, StudioPreviewPlan } from "../lifecycle/lifecycle-types.js";
import { HonuaStudioElementBase } from "./base-element.js";
import { resolveInjectedAuth } from "./session.js";
import { baseElementStyles, gpPanelStyles, lifecycleStyles } from "./styles.js";
import type { AuthSession, HonuaStudioGpActivityDetail, HonuaStudioGpAddOutputDetail } from "./types.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionStorageKey(draftId: string): string {
  return `honua-studio-gp-job:${draftId}`;
}

function safeSessionStorage(): Storage | undefined {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : undefined;
  } catch {
    return undefined;
  }
}

function isGpPackageBody(value: unknown): value is GpPackageBody {
  return typeof value === "object" && value !== null && Array.isArray((value as GpPackageBody).inputs);
}

export class HonuaStudioGpPanelElement extends HonuaStudioElementBase {
  static get observedAttributes(): string[] {
    return ["label", "draft-id"];
  }

  #auth: AuthSession | undefined;
  #client: StudioLifecycleClient | undefined;
  #jobClient: GpJobClient | undefined;

  #draft: StudioPackageDraft | undefined;
  #draftLoading = false;
  #preview: StudioPreviewPlan | undefined;
  #previewLoading = false;
  #job: GpJobSnapshot | undefined;
  #jobBusy = false;
  #error: string | undefined;
  #actionMessage: string | undefined;

  /** Confirm-dialog gate — `undefined` when the dialog isn't open. Only opened by `#openExecuteConfirm`, itself only wired to a shadow-DOM button click. See the module doc. */
  #confirmOpen = false;
  #confirmText = "";
  #confirmSubmitting = false;

  #loadToken = 0;

  public get auth(): AuthSession | undefined {
    return this.#auth;
  }

  public set auth(auth: AuthSession | undefined) {
    this.#auth = auth;
    this.#client = undefined;
    this.#jobClient = undefined;
    if (this.isConnected) void this.#load();
  }

  public get client(): StudioLifecycleClient {
    if (!this.#client) this.#client = new StudioLifecycleClient({ baseUrl: "/api", auth: this.#auth });
    return this.#client;
  }

  public set client(client: StudioLifecycleClient) {
    this.#client = client;
    if (this.isConnected) void this.#load();
  }

  /** THE HUMAN GATE's own client — see the module doc. Lazily created; override for tests. */
  public get jobClient(): GpJobClient {
    if (!this.#jobClient) this.#jobClient = new StudioGpJobClient({ baseUrl: "/api", auth: this.#auth });
    return this.#jobClient;
  }

  public set jobClient(client: GpJobClient) {
    this.#jobClient = client;
  }

  public get draftId(): string | undefined {
    return this.getAttribute("draft-id") ?? undefined;
  }

  public set draftId(value: string | undefined) {
    if (value === undefined) this.removeAttribute("draft-id");
    else this.setAttribute("draft-id", value);
  }

  public get draft(): StudioPackageDraft | undefined {
    return this.#draft;
  }

  public get preview(): StudioPreviewPlan | undefined {
    return this.#preview;
  }

  public get job(): GpJobSnapshot | undefined {
    return this.#job;
  }

  protected onConnect(): void {
    if (!this.#auth) {
      const inherited = resolveInjectedAuth(this);
      if (inherited) this.#auth = inherited;
    }
    void this.#load();
  }

  public attributeChangedCallback(name: string): void {
    if (!this.isConnected) return;
    if (name === "draft-id") {
      this.#preview = undefined;
      this.#job = undefined;
      this.#confirmOpen = false;
      this.#confirmText = "";
      void this.#load();
      return;
    }
    this.render();
  }

  #activity(detail: HonuaStudioGpActivityDetail): void {
    this.dispatchTypedEvent<HonuaStudioGpActivityDetail>("honua-studio-gp-activity", detail);
  }

  async #load(): Promise<void> {
    const token = ++this.#loadToken;
    this.#error = undefined;
    const draftId = this.draftId;
    if (!draftId) {
      this.#draft = undefined;
      this.render();
      return;
    }
    this.#draftLoading = true;
    this.render();
    try {
      const draft = await this.client.getDraft(draftId);
      if (token !== this.#loadToken) return;
      this.#draft = draft;
      this.#activity({ kind: "draft-loaded", draftId });
      this.#resumeJobFromStorage(draftId);
    } catch (error) {
      if (token !== this.#loadToken) return;
      this.#error = describeError(error);
    } finally {
      if (token === this.#loadToken) this.#draftLoading = false;
    }
    if (token === this.#loadToken) this.render();
  }

  /** Reload-resume by job id (REQ-003): a stored job ref for THIS draft resumes monitoring with one status poll — never a loop, never a timer. */
  #resumeJobFromStorage(draftId: string): void {
    const storage = safeSessionStorage();
    const jobId = storage?.getItem(sessionStorageKey(draftId));
    if (!jobId) return;
    void this.#refreshJobStatus(jobId);
  }

  #persistJobRef(draftId: string, jobId: string): void {
    safeSessionStorage()?.setItem(sessionStorageKey(draftId), jobId);
  }

  /** `honua_studio_validate_draft`-equivalent REST call. Envelope-only server-side — see `gpValidationCaveat()`. */
  public async validateDraft(): Promise<void> {
    if (!this.#draft) return;
    try {
      await this.client.validateDraft(this.#draft.draftId);
      this.#draft = await this.client.getDraft(this.#draft.draftId);
      this.#activity({ kind: "draft-validated", draftId: this.#draft.draftId });
      this.#actionMessage = `Validation: ${this.#draft.validation?.status ?? "unknown"}.`;
    } catch (error) {
      this.#error = describeError(error);
    }
    this.render();
  }

  /** REQ-002: mandatory before the Execute button appears at all. Planning-only for `gp` — see `gpValidationCaveat()`. */
  public async previewPlan(): Promise<void> {
    if (!this.#draft) return;
    this.#previewLoading = true;
    this.render();
    try {
      this.#preview = await this.client.previewPlan(this.#draft.draftId);
      this.#draft = await this.client.getDraft(this.#draft.draftId);
      this.#activity({ kind: "preview-ready", draftId: this.#draft.draftId });
      this.#actionMessage = this.#preview.requiresJob
        ? "Preview plan ready — this package requires a batch job to execute."
        : "Preview plan ready.";
    } catch (error) {
      this.#error = describeError(error);
    } finally {
      this.#previewLoading = false;
    }
    this.render();
  }

  // -- THE HUMAN GATE: confirm-dialog open/cancel/submit ----------------------

  #openExecuteConfirm(): void {
    if (!this.#draft || !this.#preview) return;
    this.#confirmOpen = true;
    this.#confirmText = "";
    this.#actionMessage = undefined;
    this.render();
  }

  #cancelExecuteConfirm(): void {
    this.#confirmOpen = false;
    this.#confirmText = "";
    this.render();
  }

  /**
   * THE ONLY call site for `GpJobClient.submit()` in this package (spec
   * REQ-009 discipline, build item 3). Reachable ONLY via `#confirmSubmit`'s
   * `click` listener (`#bindListeners`), itself only enabled once
   * `#confirmText === this.#draft.packageKey` — see the module doc.
   */
  async #submitExecute(parameters?: Readonly<Record<string, unknown>>): Promise<void> {
    const draft = this.#draft;
    if (!draft || !this.#confirmOpen || this.#confirmText !== draft.packageKey) return;
    this.#confirmSubmitting = true;
    this.render();
    try {
      const job = await this.jobClient.submit({ draftId: draft.draftId, ...(parameters ? { parameters } : {}) });
      this.#job = job;
      this.#persistJobRef(draft.draftId, job.jobId);
      this.#activity({ kind: "job-submitted", draftId: draft.draftId, jobId: job.jobId });
      this.#actionMessage = `Batch job ${job.jobId} submitted.`;
      this.#confirmOpen = false;
      this.#confirmText = "";
    } catch (error) {
      this.#error = describeError(error);
      this.#activity({ kind: "error", draftId: draft.draftId, message: describeError(error) });
    } finally {
      this.#confirmSubmitting = false;
      this.render();
    }
  }

  /** One caller-driven status poll (NFR-001: no internal timers — a host/test decides when to check again). */
  public async checkStatus(): Promise<void> {
    const jobId = this.#job?.jobId;
    if (!jobId) return;
    await this.#refreshJobStatus(jobId);
  }

  async #refreshJobStatus(jobId: string): Promise<void> {
    this.#jobBusy = true;
    this.render();
    try {
      const snapshot = await this.jobClient.status(jobId);
      const wasTerminal = this.#job?.status === "successful" || this.#job?.status === "failed";
      this.#job = snapshot;
      if (snapshot.status === "successful" && !wasTerminal) {
        this.#activity({ kind: "job-completed", draftId: snapshot.draftId, jobId, message: "successful" });
      } else if (snapshot.status === "failed") {
        this.#activity({
          kind: "error",
          draftId: snapshot.draftId,
          jobId,
          message: snapshot.error?.message ?? "Batch execution failed.",
        });
      } else {
        this.#activity({ kind: "job-status", draftId: snapshot.draftId, jobId, message: snapshot.status });
      }
    } catch (error) {
      this.#error = describeError(error);
    } finally {
      this.#jobBusy = false;
    }
    this.render();
  }

  public async cancelJob(): Promise<void> {
    const jobId = this.#job?.jobId;
    if (!jobId) return;
    this.#jobBusy = true;
    this.render();
    try {
      const snapshot = await this.jobClient.cancel(jobId);
      this.#job = snapshot;
      this.#activity({ kind: "job-cancelled", draftId: snapshot.draftId, jobId, message: snapshot.status });
    } catch (error) {
      this.#error = describeError(error);
    } finally {
      this.#jobBusy = false;
    }
    this.render();
  }

  /** REQ-004: offers add-to-composition — dispatches only, never mutates composition state itself. See the module doc + `studio-app-element.ts`'s listener. */
  #addOutputToComposition(sourceId: string, title: string | undefined): void {
    this.dispatchTypedEvent<HonuaStudioGpAddOutputDetail>("honua-studio-gp-add-output", { sourceId, title });
    this.#actionMessage = `Requested "${title ?? sourceId}" be added to the composition.`;
    this.render();
  }

  protected render(): void {
    const label = this.getAttribute("label") ?? "Geoprocessing";
    this.setShadowHtml(`
      <style>${baseElementStyles()}${lifecycleStyles()}${gpPanelStyles()}</style>
      <section class="lifecycle hn-panel" part="panel" aria-label="${escapeHtml(label)}" data-testid="gp-panel">
        <h2 class="hn-panel-title">${escapeHtml(label)}</h2>
        <p class="gp-caveat" data-testid="gp-validation-caveat">${escapeHtml(gpValidationCaveat())}</p>
        ${this.#error ? `<p class="hn-error" data-testid="gp-panel-error">${escapeHtml(this.#error)}</p>` : ""}
        ${this.#actionMessage ? `<p class="hn-muted" data-testid="gp-panel-message">${escapeHtml(this.#actionMessage)}</p>` : ""}
        ${this.#renderDraftSection()}
        ${this.#renderPackageSection()}
        ${this.#renderPreviewSection()}
        ${this.#renderJobSection()}
        ${this.#renderConfirmDialog()}
      </section>
    `);
    this.#bindListeners();
  }

  #renderDraftSection(): string {
    if (this.#draftLoading) return `<p class="hn-muted" data-testid="gp-draft-loading">Loading draft…</p>`;
    if (!this.#draft) {
      return `<p class="lifecycle-empty" data-testid="gp-no-draft">No GP draft open.</p>`;
    }
    const draft = this.#draft;
    const validation = draft.validation ?? { status: "not-validated", diagnostics: [] };
    return `
      <div class="lifecycle-section" data-testid="gp-draft-status">
        <h3>Package: ${escapeHtml(draft.packageKey)}</h3>
        <p class="lifecycle-row-meta">
          <span class="hn-badge" data-testid="gp-panel-generation">generation ${draft.generation}</span>
          <span class="hn-badge hn-badge--status" data-testid="gp-panel-validation-status">${escapeHtml(validation.status)}</span>
        </p>
        <div class="lifecycle-actions">
          <button type="button" class="hn-btn hn-btn--sm" data-testid="gp-panel-validate">Validate</button>
          <button type="button" class="hn-btn hn-btn--sm" data-testid="gp-panel-preview" ${this.#previewLoading ? "disabled" : ""}>Preview plan</button>
        </div>
      </div>
    `;
  }

  #renderPackageSection(): string {
    const body = this.#draft?.envelope.body;
    if (!isGpPackageBody(body)) return "";
    const field = (testId: string, entries: readonly { readonly id: string; readonly title?: string }[]): string =>
      entries.length === 0
        ? `<p class="lifecycle-empty">None declared.</p>`
        : `<ul class="gp-fields" data-testid="${testId}">${entries
            .map(
              (entry) =>
                `<li class="gp-field-row"><span>${escapeHtml(entry.title ?? entry.id)}</span><span class="hn-muted">${escapeHtml(entry.id)}</span></li>`,
            )
            .join("")}</ul>`;
    return `
      <div class="lifecycle-section" data-testid="gp-package-section">
        <h3>Inputs</h3>
        ${field("gp-inputs", body.inputs)}
        <h3>Parameters</h3>
        ${
          body.parameters.length === 0
            ? `<p class="lifecycle-empty">None declared.</p>`
            : `<ul class="gp-fields" data-testid="gp-parameters">${body.parameters
                .map(
                  (parameter) =>
                    `<li class="gp-field-row"><span>${escapeHtml(parameter.title ?? parameter.id)}</span><span class="hn-muted">${escapeHtml(String(parameter.value))}${parameter.unit ? escapeHtml(` ${parameter.unit}`) : ""}</span></li>`,
                )
                .join("")}</ul>`
        }
        <h3>Outputs</h3>
        ${field("gp-outputs", body.outputs)}
      </div>
    `;
  }

  #renderPreviewSection(): string {
    if (this.#previewLoading) return `<p class="hn-muted" data-testid="gp-preview-loading">Fetching preview plan…</p>`;
    if (!this.#preview) return "";
    const preview = this.#preview;
    return `
      <div class="lifecycle-section" data-testid="gp-preview-section">
        <h3>Preview plan</h3>
        <p class="lifecycle-row-meta">
          <span class="hn-badge" data-testid="gp-preview-requires-job">${preview.requiresJob ? "requires a batch job" : "synchronous"}</span>
        </p>
        <ol class="gp-fields" data-testid="gp-preview-steps">
          ${preview.steps.map((step) => `<li class="gp-field-row"><span>${escapeHtml(step)}</span></li>`).join("")}
        </ol>
        ${
          preview.requiresJob
            ? `<div class="lifecycle-actions"><button type="button" class="hn-btn hn-btn--sm" data-testid="gp-execute-open">Execute…</button></div>`
            : ""
        }
      </div>
    `;
  }

  #renderJobSection(): string {
    if (!this.#job) return "";
    const job = this.#job;
    const percent = job.progress?.percent ?? 0;
    return `
      <div class="lifecycle-section" data-testid="gp-job-section">
        <h3>Batch job</h3>
        <p class="lifecycle-row-meta">
          <span class="hn-badge gp-status-badge" data-testid="gp-job-status" data-status="${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>
          <span data-testid="gp-job-id" class="hn-muted">${escapeHtml(job.jobId)}</span>
        </p>
        <div class="gp-progress"><div class="gp-progress-fill" style="width:${percent}%"></div></div>
        ${job.progress?.message ? `<p class="hn-muted" data-testid="gp-job-message">${escapeHtml(job.progress.message)}</p>` : ""}
        ${
          job.status === "failed" && job.error
            ? `<p class="hn-error" data-testid="gp-job-error">${escapeHtml(job.error.code)}: ${escapeHtml(job.error.message)}</p>`
            : ""
        }
        <div class="lifecycle-actions">
          ${job.status === "accepted" || job.status === "running" ? `<button type="button" class="hn-btn hn-btn--sm" data-testid="gp-job-check-status" ${this.#jobBusy ? "disabled" : ""}>Check status</button>` : ""}
          ${job.status === "accepted" || job.status === "running" ? `<button type="button" class="hn-btn hn-btn--sm" data-testid="gp-job-cancel" ${this.#jobBusy ? "disabled" : ""}>Cancel</button>` : ""}
        </div>
        ${this.#renderJobOutputs()}
      </div>
    `;
  }

  #renderJobOutputs(): string {
    const job = this.#job;
    if (!job || job.status !== "successful" || !job.result) return "";
    return `
      <ul class="gp-fields" data-testid="gp-job-outputs">
        ${job.result.outputs
          .map(
            (output) => `
              <li class="gp-field-row">
                <span>${escapeHtml(output.title ?? output.outputId)}</span>
                <button type="button" class="hn-btn hn-btn--sm" data-testid="gp-add-output" data-source-id="${escapeHtml(output.datasetId)}" data-title="${escapeHtml(output.title ?? output.outputId)}">Add to composition</button>
              </li>
            `,
          )
          .join("")}
      </ul>
    `;
  }

  #renderConfirmDialog(): string {
    if (!this.#confirmOpen || !this.#draft) return "";
    const expectedKey = this.#draft.packageKey;
    const matches = this.#confirmText === expectedKey && expectedKey !== "";
    return `
      <div class="lifecycle-confirm" data-testid="gp-confirm-dialog" role="alertdialog" aria-label="Confirm batch execution">
        <p><strong>Confirm batch execution of ${escapeHtml(expectedKey)}</strong></p>
        <p class="hn-muted">
          This submits a batch job for asynchronous server-side execution. Type the package key
          <strong data-testid="gp-confirm-expected-key">${escapeHtml(expectedKey)}</strong> to confirm.
        </p>
        <input
          type="text"
          data-testid="gp-confirm-input"
          autocomplete="off"
          value="${escapeHtml(this.#confirmText)}"
          placeholder="${escapeHtml(expectedKey)}"
        />
        <div class="lifecycle-actions">
          <button
            type="button"
            class="hn-btn hn-btn--sm"
            data-testid="gp-confirm-submit"
            ${matches && !this.#confirmSubmitting ? "" : "disabled"}
          >Confirm execute</button>
          <button type="button" class="hn-btn hn-btn--sm" data-testid="gp-confirm-cancel">Cancel</button>
        </div>
      </div>
    `;
  }

  #bindListeners(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const signal = this.connectedSignal;

    root
      .querySelector('[data-testid="gp-panel-validate"]')
      ?.addEventListener("click", () => void this.validateDraft(), { signal });
    root
      .querySelector('[data-testid="gp-panel-preview"]')
      ?.addEventListener("click", () => void this.previewPlan(), { signal });
    root
      .querySelector('[data-testid="gp-execute-open"]')
      ?.addEventListener("click", () => this.#openExecuteConfirm(), { signal });
    root
      .querySelector('[data-testid="gp-job-check-status"]')
      ?.addEventListener("click", () => void this.checkStatus(), { signal });
    root
      .querySelector('[data-testid="gp-job-cancel"]')
      ?.addEventListener("click", () => void this.cancelJob(), { signal });

    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-testid="gp-add-output"]')) {
      button.addEventListener(
        "click",
        () => {
          const sourceId = button.dataset.sourceId;
          if (sourceId) this.#addOutputToComposition(sourceId, button.dataset.title);
        },
        { signal },
      );
    }

    // -- THE HUMAN GATE: the only listeners that can reach #submitExecute --
    const confirmInput = root.querySelector<HTMLInputElement>('[data-testid="gp-confirm-input"]');
    confirmInput?.addEventListener(
      "input",
      () => {
        this.#confirmText = confirmInput.value;
        this.render();
      },
      { signal },
    );
    root
      .querySelector('[data-testid="gp-confirm-submit"]')
      ?.addEventListener("click", () => void this.#submitExecute(), { signal });
    root
      .querySelector('[data-testid="gp-confirm-cancel"]')
      ?.addEventListener("click", () => this.#cancelExecuteConfirm(), { signal });
  }
}
