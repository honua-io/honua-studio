/**
 * honua-studio#25 REQ-001, at the level where it is actually decidable:
 * **every** kind in the closed 14-kind vocabulary either normalizes to a
 * config or reports a stated reason. Nothing falls through, and nothing is
 * dropped.
 *
 * The exhaustiveness assertion below is the one that would catch the
 * regression this requirement exists to prevent — a kind added upstream (or a
 * `switch` arm deleted) that silently produces nothing.
 */
import { describe, expect, it } from "vitest";

import {
  COMPOSITION_CONTROL_KINDS,
  type CompositionControl,
  type CompositionControlKind,
  type CompositionState,
  createEmptyCompositionState,
} from "../../src/composition/model.js";
import {
  BUILT_IN_BASEMAP_OPTIONS,
  CONTROL_KIND_EMITS_CHANGE,
  controlSourceResolves,
  controlTargetLayers,
  describeControl,
  readControlConfig,
} from "../../src/controls/control-config.js";

function control(kind: CompositionControlKind, extra: Partial<CompositionControl> = {}): CompositionControl {
  return { id: `${kind}-1`, kind, ...extra };
}

/** A composition holding a `parcels` layer bound to source `src-parcels`. */
function stateWithParcels(controls: readonly CompositionControl[] = []): CompositionState {
  return {
    ...createEmptyCompositionState(),
    layers: [{ id: "parcels", sourceId: "src-parcels", visible: true }],
    controls: [...controls],
  };
}

/** The config each kind needs to be renderable at all — the minimum an agent has to author. */
const MINIMAL_CONFIG: Readonly<Record<CompositionControlKind, Partial<CompositionControl>>> = {
  navigation: {},
  scale: {},
  fullscreen: {},
  geolocate: {},
  search: {},
  measure: {},
  attribution: {},
  basemapSwitcher: {},
  bookmarks: { config: { bookmarks: [{ label: "Oʻahu", bbox: [-158.3, 21.2, -157.6, 21.8] }] } },
  opacity: { sourceId: "parcels" },
  filterSelect: { config: { field: "zoning_code", options: ["R-5", "B-2"] } },
  filterSlider: { config: { field: "year_built", min: 1900, max: 2020 } },
  filterDateRange: { config: { field: "permit_date" } },
  timeSlider: { config: { field: "permit_date", from: "2020-01-01", to: "2020-12-31" } },
};

