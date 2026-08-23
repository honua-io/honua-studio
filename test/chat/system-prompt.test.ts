import { describe, expect, it } from "vitest";

import { buildStudioSystemPrompt } from "../../src/chat/system-prompt.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";

describe("chat/system-prompt", () => {
  it("grounds the turn in draft generation, capped catalog facts, styles, and the human publication fence", () => {
    const composition = {
      ...createEmptyCompositionState(),
      layers: [
        {
          id: "parcels",
          sourceId: "parcels",
          visible: true,
          styleRef: { kind: "style-ref" as const, styleId: "zoning" },
        },
      ],
    };
    const prompt = buildStudioSystemPrompt({
      draftId: "draft-1",
      generation: 7,
      composition,
      catalogLimit: 1,
      catalog: [
        { id: "parcels", title: "Parcels", geometryType: "Polygon", protocol: "ogc-features" },
        { id: "roads", title: "Roads", geometryType: "LineString", protocol: "ogc-features" },
      ],
    });
    expect(prompt).toContain("draft-1 at generation 7");
    expect(prompt).toContain("parcels: Parcels (Polygon; ogc-features)");
    expect(prompt).not.toContain("roads: Roads");
    expect(prompt).toContain("zoning");
    expect(prompt).toContain("human-approved status");
    expect(prompt).toContain("Esri GPServer");
    expect(prompt).toContain("OGC/direct process verbs");
  });
});
