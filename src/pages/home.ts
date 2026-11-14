import type { AuthSession, AuthState, Unsubscribe } from "../auth/index.js";
import type { CatalogDataset, StudioClient, StudioPackageSummary } from "../client/studio-client.js";
import { StudioSessionExpiredError } from "../client/studio-client.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function describeError(error: unknown): string {
  return escapeHtml(error instanceof Error ? error.message : String(error));
}

function renderGate(list: HTMLElement, testId: string, message: string): void {
  list.innerHTML = `<li class="hn-muted" data-testid="${testId}">${message}</li>`;
}

/**
 * Home view. Tokens render real chrome, and catalog data loads from the
 * wired server. The catalog and package calls only fire once `auth` reports
 * a fresh session, and a session that expires mid-view is reported
 * distinctly from a generic fetch failure.
 */
export interface HomeViewContext {
  readonly client: StudioClient;
  readonly auth: AuthSession;
  readonly onAddSource?: (dataset: CatalogDataset) => Promise<void>;
}

export function renderHome(root: HTMLElement, context: HomeViewContext): void {
  root.innerHTML = HOME_MARKUP;
  const catalogList = root.querySelector<HTMLElement>('[data-testid="catalog-list"]');
  const packagesList = root.querySelector<HTMLElement>('[data-testid="packages-list"]');
  if (!catalogList || !packagesList) return;
  const loader = createHomeLoader({ catalog: catalogList, packages: packagesList }, context);
  followAuthState(context.auth, catalogList, (state) => {
    if (state.status === "fresh") {
      loader.load();
      return;
    }
    if (state.status === "refreshing") return;
    loader.reset();
    const message = gateMessage(context.auth, state.status);
    renderGate(catalogList, "catalog-signed-out", message);
    renderGate(packagesList, "packages-signed-out", message);
  });
}

const HOME_MARKUP = `
    <section class="hn-panel view-section" aria-labelledby="catalog-heading" data-testid="catalog-section">
      <h2 id="catalog-heading" class="hn-panel-title">Catalog</h2>
      <p class="hn-muted">Datasets discovered from the connected honua-server.</p>
      <ul class="entity-list" data-testid="catalog-list"></ul>
    </section>
    <section class="hn-panel view-section" aria-labelledby="packages-heading" data-testid="packages-section">
      <h2 id="packages-heading" class="hn-panel-title">Studio content</h2>
      <p class="hn-muted">Draft and released Maps, Apps and other Studio content.</p>
      <ul class="entity-list" data-testid="packages-list"></ul>
    </section>
  `;

function gateMessage(auth: AuthSession, status: AuthState["status"]): string {
  if (auth.mode === "host-adapter") {
    return status === "expired" ? "The host session expired." : "Waiting for the host session…";
  }
  return status === "expired"
    ? "Your session expired. Sign in again to load this."
    : "Sign in to load this from the connected honua-server.";
}

interface HomeLists {
  readonly catalog: HTMLElement;
  readonly packages: HTMLElement;
}

interface HomeLoader {
  load(): void;
  reset(): void;
}

function createHomeLoader(lists: HomeLists, { client, onAddSource }: HomeViewContext): HomeLoader {
  let loaded = false;
  const failed = (list: HTMLElement, subject: LoadSubject) => (error: unknown) => {
    loaded = false;
    renderLoadError(list, subject, error);
  };
  return {
    load() {
      if (loaded) return;
      loaded = true;
      lists.catalog.innerHTML = LOADING_ITEM;
      lists.packages.innerHTML = LOADING_ITEM;
      client
        .listCatalog()
        .then((datasets) => renderCatalog(lists.catalog, datasets, onAddSource))
        .catch(failed(lists.catalog, CATALOG_SUBJECT));
      client
        .listPackages()
        .then((packages) => renderPackages(lists.packages, packages))
        .catch(failed(lists.packages, PACKAGES_SUBJECT));
    },
    reset() {
      loaded = false;
    },
  };
}

const LOADING_ITEM = '<li class="hn-muted">Loading…</li>';

interface LoadSubject {
  readonly testIdPrefix: string;
  readonly label: string;
}

const CATALOG_SUBJECT: LoadSubject = { testIdPrefix: "catalog", label: "the catalog" };
const PACKAGES_SUBJECT: LoadSubject = { testIdPrefix: "packages", label: "Studio content" };

function renderLoadError(list: HTMLElement, { testIdPrefix, label }: LoadSubject, error: unknown): void {
  list.innerHTML =
    error instanceof StudioSessionExpiredError
      ? `<li class="hn-error" data-testid="${testIdPrefix}-session-expired">${describeError(error)}</li>`
      : `<li class="hn-error" data-testid="${testIdPrefix}-error">Could not load ${label}: ${describeError(error)}</li>`;
}

type AddSource = HomeViewContext["onAddSource"];

function renderCatalog(list: HTMLElement, datasets: readonly CatalogDataset[], onAddSource: AddSource): void {
  if (!datasets.length) {
    list.innerHTML = '<li class="hn-muted" data-testid="catalog-empty">No datasets yet.</li>';
    return;
  }
  if (!onAddSource) {
    list.innerHTML = datasets.map((dataset) => `<li>${catalogSummary(dataset)}</li>`).join("");
    return;
  }
  list.innerHTML = datasets
    .map((dataset, index) => `<li>${catalogSummary(dataset)}${addAction(dataset, index)}</li>`)
    .join("");
  for (const button of list.querySelectorAll<HTMLButtonElement>("button[data-catalog-index]")) {
    const dataset = datasets[Number(button.dataset.catalogIndex)];
    if (dataset) bindAddButton(button, () => onAddSource(dataset));
  }
}

function catalogSummary(dataset: CatalogDataset): string {
  return `<span class="hn-badge">${escapeHtml(dataset.protocol)}</span> ${escapeHtml(dataset.title)} <span class="hn-muted">(${escapeHtml(dataset.geometryType)})</span> `;
}

function addAction(dataset: CatalogDataset, index: number): string {
  return `<button type="button" class="hn-btn hn-btn--sm" data-catalog-index="${index}" aria-label="Add ${escapeHtml(dataset.title)} to map">Add to map</button><span role="status"></span>`;
}

function bindAddButton(button: HTMLButtonElement, add: () => Promise<void>): void {
  button.addEventListener("click", async () => {
    button.disabled = true;
    const status = button.nextElementSibling;
    try {
      await add();
      if (status) status.textContent = "Added to map.";
    } catch (error) {
      button.disabled = false;
      if (status) status.textContent = error instanceof Error ? error.message : String(error);
    }
  });
}

function renderPackages(list: HTMLElement, packages: readonly StudioPackageSummary[]): void {
  list.innerHTML = packages.length
    ? packages
        .map(
          (pkg) =>
            `<li><span class="hn-badge hn-badge--status">${escapeHtml(pkg.state)}</span> ${escapeHtml(pkg.title)} <span class="hn-muted">${escapeHtml(pkg.family)}</span></li>`,
        )
        .join("")
    : '<li class="hn-muted" data-testid="packages-empty">No Studio content yet.</li>';
}

/**
 * `subscribe()` replays the current state synchronously, before it returns the
 * unsubscribe function, so the handle lives in a holder rather than a `let`
 * that the first replay would read in its temporal dead zone.
 */
function followAuthState(auth: AuthSession, view: HTMLElement, onState: (state: AuthState) => void): void {
  const subscription: { unsubscribe?: Unsubscribe } = {};
  subscription.unsubscribe = auth.subscribe((state) => {
    if (!view.isConnected) {
      subscription.unsubscribe?.();
      return;
    }
    onState(state);
  });
}
