/**
 * Console round-trip fixtures (issue #9 REQ-003, honest per spec AD-3): one
 * fixture package per lifecycle-native family this issue's UI actually
 * drives end to end — `map`, `query`, `dashboard` (AD-3: "query/map/dashboard/
 * report/app can be lifecycle-native from day one"). Each fixture's shape is
 * a `StudioPackageEnvelope` example straight out of
 * `docs/internal/admin-api/studio-package-lifecycle.md`'s "Package Envelope"
 * section (honua-server), representing a package as if it had been authored
 * by console (or any other lifecycle-API client) and handed to Studio to
 * open.
 *
 * `test/lifecycle/round-trip.test.ts` drives each fixture through
 * open→edit→save-version→reopen against a real `StudioLifecycleClient` +
 * `mock-server.mjs` and asserts the body is preserved losslessly at every
 * step — this is round-trip BY MIGRATION (AD-3): Studio never re-derives or
 * re-constructs the envelope from some other in-memory shape, it reads the
 * server's own envelope back and edits/re-saves exactly what it was given.
 *
 * `form` and `analysis` are deliberately NOT represented here: AD-3 says
 * plainly that those two round-trip only after honua-server's persistence
 * unification (server issue #3004) — console's live editors for those
 * families speak the forms-package API and the analysis content/artifacts/
 * jobs API, not this lifecycle API, so there is nothing for a Studio
 * lifecycle-native fixture to prove yet. `report`/`app`/`workflow`/`gp`/`etl`
 * are out of this issue's UI scope (no dedicated per-family editor lands
 * until honua-studio's Phase 2 per-family editor issues) even though the
 * lifecycle API itself accepts them.
 *
 * @module
 */
import type { StudioPackageEnvelope, StudioPackageFamily } from "../lifecycle-types.js";
import dashboardRoadsConditionJson from "./dashboard-roads-condition.json";
import mapParcelsOverviewJson from "./map-parcels-overview.json";
import queryWellsBelowThresholdJson from "./query-wells-below-threshold.json";

export interface StudioRoundTripFixture {
  readonly name: string;
  readonly packageKey: string;
  readonly family: StudioPackageFamily;
  readonly envelope: StudioPackageEnvelope;
}

function asFixture(raw: unknown, name: string): StudioRoundTripFixture {
  const parsed = raw as { packageKey: string; family: StudioPackageFamily; envelope: StudioPackageEnvelope };
  return { name, packageKey: parsed.packageKey, family: parsed.family, envelope: parsed.envelope };
}

export const mapParcelsOverviewFixture: StudioRoundTripFixture = asFixture(
  mapParcelsOverviewJson,
  "map-parcels-overview",
);
export const queryWellsBelowThresholdFixture: StudioRoundTripFixture = asFixture(
  queryWellsBelowThresholdJson,
  "query-wells-below-threshold",
);
export const dashboardRoadsConditionFixture: StudioRoundTripFixture = asFixture(
  dashboardRoadsConditionJson,
  "dashboard-roads-condition",
);

/** Every lifecycle-native round-trip fixture this issue ships (AD-3: map/query/dashboard). */
export const STUDIO_ROUND_TRIP_FIXTURES: readonly StudioRoundTripFixture[] = [
  mapParcelsOverviewFixture,
  queryWellsBelowThresholdFixture,
  dashboardRoadsConditionFixture,
];

/** Families this issue's fixtures cover — round-trip for `form`/`analysis` is explicitly NOT claimed (see module doc). */
export const LIFECYCLE_NATIVE_ROUND_TRIP_FAMILIES: readonly StudioPackageFamily[] = ["map", "query", "dashboard"];
