import type { AuthSession, AuthState, Unsubscribe } from "../auth/index.js";
import type { CatalogDataset, StudioClient } from "../client/studio-client.js";
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
 * Home view: proves REQ-002 (tokens render real chrome), REQ-003 (data loads
 * from the wired server) — and, as of honua-studio#4, AD-6 ("authenticated to
 * honua-server, always"): the catalog/packages calls only fire once `auth`
 * reports a fresh session, and a session that expires mid-view is reported
 * distinctly from a generic fetch failure.
 */
export function renderHome(
  root: HTMLElement,
  client: StudioClient,
  auth: AuthSession,
  onAddSource?: (dataset: CatalogDataset) => Promise<void>,
): void {
  root.innerHTML = `
    <section class="hn-panel view-section" aria-labelledby="catalog-heading" data-testid="catalog-section">
      <h2 id="catalog-heading" class="hn-panel-title">Catalog</h2>
      <p class="hn-muted">Datasets discovered from the connected honua-server.</p>
      <ul class="entity-list" data-testid="catalog-list"></ul>
    </section>
    <section class="hn-panel view-section" aria-labelledby="packages-heading" data-testid="packages-section">
      <h2 id="packages-heading" class="hn-panel-title">Studio packages</h2>
      <p class="hn-muted">Draft and published Studio package lifecycle entries.</p>
      <ul class="entity-list" data-testid="packages-list"></ul>
    </section>
  `;

  const catalogList = root.querySelector<HTMLElement>('[data-testid="catalog-list"]');
  const packagesList = root.querySelector<HTMLElement>('[data-testid="packages-list"]');
  if (!catalogList || !packagesList) return;

  const gateMessage = (status: AuthState["status"]): string => {
    if (auth.mode === "host-adapter") {
      return status === "expired" ? "The host session expired." : "Waiting for the host session…";
    }
    return status === "expired"
      ? "Your session expired. Sign in again to load this."
      : "Sign in to load this from the connected honua-server.";
  };

  let loaded = false;

  // Arrow function expressions (not `function` declarations) below so
  // TypeScript's null-narrowing of catalogList/packagesList — established by
  // the guard above — carries into these closures instead of widening back
  // to `HTMLElement | null`.
  const load = (): void => {
    if (loaded) return;
    loaded = true;
    catalogList.innerHTML = '<li class="hn-muted">Loading…</li>';
    packagesList.innerHTML = '<li class="hn-muted">Loading…</li>';

    client
      .listCatalog()
      .then((datasets) => {
        catalogList.innerHTML = datasets.length
          ? datasets
              .map(
                (dataset, index) =>
                  `<li><span class="hn-badge">${escapeHtml(dataset.protocol)}</span> ${escapeHtml(dataset.title)} <span class="hn-muted">(${escapeHtml(dataset.geometryType)})</span> ${onAddSource ? `<button type="button" class="hn-btn hn-btn--sm" data-catalog-index="${index}" aria-label="Add ${escapeHtml(dataset.title)} to map">Add to map</button><span role="status"></span>` : ""}</li>`,
              )
              .join("")
          : '<li class="hn-muted" data-testid="catalog-empty">No datasets yet.</li>';
        for (const button of catalogList.querySelectorAll<HTMLButtonElement>("button[data-catalog-index]")) {
          const dataset = datasets[Number(button.dataset.catalogIndex)];
          if (!dataset || !onAddSource) continue;
          button.addEventListener("click", async () => {
            button.disabled = true;
            const status = button.nextElementSibling;
            try {
              await onAddSource(dataset);
              if (status) status.textContent = "Added to map.";
            } catch (error) {
              button.disabled = false;
              if (status) status.textContent = error instanceof Error ? error.message : String(error);
            }
          });
        }
      })
      .catch((error: unknown) => {
        loaded = false;
        if (error instanceof StudioSessionExpiredError) {
          catalogList.innerHTML = `<li class="hn-error" data-testid="catalog-session-expired">${describeError(error)}</li>`;
          return;
        }
        catalogList.innerHTML = `<li class="hn-error" data-testid="catalog-error">Could not load the catalog: ${describeError(error)}</li>`;
      });

    client
      .listPackages()
      .then((packages) => {
        packagesList.innerHTML = packages.length
          ? packages
              .map(
                (pkg) =>
                  `<li><span class="hn-badge hn-badge--status">${escapeHtml(pkg.state)}</span> ${escapeHtml(pkg.title)} <span class="hn-muted">${escapeHtml(pkg.family)}</span></li>`,
              )
              .join("")
          : '<li class="hn-muted" data-testid="packages-empty">No packages yet.</li>';
      })
      .catch((error: unknown) => {
        loaded = false;
        if (error instanceof StudioSessionExpiredError) {
          packagesList.innerHTML = `<li class="hn-error" data-testid="packages-session-expired">${describeError(error)}</li>`;
          return;
        }
        packagesList.innerHTML = `<li class="hn-error" data-testid="packages-error">Could not load Studio packages: ${describeError(error)}</li>`;
      });
  };

  // Holds the unsubscribe function once `auth.subscribe` below returns it.
  // A plain mutable-property holder (not a `let`) because `subscribe()`
  // calls `onAuthState` synchronously on registration — before the
  // subscribe() call below has anything to assign — so a bare `let` would
  // be read in its temporal dead zone on that first, synchronous replay.
  const subscription: { unsubscribe?: Unsubscribe } = {};

  const onAuthState = (state: AuthState): void => {
    if (!catalogList.isConnected) {
      // This view has been replaced by a route change; stop listening.
      subscription.unsubscribe?.();
      return;
    }
    if (state.status === "fresh") {
      load();
      return;
    }
    if (state.status === "refreshing") {
      // A refresh is in flight for an already-loaded view — no UI change.
      return;
    }
    loaded = false;
    const message = gateMessage(state.status);
    renderGate(catalogList, "catalog-signed-out", message);
    renderGate(packagesList, "packages-signed-out", message);
  };

  subscription.unsubscribe = auth.subscribe(onAuthState);
}
