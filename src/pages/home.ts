import type { StudioClient } from "../client/studio-client.js";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Home view: proves both REQ-002 (tokens render real chrome) and REQ-003 (data loads from the wired server). */
export function renderHome(root: HTMLElement, client: StudioClient): void {
  root.innerHTML = `
    <section class="hn-panel view-section" aria-labelledby="catalog-heading" data-testid="catalog-section">
      <h2 id="catalog-heading" class="hn-panel-title">Catalog</h2>
      <p class="hn-muted">Datasets discovered from the connected honua-server.</p>
      <ul class="entity-list" data-testid="catalog-list">
        <li class="hn-muted">Loading…</li>
      </ul>
    </section>
    <section class="hn-panel view-section" aria-labelledby="packages-heading" data-testid="packages-section">
      <h2 id="packages-heading" class="hn-panel-title">Studio packages</h2>
      <p class="hn-muted">Draft and published Studio package lifecycle entries.</p>
      <ul class="entity-list" data-testid="packages-list">
        <li class="hn-muted">Loading…</li>
      </ul>
    </section>
  `;

  const catalogList = root.querySelector<HTMLElement>('[data-testid="catalog-list"]');
  const packagesList = root.querySelector<HTMLElement>('[data-testid="packages-list"]');
  if (!catalogList || !packagesList) return;

  client
    .listCatalog()
    .then((datasets) => {
      catalogList.innerHTML = datasets.length
        ? datasets
            .map(
              (dataset) =>
                `<li><span class="hn-badge">${dataset.protocol}</span> ${dataset.title} <span class="hn-muted">(${dataset.geometryType})</span></li>`,
            )
            .join("")
        : '<li class="hn-muted" data-testid="catalog-empty">No datasets yet.</li>';
    })
    .catch((error: unknown) => {
      catalogList.innerHTML = `<li class="hn-error" data-testid="catalog-error">Could not load the catalog: ${describeError(error)}</li>`;
    });

  client
    .listPackages()
    .then((packages) => {
      packagesList.innerHTML = packages.length
        ? packages
            .map(
              (pkg) =>
                `<li><span class="hn-badge hn-badge--status">${pkg.status}</span> ${pkg.title} <span class="hn-muted">${pkg.family}/${pkg.format}</span></li>`,
            )
            .join("")
        : '<li class="hn-muted" data-testid="packages-empty">No packages yet.</li>';
    })
    .catch((error: unknown) => {
      packagesList.innerHTML = `<li class="hn-error" data-testid="packages-error">Could not load Studio packages: ${describeError(error)}</li>`;
    });
}
