import { describe, expect, it } from "vitest";

import { buildStudioSystemPrompt } from "../../src/chat/system-prompt.js";
import { CompositionController } from "../../src/composition/controller.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";

describe("buildStudioSystemPrompt", () => {
  it("grounds each turn in the visible catalog and current canvas", () => {
    const controller = new CompositionController(createEmptyCompositionState());
    controller.apply({ name: "addLayer", layer: { id: "parcels", sourceId: "hi-parcels" } });

    const prompt = buildStudioSystemPrompt({
      draftId: "draft-1",
      generation: 4,
      catalog: [{ id: "hi-parcels", title: "Parcels", protocol: "ogc-features", geometryType: "Polygon" }],
      composition: controller.state,
    });

    expect(prompt).toContain("hi-parcels: Parcels (Polygon; ogc-features)");
    expect(prompt).toContain("parcels (source: hi-parcels)");
    expect(prompt).toContain("Never invent dataset");
    expect(prompt).toContain("draft-1 at generation 4");
  });
});