describe("controls/control-config", () => {
  it("answers for every kind in the closed vocabulary — a config or a reason, never nothing", () => {
    for (const kind of COMPOSITION_CONTROL_KINDS) {
      const result = readControlConfig(control(kind, MINIMAL_CONFIG[kind]));
      if (result.ok) expect(result.config.kind).toBe(kind);
      else expect(result.reason.length).toBeGreaterThan(20);
    }
  });

  it("renders thirteen kinds and reports exactly one — search, for a named upstream gap", () => {
    const reported = COMPOSITION_CONTROL_KINDS.filter(
      (kind) => !readControlConfig(control(kind, MINIMAL_CONFIG[kind])).ok,
    );
    expect(reported).toEqual(["search"]);
    const search = readControlConfig(control("search"));
    expect(search.ok).toBe(false);
    if (!search.ok) {
      // The reason has to name the missing capability, not just say "no".
      expect(search.reason).toContain("no search provider");
      expect(search.reason).toContain("geospatial-mcp");
    }
  });

  it("splits the vocabulary exactly the way the upstream schema does", () => {
    const emitting = COMPOSITION_CONTROL_KINDS.filter((kind) => CONTROL_KIND_EMITS_CHANGE[kind]);
    expect(emitting).toEqual(["timeSlider", "filterSelect", "filterSlider", "filterDateRange", "opacity"]);
  });

  it("reports a filter with no field rather than rendering a select over nothing", () => {
    const result = readControlConfig(control("filterSelect", { config: { options: ["a"] } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("config.field");
  });

  it("reports a range filter whose domain is missing or inverted", () => {
    expect(readControlConfig(control("filterSlider", { config: { field: "n" } })).ok).toBe(false);
    expect(readControlConfig(control("filterSlider", { config: { field: "n", min: 10, max: 1 } })).ok).toBe(false);
  });

  it("reads a numeric domain an agent spelled as strings", () => {
    const result = readControlConfig(control("filterSlider", { config: { field: "n", min: "1900", max: "2020" } }));
    expect(result.ok).toBe(true);
    if (result.ok && result.config.kind === "filterSlider") {
      expect(result.config.config.min).toBe(1900);
      expect(result.config.config.max).toBe(2020);
    }
  });

  it("points a timeSlider at the time WIDGET when it has no field, rather than failing mutely", () => {
    const result = readControlConfig(control("timeSlider"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("config.field");
  });

  it("falls back to the vendored offline bases so a basemapSwitcher never needs authoring", () => {
    const result = readControlConfig(control("basemapSwitcher"));
    expect(result.ok).toBe(true);
    if (result.ok && result.config.kind === "basemapSwitcher") {
      expect(result.config.config.bases).toEqual(BUILT_IN_BASEMAP_OPTIONS);
    }
  });

  it("reads bookmarks in both the nested and flattened spellings, and defaults their ids", () => {
    const result = readControlConfig(
      control("bookmarks", {
        config: {
          bookmarks: [
            { label: "Statewide", view: { bbox: [-160.3, 18.9, -154.8, 22.3] } },
            { label: "Downtown", center: [-157.86, 21.31], zoom: 14 },
            { label: "Nowhere" },
          ],
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.config.kind === "bookmarks") {
      // The third entry names no place at all — dropped from the list rather
      // than rendered as a button that goes nowhere.
      expect(result.config.config.bookmarks.map((entry) => entry.label)).toEqual(["Statewide", "Downtown"]);
      expect(result.config.config.bookmarks[0]?.id).toBe("bookmarks-1-0");
    }
  });

  it("reports an opacity control that names no layer", () => {
    const result = readControlConfig(control("opacity"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("names no layer");
  });

  describe("describeControl", () => {
    it("reports a control whose sourceId is not in the composition", () => {
      const control1 = control("filterSelect", {
        sourceId: "parcel",
        config: { field: "zoning_code", options: ["R-5"] },
      });
      const status = describeControl(stateWithParcels([control1]), control1);
      expect(status.state).toBe("unsupported");
      if (status.state === "unsupported") expect(status.reason).toContain('"parcel"');
    });

    it("resolves a sourceId against a layer id OR the source that layer binds", () => {
      const state = stateWithParcels();
      expect(controlSourceResolves(state, "parcels")).toBe(true);
      expect(controlSourceResolves(state, "src-parcels")).toBe(true);
      expect(controlSourceResolves(state, "roads")).toBe(false);
      expect(controlTargetLayers(state, "src-parcels")).toEqual(["parcels"]);
    });

    it("renders a bound change-emitting control with no note", () => {
      const filter = control("filterSelect", {
        sourceId: "parcels",
        config: { field: "zoning_code", options: ["R-5"] },
      });
      const state: CompositionState = {
        ...stateWithParcels([filter]),
        interactions: [
          {
            id: "b1",
            on: { ref: `control:${filter.id}`, event: "change" },
            do: { ref: "layer:parcels", verb: "setFilter" },
          },
        ],
      };
      const status = describeControl(state, filter);
      expect(status.state).toBe("rendered");
      if (status.state === "rendered") expect(status.note).toBeUndefined();
    });

    it("renders an UNBOUND change-emitting control and says so — inert by design is still worth saying out loud", () => {
      const filter = control("filterSelect", {
        sourceId: "parcels",
        config: { field: "zoning_code", options: ["R-5"] },
      });
      const status = describeControl(stateWithParcels([filter]), filter);
      expect(status.state).toBe("rendered");
      if (status.state === "rendered") expect(status.note).toContain("change");
    });

    it("never notes a map affordance — its behavior is intrinsic, so there is nothing to bind", () => {
      const nav = control("navigation");
      const status = describeControl(stateWithParcels([nav]), nav);
      expect(status).toEqual({ state: "rendered", config: { kind: "navigation", config: expect.anything() } });
    });
  });
});
