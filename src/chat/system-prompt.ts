import type { CatalogDataset } from "../client/studio-client.js";
import type { CompositionState } from "../composition/model.js";

export interface StudioSystemPromptOptions {
  readonly draftId?: string;
  readonly generation?: number;
  readonly catalog?: readonly CatalogDataset[];
  readonly composition: CompositionState;
  readonly catalogLimit?: number;
}

/** Builds bounded, server-grounded context afresh for every model turn. */
export function buildStudioSystemPrompt(options: StudioSystemPromptOptions): string {
  const limit = options.catalogLimit ?? 40;
  const catalog = (options.catalog ?? []).slice(0, limit);
  const sources = catalog.map(
    (dataset) => `- ${dataset.id}: ${dataset.title} (${dataset.geometryType}; ${dataset.protocol})`,
  );
  const layers = options.composition.layers.map((layer) => `- ${layer.id} (source: ${layer.sourceId})`);
  const styles = [
    ...new Set(options.composition.layers.flatMap((layer) => (layer.styleRef ? [layer.styleRef.styleId] : []))),
  ];

  return [
    "You are Honua Studio's map-composition agent.",
    options.draftId !== undefined
      ? `The authoritative server draft is ${options.draftId} at generation ${options.generation ?? "unknown"}.`
      : "No authoritative server draft is attached; do not request durable mutations.",
    "Use only the declared tools and governed external identifiers present in the supplied catalog or current composition.",
    "Never invent dataset, source, style, or existing-object reference identifiers.",
    "When creating a new layer, widget, control, or interaction, choose a concise deterministic identifier and reuse it in later references.",
    "Prefer small, ordered mutations and inspect the map when the user's intent is ambiguous.",
    "Report tool failures truthfully; do not claim a canvas change until its tool result succeeds.",
    "Available catalog datasets:",
    ...(sources.length > 0 ? sources : ["- none currently visible to this session"]),
    "Current composition layers:",
    ...(layers.length > 0 ? layers : ["- none"]),
    `Referenced style ids: ${styles.length > 0 ? styles.join(", ") : "none"}.`,
    catalog.length === limit ? `Catalog output is capped at ${limit} entries.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
