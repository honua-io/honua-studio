import type { TemporaryFilterSummary } from "../interactions/studio-interactions.js";

interface TitledLayer {
  readonly id: string;
  readonly title?: string;
}

/** Active temporary filters, each with its own Clear, so a user always sees what narrows the map and widgets. */
export function explorationFilterBarHtml(
  active: readonly TemporaryFilterSummary[],
  layers: readonly TitledLayer[],
): string {
  if (active.length === 0) return "";
  const layerTitle = (layerId: string) => layers.find((layer) => layer.id === layerId)?.title ?? layerId;
  const rows = active
    .map((entry) => {
      const titles = entry.layerIds.map(layerTitle);
      const scope = titles.length ? titles.join(", ") : entry.sourceIds.join(", ");
      return `<li class="control-exploration-filter" data-testid="studio-exploration-filter" data-control-id="${escapeHtml(entry.controlId)}">
          <span><strong>${escapeHtml(entry.title)}</strong>: ${escapeHtml(entry.label)}<span class="hn-muted"> · ${escapeHtml(scope)}</span></span>
          <button type="button" class="hn-btn hn-btn--sm" data-action="exploration-clear" data-control-id="${escapeHtml(entry.controlId)}"
            data-testid="studio-exploration-clear" aria-label="Clear ${escapeHtml(entry.title)} filter">Clear</button>
        </li>`;
    })
    .join("");
  const count = active.length === 1 ? "1 temporary filter" : `${active.length} temporary filters`;
  return `<section class="control-exploration" aria-label="Active exploration filters" data-testid="studio-exploration-filters">
      <p class="control-exploration-note">Exploring with ${count}. They are not saved with the map.</p>
      <ul class="control-exploration-list">${rows}</ul>
      <button type="button" class="hn-btn hn-btn--sm" data-action="exploration-reset" data-testid="studio-exploration-reset">Reset all filters</button>
    </section>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
