/**
 * `<honua-studio-lifecycle-panel>` (honua-studio#9 build item 2) — the open
 * item/draft view: draft status (generation, validation summary), save-as-
 * version, version list, version comparison (hash/dependencies/validation/
 * provenance diff per the comparison endpoint shape), reopen-as-draft, and
 * the publish/rollback flows.
 *
 * ## THE HUMAN GATE — spec REQ-009 (read this before editing this file)
 *
 * "Publish, share, embed, and any action that widens exposure are
 * HUMAN-CONFIRMED gates the agent can propose but never invoke." This
 * element is where that gate LIVES for Studio's package lifecycle:
 *
 *  - `honua_studio_propose_publication` (server PR #3016, `mcp/studio-tools.ts`)
 *    only ever writes `envelope.publicationIntent` onto a DRAFT. When this
 *    panel's loaded draft carries a non-null `publicationIntent`, it renders
 *    a **pending-proposal banner** (`#renderPendingPublicationBanner`) —
 *    informational only, it calls nothing.
 *  - Turning that proposal into an actual publish (or running a rollback)
 *    requires opening this panel's own confirm dialog
 *    (`#openPublishConfirm`/`#openRollbackConfirm`) and TYPING the exact
 *    package key into `#confirmInput` — `#submitConfirm` is wired to a
 *    single `click` listener on `#confirmSubmit`, itself only enabled once
 *    `#confirmText === this.#draft.packageKey` (checked on the input's own
 *    `input` event). ONLY `#submitConfirm` calls
 *    `client.requestPublish`/`client.requestRollback`
 *    (`../lifecycle/lifecycle-client.ts`) — there is no other call site in
 *    this file, and this file is the only caller of those two methods
 *    anywhere in this package.
 *  - No chat, MCP tool-call, or activity-log event listener anywhere in
 *    this class (or anywhere in `src/mcp/**`, `src/chat/**`,
 *    `src/composition/**`) reaches `#submitConfirm` or the two gated client
 *    methods — verified both statically and at runtime by
 *    `test/lifecycle/human-gate.test.ts`.
 *
 * @module
 */
import { StudioLifecycleClient } from "../lifecycle/lifecycle-client.js";
import type {
  StudioContentVersion,
  StudioPackageDraft,
  StudioPublicationIntent,
  StudioRollbackPointer,
  StudioVersionComparison,
} from "../lifecycle/lifecycle-types.js";
import { HonuaStudioElementBase } from "./base-element.js";
import { resolveInjectedAuth } from "./session.js";
import { baseElementStyles, lifecycleStyles } from "./styles.js";
import type { AuthSession, HonuaStudioLifecycleActivityDetail } from "./types.js";

type PendingConfirm =
  | { readonly kind: "publish"; readonly versionId: string; readonly intent: StudioPublicationIntent | undefined }
  | { readonly kind: "rollback"; readonly targetVersionId: string; readonly pointer: StudioRollbackPointer };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

export class HonuaStudioLifecyclePanelElement extends HonuaStudioElementBase {
  static get observedAttributes(): string[] {
    return ["label", "item-id", "draft-id"];
  }

  #auth: AuthSession | undefined;
  #client: StudioLifecycleClient | undefined;

  #itemId: string | undefined;
  #draft: StudioPackageDraft | undefined;
  #versions: readonly StudioContentVersion[] = [];
  #draftLoading = false;
  #versionsLoading = false;
  #error: string | undefined;
  #actionMessage: string | undefined;

  #compareLeftId: string | undefined;
  #compareRightId: string | undefined;
  #comparison: StudioVersionComparison | undefined;

  /** The typed-confirmation gate's current target — `undefined` when the confirm dialog isn't open. Never set except by `#openPublishConfirm`/`#openRollbackConfirm`, both wired ONLY to a shadow-DOM button click. */
  #pendingConfirm: PendingConfirm | undefined;
  #confirmText = "";
  #confirmSubmitting = false;

