/**
 * `<honua-studio-content-browser>` (honua-studio#9 build item 1) — lists
 * Studio content items (immutable, saved) and package drafts (mutable),
 * backed by `StudioLifecycleClient.listContentItems`/`listPackageDrafts`
 * (`src/lifecycle/lifecycle-client.ts`), which speak the enumeration shapes
 * server PR #3014 added: `family`/`workspaceId`/`owner`/`state`/`q` filters,
 * cursor pagination, and the joined publication badge on content-item rows.
 *
 * Read-only surface — the only mutating thing this element does is fire
 * `honua-studio-open-item` when a user picks "Open" on a row, so a host
 * (`studio-app-element.ts`) can switch to `<honua-studio-lifecycle-panel>`.
 * Nothing here calls `requestPublish`/`requestRollback` — see
 * `lifecycle-client.ts`'s module doc.
 *
 * @module
 */
import { StudioLifecycleClient } from "../lifecycle/lifecycle-client.js";
import type {
  StudioContentItemState,
  StudioContentItemSummary,
  StudioPackageDraft,
  StudioPackageFamily,
} from "../lifecycle/lifecycle-types.js";
import { STUDIO_PACKAGE_FAMILIES } from "../lifecycle/lifecycle-types.js";
import { getRuntimeConfig } from "../runtime-config.js";
import { HonuaStudioElementBase } from "./base-element.js";
import { resolveInjectedAuth } from "./session.js";
import { baseElementStyles, lifecycleStyles } from "./styles.js";
import type { AuthSession, HonuaStudioOpenItemDetail } from "./types.js";

