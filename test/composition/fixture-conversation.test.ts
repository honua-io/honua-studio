import { describe, expect, it } from "vitest";

import {
  type FixtureConversationError,
  fixtureConversationCommandError,
  isFixtureConversationError,
  runFixtureConversation,
} from "../../src/composition/fixture-conversation.js";
import { canonicalCompositionJson } from "../../src/composition/model.js";
import type { CompositionToolCallScript } from "../../src/composition/tool-call.js";

/**
 * Mirrors honua-studio#1's own user workflow example ("show me where new
 * development pressure meets flood risk on Oahu" → "make it presentable for
 * a county council meeting"): compose two layers + a chart, set the view,
 * pin the flood-risk layer so a later refinement can't silently touch it,
 * and drop an analyst-drawn region annotation.
 *
 * Uses `{ toolName, arguments }` — matching `HonuaStudioChatToolCallResultDetail`
 * (honua-studio#6, see `tool-call.ts`'s module doc) — not this engine's own
 * command names' relationship to #6's demo fixture vocabulary (`add_layer`
 * etc); these calls script THIS engine's own command names directly, as a
 * fixture author driving the reducer would.
 */
const oahuFloodRiskScript: CompositionToolCallScript = {
  id: "oahu-flood-risk",
  description: "development pressure meets flood risk, Oahu",
  calls: [
    {
      toolName: "addLayer",
      arguments: {
        layer: { id: "development-pressure", sourceId: "src-dev-pressure", title: "Development pressure" },
      },
    },
    {
      toolName: "addLayer",
      arguments: { layer: { id: "flood-risk", sourceId: "src-flood-risk", title: "Flood risk" } },
    },
    { toolName: "setView", arguments: { view: { center: [-157.86, 21.31], zoom: 10 } } },
    { toolName: "addWidget", arguments: { widget: { id: "risk-chart", kind: "chart", sourceId: "src-flood-risk" } } },
    { toolName: "pin", arguments: { target: { kind: "layer", id: "flood-risk" } } },
    {
      toolName: "addAnnotation",
      arguments: {
        annotation: {
          id: "region-1",
          kind: "region",
          label: "Downtown corridor",
          bbox: [-157.87, 21.3, -157.85, 21.32],
        },
      },
    },
  ],
};

/**
 * A second, structurally different script: refine-then-undo-shaped
 * (honua-studio#1's "add sea-level rise, drop the parcels, make the chart
 * per-district" follow-up flavor) — exercises removeWidget,
 * setLayerStyleRef, a point annotation, and pinning a widget instead of a
 * layer, so the two snapshots are not just permutations of the same calls.
 */
const refineSessionScript: CompositionToolCallScript = {
  id: "refine-session",
  description: "add a layer, style it, add/replace widgets, pin a component",
  calls: [
    { toolName: "addLayer", arguments: { layer: { id: "parcels", sourceId: "src-parcels" } } },
    { toolName: "addWidget", arguments: { widget: { id: "parcels-table", kind: "table", sourceId: "src-parcels" } } },
    {
      toolName: "setLayerStyleRef",
      arguments: {
        target: { kind: "layer", id: "parcels" },
        styleRef: { kind: "style-ref", styleId: "style-parcels-v2" },
      },
    },
    { toolName: "addWidget", arguments: { widget: { id: "district-chart", kind: "chart", sourceId: "src-parcels" } } },
    { toolName: "removeWidget", arguments: { target: { kind: "component", id: "parcels-table" } } },
    {
      toolName: "addAnnotation",
      arguments: { annotation: { id: "click-1", kind: "point", coordinate: [-118.24, 34.05] } },
    },
    { toolName: "pin", arguments: { target: { kind: "component", id: "district-chart" } } },
  ],
};

describe("composition/fixture-conversation runFixtureConversation", () => {
  it("applies every step of the Oahu flood-risk script and matches its canonical snapshot", () => {
    const result = runFixtureConversation(oahuFloodRiskScript);
    expect(result.steps).toHaveLength(oahuFloodRiskScript.calls.length);
    expect(result.state.layers.map((l) => l.id)).toEqual(["development-pressure", "flood-risk"]);
    expect(result.state.pins).toEqual([{ kind: "layer", id: "flood-risk" }]);
    expect(result.canonicalJson).toBe(canonicalCompositionJson(result.state));
    expect(result.canonicalJson).toMatchSnapshot();
  });

  it("applies every step of the refine-session script and matches its canonical snapshot", () => {
    const result = runFixtureConversation(refineSessionScript);
    expect(result.state.widgets.map((w) => w.id)).toEqual(["district-chart"]);
    expect(result.state.layers[0]?.styleRef?.styleId).toBe("style-parcels-v2");
    expect(result.canonicalJson).toMatchSnapshot();
  });

  it("the underlying CompositionHistory can undo the last scripted step", () => {
    const result = runFixtureConversation(oahuFloodRiskScript);
    expect(result.history.canUndo()).toBe(true);
    const restored = result.history.undo();
    expect(restored?.annotations).toHaveLength(0);
  });

  it("a script whose step is rejected (e.g. touches a pinned target) throws a FixtureConversationError identifying the failing step", () => {
    const script: CompositionToolCallScript = {
      id: "pin-violation-script",
      calls: [
        { toolName: "addLayer", arguments: { layer: { id: "roads", sourceId: "s" } } },
        { toolName: "pin", arguments: { target: { kind: "layer", id: "roads" } } },
        { toolName: "removeLayer", arguments: { target: { kind: "layer", id: "roads" } } },
      ],
    };
    try {
      runFixtureConversation(script);
      expect.unreachable("expected a FixtureConversationError");
    } catch (error) {
      expect(isFixtureConversationError(error)).toBe(true);
      const fixtureError = error as FixtureConversationError;
      expect(fixtureError.scriptId).toBe("pin-violation-script");
      expect(fixtureError.stepIndex).toBe(2);
      expect(fixtureConversationCommandError(fixtureError)?.code).toBe("pin-violation");
    }
  });

  it("two independent runs of the same script produce byte-identical canonical JSON (NFR-001 determinism)", () => {
    const runA = runFixtureConversation(oahuFloodRiskScript);
    const runB = runFixtureConversation(oahuFloodRiskScript);
    expect(runA.canonicalJson).toBe(runB.canonicalJson);
  });
});