  /**
   * Monotonic guard against overlapping `#load()` calls: setting `.itemId`
   * and `.draftId` in quick succession (e.g. `openItem({ itemId, draftId })`
   * helpers that assign both) fires `attributeChangedCallback` — and
   * therefore `#load()` — once per attribute, synchronously. Each `#load()`
   * call captures its own token and bails after every `await` once a newer
   * call has started, so only the LAST attribute change's fetch ever
   * mutates state or renders — never a stale one racing ahead of it.
   */
  #loadToken = 0;

  public get auth(): AuthSession | undefined {
    return this.#auth;
  }

  public set auth(auth: AuthSession | undefined) {
    this.#auth = auth;
    this.#client = undefined;
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

  /** The content item this panel targets — mirrors the `item-id` attribute. */
  public get itemId(): string | undefined {
    return this.getAttribute("item-id") ?? undefined;
  }

  public set itemId(value: string | undefined) {
    if (value === undefined) this.removeAttribute("item-id");
    else this.setAttribute("item-id", value);
  }

  /** The draft this panel is editing — mirrors the `draft-id` attribute. */
  public get draftId(): string | undefined {
    return this.getAttribute("draft-id") ?? undefined;
  }

  public set draftId(value: string | undefined) {
    if (value === undefined) this.removeAttribute("draft-id");
    else this.setAttribute("draft-id", value);
  }

  /** The most recently loaded draft, if any — read-only, refreshed by `#load()`. */
  public get draft(): StudioPackageDraft | undefined {
    return this.#draft;
  }

  /** The most recently loaded version list for `.itemId`, oldest first — read-only. */
  public get versions(): readonly StudioContentVersion[] {
    return this.#versions;
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
    if (name === "item-id" || name === "draft-id") {
      this.#pendingConfirm = undefined;
      this.#comparison = undefined;
      void this.#load();
      return;
    }
    this.render();
  }

  #activity(detail: HonuaStudioLifecycleActivityDetail): void {
    this.dispatchTypedEvent<HonuaStudioLifecycleActivityDetail>("honua-studio-lifecycle-activity", detail);
  }

