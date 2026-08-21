import type { CatalogDataset } from "../client/studio-client.js";
import type { CompositionState } from "../composition/model.js";

export interface StudioSystemPromptOptions {
  readonly draftId: string;
  readonly generation: number;
  readonly catalog?: readonly CatalogDataset[];
  readonly composition: CompositionState;
  readonly catalogLimit?: number;
}

/** Builds the bounded, server-grounded context sent on every live model turn. */
export function buildStudioSystemPrompt(options: StudioSystemPromptOptions): string {
  const limit = options.catalogLimit ?? 40;
  const catalog = (options.catalog ?? []).slice(0, limit);
  const styles = [
    ...new Set(options.composition.layers.flatMap((layer) => (layer.styleRef ? [layer.styleRef.styleId] : []))),
  ];
  const sources = catalog.map(
    (dataset) => `- ${dataset.id}: ${dataset.title} (${dataset.geometryType}; ${dataset.protocol})`,
  );
  return [
    "You are Honua Studio's composition agent.",
    `The authoritative server draft is ${options.draftId} at generation ${options.generation}.`,
    "Use only declared tools. Never invent dataset, layer, style, control, widget, or interaction identifiers.",
    "For users migrating from Esri, prefer a familiar server-advertised Esri GPServer task alias when one matches the requested operation. OGC/direct process verbs use the same governed job and artifact engine.",
    "Prefer small, ordered mutations: add the layer, style it, set the view, then add widgets/controls/interactions.",
    "A publication request is intent only. Never claim an app is shared until a human-approved status returns a publicUrl.",
    "Available catalog datasets:",
    ...(sources.length > 0 ? sources : ["- none currently visible to this session"]),
    `Available referenced style ids: ${styles.length > 0 ? styles.join(", ") : "none"}.`,
    catalog.length === limit ? `Catalog output is capped at ${limit} entries.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
