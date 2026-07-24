/**
 * The required (honua-studio#10 NFR-001) scripted GP journey: "buffer the
 * flood zones by 500m and intersect with parcels, run it statewide" — the
 * exact analysis the issue's own Context section names as the motivating
 * example. Deterministic, no timers: every step is caller-driven (see
 * {@link runGpFixtureAuthoring}'s doc), so the full
 * author -> validate -> preview trail replays byte-stably in CI with no
 * model in the loop — the same "deterministic, model-free evaluation path"
 * `composition/fixture-conversation.ts`'s module doc establishes for the
 * composition engine, applied here to GP authoring.
 *
 * The human half of the journey (confirm -> execute -> complete ->
 * add-output-layer) is NOT scripted here — REQ-009 discipline (build item 3)
 * means execution is never something a script "plays" through the agent
 * path; `test/gp/fixture-conversation.test.ts` drives that half directly
 * against a real `GpJobClient` + the composition `addLayer` command, exactly
 * as a human clicking through `<honua-studio-gp-panel>` would.
 *
 * @module
 */
import type { GpPackageInput, GpPackageOutput, GpPackageParameter, GpPackageStep } from "../gp-types.js";

export const BUFFER_INTERSECT_PACKAGE_KEY = "gp-flood-zone-buffer-intersect";
export const BUFFER_INTERSECT_TITLE = "Buffer flood zones and intersect with parcels";
export const BUFFER_INTERSECT_DESCRIPTION =
  "Buffers the statewide flood zone dataset by 500m and intersects the result with parcels, statewide.";

export const BUFFER_INTERSECT_INPUTS: readonly GpPackageInput[] = [
  { id: "flood-zones", title: "Flood zones", datasetRef: "hi-flood-zones", geometryType: "Polygon", required: true },
  { id: "parcels", title: "Parcels", datasetRef: "hi-parcels", geometryType: "Polygon", required: true },
];

export const BUFFER_INTERSECT_PARAMETERS: readonly GpPackageParameter[] = [
  { id: "buffer-distance-m", title: "Buffer distance", type: "number", value: 500, unit: "meters" },
];

export const BUFFER_INTERSECT_OUTPUTS: readonly GpPackageOutput[] = [
  {
    id: "affected-parcels",
    title: "Parcels within 500m of a flood zone",
    datasetType: "feature-layer",
    geometryType: "Polygon",
  },
];

export const BUFFER_INTERSECT_STEPS: readonly GpPackageStep[] = [
  { id: "buffer-flood-zones", operation: "buffer" },
  { id: "intersect-parcels", operation: "intersect", dependsOn: ["buffer-flood-zones"] },
];

/** REQ-005's re-run parameter override — a wider buffer, same package, no re-authoring. */
export const BUFFER_INTERSECT_RERUN_PARAMETERS: Readonly<Record<string, unknown>> = { "buffer-distance-m": 750 };