  async #load(): Promise<void> {
    const token = ++this.#loadToken;
    this.#error = undefined;
    const draftId = this.draftId;
    const attrItemId = this.itemId;
    if (draftId) {
      this.#draftLoading = true;
      this.render();
      try {
        const draft = await this.client.getDraft(draftId);
        if (token !== this.#loadToken) return; // superseded by a newer .itemId/.draftId change
        this.#draft = draft;
        this.#itemId = attrItemId ?? draft.itemId;
        this.#activity({ kind: "draft-loaded", draftId, itemId: this.#itemId });
      } catch (error) {
        if (token !== this.#loadToken) return;
        this.#error = describeError(error);
      } finally {
        if (token === this.#loadToken) this.#draftLoading = false;
      }
    } else {
      this.#draft = undefined;
      this.#itemId = attrItemId;
    }
    if (token !== this.#loadToken) return;
    await this.#loadVersions(token);
    if (token !== this.#loadToken) return;
    this.render();
  }

  async #loadVersions(token = this.#loadToken): Promise<void> {
    if (!this.#itemId) {
      this.#versions = [];
      return;
    }
    this.#versionsLoading = true;
    this.render();
    try {
      const response = await this.client.listVersions(this.#itemId);
      if (token !== this.#loadToken) return; // superseded — do not overwrite newer state
      this.#versions = response.versions;
    } catch (error) {
      if (token !== this.#loadToken) return;
      this.#error = describeError(error);
    } finally {
      if (token === this.#loadToken) this.#versionsLoading = false;
    }
  }

  /** Re-runs validation on the loaded draft and persists the summary (server-side; the draft's generation advances). */
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

  /** Saves the loaded draft as an immutable content version. Never publishes — see the module doc. */
  public async saveAsVersion(): Promise<void> {
    if (!this.#draft) return;
    try {
      const version = await this.client.saveAsVersion(this.#draft.draftId);
      this.#draft = await this.client.getDraft(this.#draft.draftId);
      await this.#loadVersions();
      this.#activity({ kind: "version-saved", draftId: this.#draft.draftId, versionId: version.versionId });
      this.#actionMessage = `Saved version ${version.versionNumber}.`;
    } catch (error) {
      this.#error = describeError(error);
    }
    this.render();
  }

  /** Copies an immutable version into a new mutable draft and switches this panel to it. Never publishes or moves a pointer. */
  public async reopenVersion(versionId: string): Promise<void> {
    if (!this.#itemId) return;
    try {
      const draft = await this.client.reopenVersion(this.#itemId, versionId);
      this.#activity({ kind: "version-reopened", itemId: this.#itemId, versionId, draftId: draft.draftId });
      this.draftId = draft.draftId; // triggers attributeChangedCallback -> #load()
    } catch (error) {
      this.#error = describeError(error);
      this.render();
    }
  }

  #setCompare(side: "left" | "right", versionId: string): void {
    if (side === "left") this.#compareLeftId = versionId;
    else this.#compareRightId = versionId;
    this.#comparison = undefined;
    this.render();
  }

  public async compareSelected(): Promise<void> {
    if (!this.#itemId || !this.#compareLeftId || !this.#compareRightId) return;
    try {
      this.#comparison = await this.client.compareVersions(this.#itemId, {
        leftVersionId: this.#compareLeftId,
        rightVersionId: this.#compareRightId,
      });
      this.#activity({ kind: "comparison-ready", itemId: this.#itemId });
    } catch (error) {
      this.#error = describeError(error);
    }
    this.render();
  }

  // -- THE HUMAN GATE: confirm-dialog open/cancel/submit ----------------------
  // See the module doc. `#openPublishConfirm`/`#openRollbackConfirm` are
  // wired ONLY from `#bindListeners`'s `click` handlers on this element's
  // own shadow-DOM buttons.

  #openPublishConfirm(versionId: string): void {
    const version = this.#versions.find((candidate) => candidate.versionId === versionId);
    const intent = version?.envelope.publicationIntent ?? this.#draft?.envelope.publicationIntent ?? undefined;
    this.#pendingConfirm = { kind: "publish", versionId, intent };
    this.#confirmText = "";
    this.#actionMessage = undefined;
    this.render();
  }

  #openRollbackConfirm(targetVersionId: string): void {
    this.#pendingConfirm = { kind: "rollback", targetVersionId, pointer: "both" };
    this.#confirmText = "";
    this.#actionMessage = undefined;
    this.render();
  }

  #cancelConfirm(): void {
    this.#pendingConfirm = undefined;
    this.#confirmText = "";
    this.render();
  }

  #confirmPackageKey(): string | undefined {
    return this.#draft?.packageKey ?? this.#versions.find((v) => v.itemId === this.#itemId)?.packageKey;
  }

  /**
   * THE ONLY call site for `requestPublish`/`requestRollback` in this
   * package (spec REQ-009). Reachable ONLY via `#confirmSubmit`'s `click`
   * listener (`#bindListeners`), itself only enabled once
   * `#confirmText === this.#confirmPackageKey()` — see the module doc.
   */
  async #submitConfirm(): Promise<void> {
    const pending = this.#pendingConfirm;
    const expectedKey = this.#confirmPackageKey();
    if (!pending || !this.#itemId || !expectedKey || this.#confirmText !== expectedKey) return;
    this.#confirmSubmitting = true;
    this.render();
    try {
      if (pending.kind === "publish") {
        const request = await this.client.requestPublish(this.#itemId, pending.versionId, {
          intent: pending.intent,
        });
        this.#activity({
          kind: request.status === "accepted" ? "publish-requested" : "publish-rejected",
          itemId: this.#itemId,
          versionId: pending.versionId,
          message: request.status,
        });
        this.#actionMessage =
          request.status === "accepted"
            ? `Published version ${pending.versionId}.`
            : `Publish request rejected (${request.status}) — the version's validation status must be valid or warning.`;
      } else {
        const request = await this.client.requestRollback(this.#itemId, {
          targetVersionId: pending.targetVersionId,
          pointer: pending.pointer,
        });
        this.#activity({
          kind: "rollback-requested",
          itemId: this.#itemId,
          versionId: pending.targetVersionId,
          message: pending.pointer,
        });
        this.#actionMessage = `Rolled back (${pending.pointer}) to version ${request.targetVersionId}.`;
      }
      this.#pendingConfirm = undefined;
      this.#confirmText = "";
      // Refresh the draft (its packageKey/generation are unaffected, but a
      // host watching `.draft` should see the same object identity change
      // it would after any other server round trip) and the version list
      // (a publish/rollback moves item pointers this panel doesn't render
      // directly today, but a future version-list "published" marker reads
      // from a fresh fetch, not a stale one).
      if (this.#draft) this.#draft = await this.client.getDraft(this.#draft.draftId);
      await this.#loadVersions();
    } catch (error) {
      this.#error = describeError(error);
      this.#activity({ kind: "error", itemId: this.#itemId, message: describeError(error) });
    } finally {
      this.#confirmSubmitting = false;
      this.render();
    }
  }

