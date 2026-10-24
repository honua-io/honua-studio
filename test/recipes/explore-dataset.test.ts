import { describe, expect, it } from "vitest";
import { EXPLORE_DATASET_RECIPE, type ExploreDatasetInput, type ExploreDatasetMetadata, compileExploreDataset } from "../../src/recipes/explore-dataset.js";
import { toCompositionDraft } from "../../src/lifecycle/composition-draft-store.js";
import type { StudioPackageDraft } from "../../src/lifecycle/lifecycle-types.js";
import { MAP_COMPOSITION_ENVELOPE, toCompositionDraftBody } from "../../src/mcp/composition-envelope.js";

export const metadata: ExploreDatasetMetadata = {
  source: { id: "service/4", title: "Actual districts", protocol: "geoservices-feature-service", geometryType: "Polygon", locator: { serviceId: "service", layerId: 4, url: "/rest/services/districts/FeatureServer" } },
  fields: [{ name: "zone", type: "String" }, { name: "count", type: "Double" }],
  rows: [{ featureId: 1, properties: { zone: "Residential", count: 4 } }],
  truncated: true,
  bounds: [-158, 21, -157, 22],
};
export const input: ExploreDatasetInput = { recipeId: "explore-dataset", recipeVersion: 1, packageKey: "my-exploration", sourceId: "service/4", categoryField: "zone", tableFields: ["zone", "count"] };

describe("Explore a dataset recipe", () => {
  it("declares a versioned, illustrative preview and only supported components", () => {
    expect(EXPLORE_DATASET_RECIPE).toMatchObject({ id: "explore-dataset", version: 1, preview: { kind: "illustrative" }, components: ["map", "table", "filterSelect"], dependencies: [] });
  });

  it("compiles selected actual identities into ordinary editable components and round-trips the canonical package", () => {
    const { state } = compileExploreDataset(input, metadata);
    expect(state.layers).toEqual([expect.objectContaining({ sourceId: "service/4", type: "fill" })]);
    expect(state.widgets[0]).toMatchObject({ sourceId: "service/4", kind: "table", config: { fields: ["zone", "count"] } });
    expect(state.controls[0]).toMatchObject({ sourceId: "service/4", kind: "filterSelect", config: { field: "zone" } });
    expect(state.interactions[0]).toMatchObject({ on: { ref: "control:explore-category", event: "change" }, do: { ref: "layer:explore-layer", verb: "setFilter" } });
    expect(state.view.bbox).toEqual(metadata.bounds);
    const draft = { draftId: "created", itemId: "item", packageKey: input.packageKey, generation: 1, envelope: { ...MAP_COMPOSITION_ENVELOPE, body: toCompositionDraftBody(state, input.packageKey) } } as StudioPackageDraft;
    const reopened = toCompositionDraft(draft).envelope.body;
    expect(reopened.layers).toEqual(state.layers);
    expect(reopened.controls).toEqual(state.controls);
    expect(reopened.widgets).toEqual(state.widgets);
    expect(reopened.interactions).toEqual(state.interactions);
    expect(reopened.sourceBindings).toEqual(state.sourceBindings);
    expect(JSON.stringify(draft)).not.toContain("Residential");
  });

  it.each(["Raster", "GeometryCollection", "Unknown"])("refuses unsupported %s geometry", (geometryType) => {
    expect(() => compileExploreDataset(input, { ...metadata, source: { ...metadata.source, geometryType } })).toThrow("vector source");
  });

  it("refuses stale sources, fabricated columns, empty categories and incompatible field types", () => {
    expect(() => compileExploreDataset({ ...input, sourceId: "another" }, metadata)).toThrow("selected source");
    expect(() => compileExploreDataset({ ...input, tableFields: ["invented"] }, metadata)).toThrow("table columns");
    expect(() => compileExploreDataset({ ...input, categoryField: "count" }, metadata)).toThrow("string category");
    expect(() => compileExploreDataset(input, { ...metadata, rows: [] })).toThrow("first 100");
    expect(() => compileExploreDataset(input, { ...metadata, fields: [{ name: "zone", type: "Date" }] })).toThrow("string category");
  });
});