const STATE_OPTIONS: readonly (StudioContentItemState | "all")[] = ["all", "draft", "current", "published"];
const SEARCH_DEBOUNCE_MS = 250;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class HonuaStudioContentBrowserElement extends HonuaStudioElementBase {
  static get observedAttributes(): string[] {
    return ["label"];
  }

  #auth: AuthSession | undefined;
  #client: StudioLifecycleClient | undefined;

  #family: StudioPackageFamily | "all" = "all";
  #state: StudioContentItemState | "all" = "all";
  #search = "";
  #searchTimer: ReturnType<typeof setTimeout> | undefined;

  #items: readonly StudioContentItemSummary[] = [];
  #itemsCursor: string | null = null;
  #itemsTotal = 0;
  #itemsLoading = false;
  #itemsError: string | undefined;

  #drafts: readonly StudioPackageDraft[] = [];
  #draftsCursor: string | null = null;
  #draftsTotal = 0;
  #draftsLoading = false;
  #draftsError: string | undefined;

  /** Direct `AuthSession` override — falls back to the nearest `<honua-studio-app>` ancestor's `.auth`, same as `<honua-studio-canvas>`. */
  public get auth(): AuthSession | undefined {
    return this.#auth;
  }

  public set auth(auth: AuthSession | undefined) {
    this.#auth = auth;
    this.#client = undefined;
    if (this.isConnected) this.refresh();
  }

  /** The lifecycle REST client this browser reads from. Defaults to a fresh `StudioLifecycleClient` reading `/api`, bearer-attached via `.auth`. Override for fixtures/tests. */
  public get client(): StudioLifecycleClient {
    if (!this.#client)
      this.#client = new StudioLifecycleClient({ baseUrl: getRuntimeConfig().serverBaseUrl, auth: this.#auth });
    return this.#client;
  }

  public set client(client: StudioLifecycleClient) {
    this.#client = client;
    if (this.isConnected) this.refresh();
  }

  protected onConnect(): void {
    if (!this.#auth) {
      const inherited = resolveInjectedAuth(this);
      if (inherited) this.#auth = inherited;
    }
    this.refresh();
  }

  protected onDisconnect(): void {
    if (this.#searchTimer) clearTimeout(this.#searchTimer);
    this.#searchTimer = undefined;
  }

  /** Reloads both lists from the start (clears cursors). Safe to call any time; a host wanting a manual refresh button can call this directly. */
  public refresh(): void {
    this.#itemsCursor = null;
    this.#drafts = [];
    this.#draftsCursor = null;
    this.#items = [];
    void this.#loadItems(true);
    void this.#loadDrafts(true);
  }

  async #loadItems(reset: boolean): Promise<void> {
    this.#itemsLoading = true;
    this.#itemsError = undefined;
    this.render();
    try {
      const response = await this.client.listContentItems({
        families: this.#family === "all" ? undefined : [this.#family],
        states: this.#state === "all" ? undefined : [this.#state],
        q: this.#search || undefined,
        cursor: reset ? undefined : (this.#itemsCursor ?? undefined),
        limit: 25,
      });
      this.#items = reset ? response.items : [...this.#items, ...response.items];
      this.#itemsCursor = response.nextCursor;
      this.#itemsTotal = response.total;
    } catch (error) {
      this.#itemsError = describeError(error);
    } finally {
      this.#itemsLoading = false;
      this.render();
    }
  }

  async #loadDrafts(reset: boolean): Promise<void> {
    this.#draftsLoading = true;
    this.#draftsError = undefined;
    this.render();
    try {
      const response = await this.client.listPackageDrafts({
        families: this.#family === "all" ? undefined : [this.#family],
        q: this.#search || undefined,
        cursor: reset ? undefined : (this.#draftsCursor ?? undefined),
        limit: 25,
      });
      this.#drafts = reset ? response.items : [...this.#drafts, ...response.items];
      this.#draftsCursor = response.nextCursor;
      this.#draftsTotal = response.total;
    } catch (error) {
      this.#draftsError = describeError(error);
    } finally {
      this.#draftsLoading = false;
      this.render();
    }
  }

  #setSearch(value: string): void {
    this.#search = value;
    if (this.#searchTimer) clearTimeout(this.#searchTimer);
    this.#searchTimer = setTimeout(() => {
      this.#itemsCursor = null;
      this.#draftsCursor = null;
      void this.#loadItems(true);
      void this.#loadDrafts(true);
    }, SEARCH_DEBOUNCE_MS);
  }

  #openItem(detail: HonuaStudioOpenItemDetail): void {
    this.dispatchTypedEvent<HonuaStudioOpenItemDetail>("honua-studio-open-item", detail);
  }

  protected render(): void {
    const label = this.getAttribute("label") ?? "Content";
    this.setShadowHtml(`
      <style>${baseElementStyles()}${lifecycleStyles()}</style>
      <section class="lifecycle hn-panel" part="panel" aria-label="${escapeHtml(label)}" data-testid="content-browser">
        <h2 class="hn-panel-title">${escapeHtml(label)}</h2>
        <div class="lifecycle-filters" role="group" aria-label="Filters">
          <input
            type="search"
            data-testid="content-browser-search"
            placeholder="Search package key…"
            value="${escapeHtml(this.#search)}"
          />
          <select data-testid="content-browser-family-filter" aria-label="Family">
            <option value="all" ${this.#family === "all" ? "selected" : ""}>All families</option>
            ${STUDIO_PACKAGE_FAMILIES.map(
              (family) => `<option value="${family}" ${this.#family === family ? "selected" : ""}>${family}</option>`,
            ).join("")}
          </select>
          <select data-testid="content-browser-state-filter" aria-label="State">
            ${STATE_OPTIONS.map(
              (state) => `<option value="${state}" ${this.#state === state ? "selected" : ""}>${state}</option>`,
            ).join("")}
          </select>
        </div>
        ${this.#renderItemsSection()}
        ${this.#renderDraftsSection()}
      </section>
    `);
    this.#bindListeners();
  }

  #renderItemsSection(): string {
    const rows = this.#items
      .map(
        (item) => `
          <li class="lifecycle-row" data-testid="content-item-row" data-item-id="${escapeHtml(item.itemId)}">
            <div class="lifecycle-row-main">
              <span class="lifecycle-row-title">${escapeHtml(item.packageKey)}</span>
              <span class="lifecycle-row-meta hn-muted">
                <span class="hn-badge">${escapeHtml(item.family)}</span>
                <span class="hn-badge hn-badge--status">${escapeHtml(item.state)}</span>
                ${item.publication ? `<span class="hn-badge" data-testid="publication-badge">${escapeHtml(item.publication.lifecycle)}</span>` : ""}
              </span>
            </div>
            <button
              type="button"
              class="hn-btn hn-btn--sm"
              data-testid="content-item-open"
              data-item-id="${escapeHtml(item.itemId)}"
              data-family="${escapeHtml(item.family)}"
              data-package-key="${escapeHtml(item.packageKey)}"
            >Open</button>
          </li>
        `,
      )
      .join("");
    return `
      <div class="lifecycle-section" data-testid="content-browser-items-section">
        <h3>Content items <span class="hn-muted">(${this.#itemsTotal})</span></h3>
        ${this.#itemsError ? `<p class="hn-error" data-testid="content-browser-items-error">${escapeHtml(this.#itemsError)}</p>` : ""}
        ${
          rows
            ? `<ul class="lifecycle-table" data-testid="content-browser-items-list">${rows}</ul>`
            : `<p class="lifecycle-empty" data-testid="content-browser-items-empty">${this.#itemsLoading ? "Loading…" : "No content items yet."}</p>`
        }
        ${
          this.#itemsCursor
            ? `<button type="button" class="hn-btn hn-btn--sm" data-testid="content-browser-items-load-more" ${this.#itemsLoading ? "disabled" : ""}>Load more</button>`
            : ""
        }
      </div>
    `;
  }

  #renderDraftsSection(): string {
    const rows = this.#drafts
      .map(
        (draft) => `
          <li class="lifecycle-row" data-testid="draft-row" data-draft-id="${escapeHtml(draft.draftId)}">
            <div class="lifecycle-row-main">
              <span class="lifecycle-row-title">${escapeHtml(draft.packageKey)}</span>
              <span class="lifecycle-row-meta hn-muted">
                <span class="hn-badge">${escapeHtml(draft.family)}</span>
                <span class="hn-badge hn-badge--status">gen ${draft.generation}</span>
                <span class="hn-badge hn-badge--status">${escapeHtml(draft.validation?.status ?? "not-validated")}</span>
                ${draft.envelope.publicationIntent ? `<span class="hn-badge" data-testid="pending-publication-badge">publish proposed</span>` : ""}
              </span>
            </div>
            <button
              type="button"
              class="hn-btn hn-btn--sm"
              data-testid="draft-open"
              data-draft-id="${escapeHtml(draft.draftId)}"
              data-item-id="${escapeHtml(draft.itemId)}"
              data-family="${escapeHtml(draft.family)}"
              data-package-key="${escapeHtml(draft.packageKey)}"
            >Open</button>
          </li>
        `,
      )
      .join("");
    return `
      <div class="lifecycle-section" data-testid="content-browser-drafts-section">
        <h3>Drafts <span class="hn-muted">(${this.#draftsTotal})</span></h3>
        ${this.#draftsError ? `<p class="hn-error" data-testid="content-browser-drafts-error">${escapeHtml(this.#draftsError)}</p>` : ""}
        ${
          rows
            ? `<ul class="lifecycle-table" data-testid="content-browser-drafts-list">${rows}</ul>`
            : `<p class="lifecycle-empty" data-testid="content-browser-drafts-empty">${this.#draftsLoading ? "Loading…" : "No drafts yet."}</p>`
        }
        ${
          this.#draftsCursor
            ? `<button type="button" class="hn-btn hn-btn--sm" data-testid="content-browser-drafts-load-more" ${this.#draftsLoading ? "disabled" : ""}>Load more</button>`
            : ""
        }
      </div>
    `;
  }

  #bindListeners(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const signal = this.connectedSignal;

    const search = root.querySelector<HTMLInputElement>('[data-testid="content-browser-search"]');
    search?.addEventListener("input", () => this.#setSearch(search.value), { signal });

    const familyFilter = root.querySelector<HTMLSelectElement>('[data-testid="content-browser-family-filter"]');
    familyFilter?.addEventListener(
      "change",
      () => {
        this.#family = familyFilter.value as StudioPackageFamily | "all";
        this.refresh();
      },
      { signal },
    );

    const stateFilter = root.querySelector<HTMLSelectElement>('[data-testid="content-browser-state-filter"]');
    stateFilter?.addEventListener(
      "change",
      () => {
        this.#state = stateFilter.value as StudioContentItemState | "all";
        void this.#loadItems(true);
      },
      { signal },
    );

    root
      .querySelector('[data-testid="content-browser-items-load-more"]')
      ?.addEventListener("click", () => void this.#loadItems(false), { signal });
    root
      .querySelector('[data-testid="content-browser-drafts-load-more"]')
      ?.addEventListener("click", () => void this.#loadDrafts(false), { signal });

    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-testid="content-item-open"]')) {
      button.addEventListener(
        "click",
        () => {
          const { itemId, family, packageKey } = button.dataset;
          if (!itemId || !family || !packageKey) return;
          this.#openItem({ itemId, family, packageKey });
        },
        { signal },
      );
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-testid="draft-open"]')) {
      button.addEventListener(
        "click",
        () => {
          const { draftId, itemId, family, packageKey } = button.dataset;
          if (!draftId || !family || !packageKey) return;
          this.#openItem({ draftId, itemId, family, packageKey });
        },
        { signal },
      );
    }
  }
}