  protected render(): void {
    const label = this.getAttribute("label") ?? "Lifecycle";
    this.setShadowHtml(`
      <style>${baseElementStyles()}${lifecycleStyles()}</style>
      <section class="lifecycle hn-panel" part="panel" aria-label="${escapeHtml(label)}" data-testid="lifecycle-panel">
        <h2 class="hn-panel-title">${escapeHtml(label)}</h2>
        ${this.#error ? `<p class="hn-error" data-testid="lifecycle-panel-error">${escapeHtml(this.#error)}</p>` : ""}
        ${this.#actionMessage ? `<p class="hn-muted" data-testid="lifecycle-panel-message">${escapeHtml(this.#actionMessage)}</p>` : ""}
        ${this.#renderDraftSection()}
        ${this.#renderPendingPublicationBanner()}
        ${this.#renderVersionsSection()}
        ${this.#renderComparisonSection()}
        ${this.#renderConfirmDialog()}
      </section>
    `);
    this.#bindListeners();
  }

  #renderDraftSection(): string {
    if (this.#draftLoading) return `<p class="hn-muted" data-testid="lifecycle-draft-loading">Loading draft…</p>`;
    if (!this.#draft) {
      return `<p class="lifecycle-empty" data-testid="lifecycle-no-draft">No draft open. Reopen a version, or open a draft from the content browser.</p>`;
    }
    const draft = this.#draft;
    const validation = draft.validation ?? { status: "not-validated", diagnostics: [] };
    return `
      <div class="lifecycle-section" data-testid="lifecycle-draft-status">
        <h3>Draft: ${escapeHtml(draft.packageKey)}</h3>
        <p class="lifecycle-row-meta">
          <span class="hn-badge" data-testid="lifecycle-panel-generation">generation ${draft.generation}</span>
          <span class="hn-badge hn-badge--status" data-testid="lifecycle-panel-validation-status">${escapeHtml(validation.status)}</span>
        </p>
        ${
          validation.diagnostics && validation.diagnostics.length > 0
            ? `<ul class="lifecycle-table" data-testid="lifecycle-validation-diagnostics">${validation.diagnostics
                .map(
                  (diagnostic) =>
                    `<li class="lifecycle-row"><span>${escapeHtml(diagnostic.severity)}: ${escapeHtml(diagnostic.message)}</span></li>`,
                )
                .join("")}</ul>`
            : ""
        }
        <div class="lifecycle-actions">
          <button type="button" class="hn-btn hn-btn--sm" data-testid="lifecycle-panel-validate">Validate</button>
          <button type="button" class="hn-btn hn-btn--sm" data-testid="lifecycle-panel-save-version">Save as version</button>
        </div>
      </div>
    `;
  }

  #renderPendingPublicationBanner(): string {
    const intent = this.#draft?.envelope.publicationIntent;
    if (!intent) return "";
    const latestVersion = this.#versions[this.#versions.length - 1];
    return `
      <div class="lifecycle-banner" data-testid="lifecycle-pending-publication-banner">
        <span class="lifecycle-banner-title">Publication proposed — human confirmation required</span>
        <ul class="lifecycle-diff-grid" data-testid="lifecycle-pending-intent">
          ${intent.route ? `<li>route: ${escapeHtml(intent.route)}</li>` : ""}
          ${intent.visibility ? `<li>visibility: ${escapeHtml(intent.visibility)}</li>` : ""}
          ${intent.embed !== undefined ? `<li>embed: ${intent.embed}</li>` : ""}
          ${(intent as { note?: string }).note ? `<li>note: ${escapeHtml(String((intent as { note?: string }).note))}</li>` : ""}
        </ul>
        <p class="hn-muted">
          This intent was proposed by the assistant. Nothing has been published — review and, if you agree, save a
          version (if needed) and confirm publish below.
        </p>
        ${
          latestVersion
            ? `<button type="button" class="hn-btn hn-btn--sm" data-testid="lifecycle-review-publish" data-version-id="${escapeHtml(latestVersion.versionId)}">Review &amp; publish latest version</button>`
            : `<p class="hn-muted" data-testid="lifecycle-review-publish-blocked">Save this draft as a version before it can be published.</p>`
        }
      </div>
    `;
  }

  #renderVersionsSection(): string {
    if (this.#versionsLoading) {
      return `<p class="hn-muted" data-testid="lifecycle-versions-loading">Loading versions…</p>`;
    }
    if (this.#versions.length === 0) {
      return `<p class="lifecycle-empty" data-testid="lifecycle-versions-empty">No immutable versions yet.</p>`;
    }
    const rows = this.#versions
      .map(
        (version) => `
          <li class="lifecycle-row" data-testid="lifecycle-version-row" data-version-id="${escapeHtml(version.versionId)}">
            <div class="lifecycle-row-main">
              <span class="lifecycle-row-title">v${version.versionNumber} · ${escapeHtml(shortHash(version.contentHash))}</span>
              <span class="lifecycle-row-meta hn-muted">
                <span class="hn-badge hn-badge--status">${escapeHtml(version.validation.status)}</span>
                <span>${escapeHtml(version.createdAt)}</span>
              </span>
            </div>
            <div class="lifecycle-actions">
              <label><input type="radio" name="compare-left" data-testid="lifecycle-compare-left" value="${escapeHtml(version.versionId)}" ${this.#compareLeftId === version.versionId ? "checked" : ""}/> left</label>
              <label><input type="radio" name="compare-right" data-testid="lifecycle-compare-right" value="${escapeHtml(version.versionId)}" ${this.#compareRightId === version.versionId ? "checked" : ""}/> right</label>
              <button type="button" class="hn-btn hn-btn--sm" data-testid="lifecycle-version-reopen" data-version-id="${escapeHtml(version.versionId)}">Reopen as draft</button>
              <button type="button" class="hn-btn hn-btn--sm" data-testid="lifecycle-version-publish" data-version-id="${escapeHtml(version.versionId)}">Publish…</button>
              <button type="button" class="hn-btn hn-btn--sm" data-testid="lifecycle-version-rollback" data-version-id="${escapeHtml(version.versionId)}">Roll back…</button>
            </div>
          </li>
        `,
      )
      .join("");
    return `
      <div class="lifecycle-section" data-testid="lifecycle-versions-section">
        <h3>Versions</h3>
        <ul class="lifecycle-table" data-testid="lifecycle-versions-list">${rows}</ul>
        <button type="button" class="hn-btn hn-btn--sm" data-testid="lifecycle-compare-button" ${
          this.#compareLeftId && this.#compareRightId && this.#compareLeftId !== this.#compareRightId ? "" : "disabled"
        }>Compare selected</button>
      </div>
    `;
  }

  #renderComparisonSection(): string {
    if (!this.#comparison) return "";
    const c = this.#comparison;
    const field = (name: string, equal: boolean): string =>
      `<li class="lifecycle-diff-item" data-equal="${equal}">${name}: ${equal ? "same" : "different"}</li>`;
    return `
      <div class="lifecycle-section" data-testid="lifecycle-comparison">
        <h3>Comparison</h3>
        <ul class="lifecycle-diff-grid">
          ${field("content hash", c.contentEqual)}
          ${field("dependencies", c.dependenciesEqual)}
          ${field("validation", c.validationEqual)}
          ${field("provenance", c.provenanceEqual)}
        </ul>
        ${
          c.changes.length > 0
            ? `<p data-testid="lifecycle-comparison-changes">Changed: ${c.changes.map(escapeHtml).join(", ")}</p>`
            : `<p data-testid="lifecycle-comparison-changes">No differences.</p>`
        }
      </div>
    `;
  }

  #renderConfirmDialog(): string {
    const pending = this.#pendingConfirm;
    if (!pending) return "";
    const expectedKey = this.#confirmPackageKey() ?? "";
    const matches = this.#confirmText === expectedKey && expectedKey !== "";
    const title =
      pending.kind === "publish"
        ? `Confirm publish of version ${pending.versionId}`
        : `Confirm rollback (${pending.pointer}) to version ${pending.targetVersionId}`;
    return `
      <div class="lifecycle-confirm" data-testid="lifecycle-confirm-dialog" role="alertdialog" aria-label="${escapeHtml(title)}">
        <p><strong>${escapeHtml(title)}</strong></p>
        <p class="hn-muted">
          This action is irreversible except by a further rollback. Type the package key
          <strong data-testid="lifecycle-confirm-expected-key">${escapeHtml(expectedKey)}</strong> to confirm.
        </p>
        <input
          type="text"
          data-testid="lifecycle-confirm-input"
          autocomplete="off"
          value="${escapeHtml(this.#confirmText)}"
          placeholder="${escapeHtml(expectedKey)}"
        />
        <div class="lifecycle-actions">
          <button
            type="button"
            class="hn-btn hn-btn--sm"
            data-testid="lifecycle-confirm-submit"
            ${matches && !this.#confirmSubmitting ? "" : "disabled"}
          >${pending.kind === "publish" ? "Confirm publish" : "Confirm rollback"}</button>
          <button type="button" class="hn-btn hn-btn--sm" data-testid="lifecycle-confirm-cancel">Cancel</button>
        </div>
      </div>
    `;
  }

  #bindListeners(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const signal = this.connectedSignal;

    root
      .querySelector('[data-testid="lifecycle-panel-validate"]')
      ?.addEventListener("click", () => void this.validateDraft(), { signal });
    root
      .querySelector('[data-testid="lifecycle-panel-save-version"]')
      ?.addEventListener("click", () => void this.saveAsVersion(), { signal });
    root.querySelector<HTMLButtonElement>('[data-testid="lifecycle-review-publish"]')?.addEventListener(
      "click",
      (event) => {
        const versionId = (event.currentTarget as HTMLButtonElement).dataset.versionId;
        if (versionId) this.#openPublishConfirm(versionId);
      },
      { signal },
    );

    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-testid="lifecycle-version-reopen"]')) {
      button.addEventListener(
        "click",
        () => {
          const versionId = button.dataset.versionId;
          if (versionId) void this.reopenVersion(versionId);
        },
        { signal },
      );
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-testid="lifecycle-version-publish"]')) {
      button.addEventListener(
        "click",
        () => {
          const versionId = button.dataset.versionId;
          if (versionId) this.#openPublishConfirm(versionId);
        },
        { signal },
      );
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-testid="lifecycle-version-rollback"]')) {
      button.addEventListener(
        "click",
        () => {
          const versionId = button.dataset.versionId;
          if (versionId) this.#openRollbackConfirm(versionId);
        },
        { signal },
      );
    }
    for (const radio of root.querySelectorAll<HTMLInputElement>('[data-testid="lifecycle-compare-left"]')) {
      radio.addEventListener("change", () => this.#setCompare("left", radio.value), { signal });
    }
    for (const radio of root.querySelectorAll<HTMLInputElement>('[data-testid="lifecycle-compare-right"]')) {
      radio.addEventListener("change", () => this.#setCompare("right", radio.value), { signal });
    }
    root
      .querySelector('[data-testid="lifecycle-compare-button"]')
      ?.addEventListener("click", () => void this.compareSelected(), { signal });

    // -- THE HUMAN GATE: the only listeners that can reach #submitConfirm --
    const confirmInput = root.querySelector<HTMLInputElement>('[data-testid="lifecycle-confirm-input"]');
    confirmInput?.addEventListener(
      "input",
      () => {
        this.#confirmText = confirmInput.value;
        this.render();
      },
      { signal },
    );
    root
      .querySelector('[data-testid="lifecycle-confirm-submit"]')
      ?.addEventListener("click", () => void this.#submitConfirm(), { signal });
    root
      .querySelector('[data-testid="lifecycle-confirm-cancel"]')
      ?.addEventListener("click", () => this.#cancelConfirm(), { signal });
  }
}
