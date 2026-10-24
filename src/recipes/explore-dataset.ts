import type { CatalogDataset } from "../client/studio-client.js";
import type { CompositionCommand } from "../composition/commands.js";
import { createEmptyCompositionState } from "../composition/model.js";
import { applyCompositionCommands } from "../composition/reducer.js";
import { layerTypeForGeometry, resolveCompositionSource } from "../map/source-resolution.js";
import type { MapStyleField } from "../styles/map-style-edit.js";
import type { WidgetFeatureRow } from "../widgets/widget-data.js";

/** Versioned authoring intent only. The resulting composition uses the ordinary map package. */
export const EXPLORE_DATASET_RECIPE = {
  id: "explore-dataset",
  version: 1,
  title: "Explore a dataset",
  purpose: "Browse a 2D map and table, then filter both by a category.",
  layout: "existing-widget-grid",
  components: ["map", "table", "filterSelect"],
  interactions: ["source-scoped-filter", "feature-selection"],
  requirements: [
    "An authorized published Honua vector FeatureServer layer with readable features.",
    "Point, line or polygon geometry and at least one string category field with values in the first 100 records.",
    "Choose 1–8 table columns from the actual source schema.",
    "The server must support map draft creation. Save, reopen and publication use the normal workspace actions.",
  ],
  preview: {
    kind: "illustrative",
    caption: "Illustrative layout — no user data. Your selected source supplies the map, columns and category values.",
  },
  dependencies: [],
} as const;

export interface ExploreDatasetMetadata {
  readonly source: CatalogDataset;
  readonly fields: readonly MapStyleField[];
  /** A bounded read proves current read access and usable category values; never persisted. */
  readonly rows: readonly WidgetFeatureRow[];
  readonly truncated: boolean;
  readonly bounds?: readonly [number, number, number, number];
}

export interface ExploreDatasetInput {
  readonly recipeId: "explore-dataset";
  readonly recipeVersion: 1;
  readonly packageKey: string;
  readonly sourceId: string;
  readonly categoryField: string;
  readonly tableFields: readonly string[];
}

export function categoryFields(metadata: ExploreDatasetMetadata): readonly MapStyleField[] {
  return metadata.fields.filter(
    (field) =>
      /^(?:string|text|esriFieldTypeString)$/i.test(field.type) &&
      metadata.rows.some((row) => typeof row.properties[field.name] === "string" && row.properties[field.name] !== ""),
  );
}

/** Validates actual schema and readable data, then emits only supported typed commands. */
export function compileExploreDataset(input: ExploreDatasetInput, metadata: ExploreDatasetMetadata) {
  if (input.recipeId !== EXPLORE_DATASET_RECIPE.id || input.recipeVersion !== EXPLORE_DATASET_RECIPE.version)
    throw new Error("This recipe version is unavailable. Reopen Explore a dataset.");
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(input.packageKey))
    throw new Error("Use 1–200 letters, numbers, dots, dashes or underscores for the package key.");
  const source = metadata.source;
  if (input.sourceId !== source.id) throw new Error("Refresh metadata for the selected source.");
  if (source.protocol !== "geoservices-feature-service")
    throw new Error("Choose an authorized published Honua FeatureServer layer.");
  const type = layerTypeForGeometry(source.geometryType);
  if (!type || type === "raster") throw new Error("Choose a point, line or polygon vector source.");
  if (!categoryFields(metadata).some((field) => field.name === input.categoryField))
    throw new Error("Choose a string category field with values in the first 100 records, or choose another dataset.");
  const known = new Set(metadata.fields.map((field) => field.name));
  if (
    input.tableFields.length < 1 ||
    input.tableFields.length > 8 ||
    new Set(input.tableFields).size !== input.tableFields.length ||
    input.tableFields.some((field) => !known.has(field))
  )
    throw new Error("Choose 1–8 distinct table columns from this source's schema.");
  const resolution = resolveCompositionSource(
    { id: "explore-layer", sourceId: source.id, visible: true },
    { catalog: [source] },
  );
  if (!("binding" in resolution) || !resolution.binding)
    throw new Error("This source has no supported vector binding. Choose another published dataset.");
  const commands: readonly CompositionCommand[] = [
    ...(metadata.bounds ? [{ name: "setView" as const, view: { bbox: metadata.bounds } }] : []),
    {
      name: "addLayer",
      layer: {
        id: "explore-layer",
        sourceId: source.id,
        title: source.title,
        type,
        metadata: { recipe: { id: input.recipeId, version: input.recipeVersion } },
      },
    },
    {
      name: "addWidget",
      widget: {
        id: "explore-table",
        kind: "table",
        title: `${source.title} records`,
        sourceId: source.id,
        config: { fields: [...input.tableFields], pageSize: 25 },
      },
    },
    {
      name: "addControl",
      control: {
        id: "explore-category",
        kind: "filterSelect",
        title: `Filter by ${input.categoryField}`,
        sourceId: source.id,
        config: { field: input.categoryField },
      },
    },
    {
      name: "bindInteraction",
      interaction: {
        id: "explore-filter-map",
        on: { ref: "control:explore-category", event: "change" },
        do: { ref: "layer:explore-layer", verb: "setFilter", args: { field: input.categoryField, value: "$event.value" } },
      },
    },
  ];
  const state = applyCompositionCommands(createEmptyCompositionState(), commands).state;
  return { commands, state: { ...state, sourceBindings: [resolution.binding] } };
}
