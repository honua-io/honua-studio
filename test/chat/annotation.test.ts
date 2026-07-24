import { describe, expect, it } from "vitest";

import {
  annotationChipLabel,
  composeMessageContent,
  createAnnotationRef,
  serializeAnnotationsForContext,
} from "../../src/chat/annotation.js";

describe("chat/annotation", () => {
  it("createAnnotationRef builds a ref from fully-resolved fields, omitting label when absent", () => {
    const ref = createAnnotationRef({
      id: "a1",
      kind: "feature",
      payload: { layerId: "hi-parcels", featureId: "TMK-1" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(ref).toEqual({
      id: "a1",
      kind: "feature",
      payload: { layerId: "hi-parcels", featureId: "TMK-1" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect("label" in ref).toBe(false);
  });

  describe("annotationChipLabel", () => {
    it("prefers an explicit label for any kind", () => {
      const ref = createAnnotationRef({
        id: "a1",
        kind: "layer",
        payload: { layerId: "hi-parcels" },
        label: "Parcels",
        createdAt: "t",
      });
      expect(annotationChipLabel(ref)).toBe("Parcels");
    });

    it("falls back to a kind-specific default for layer/feature/region/component", () => {
      expect(
        annotationChipLabel(createAnnotationRef({ id: "1", kind: "layer", payload: { layerId: "L" }, createdAt: "t" })),
      ).toBe("Layer L");
      expect(
        annotationChipLabel(
          createAnnotationRef({ id: "2", kind: "feature", payload: { layerId: "L", featureId: 42 }, createdAt: "t" }),
        ),
      ).toBe("Feature 42 on L");
      expect(
        annotationChipLabel(
          createAnnotationRef({ id: "3", kind: "region", payload: { bbox: [0, 0, 1, 1] }, createdAt: "t" }),
        ),
      ).toBe("Region [0, 0, 1, 1]");
      expect(
        annotationChipLabel(createAnnotationRef({ id: "4", kind: "component", payload: { componentId: "C" }, createdAt: "t" })),
      ).toBe("Component C");
    });
  });

  describe("serializeAnnotationsForContext", () => {
    it("returns an empty string for no annotations", () => {
      expect(serializeAnnotationsForContext([])).toBe("");
    });

    it("preserves insertion order and includes the typed payload for each chip", () => {
      const a = createAnnotationRef({ id: "a", kind: "layer", payload: { layerId: "hi-parcels" }, createdAt: "t" });
      const b = createAnnotationRef({
        id: "b",
        kind: "feature",
        payload: { layerId: "hi-parcels", featureId: "TMK-1" },
        createdAt: "t",
      });
      const serialized = serializeAnnotationsForContext([a, b]);
      const lines = serialized.split("\n").slice(1); // drop the "Context (...)" header
      expect(lines).toEqual([
        '- [layer] Layer hi-parcels :: {"layerId":"hi-parcels"}',
        '- [feature] Feature TMK-1 on hi-parcels :: {"layerId":"hi-parcels","featureId":"TMK-1"}',
      ]);
    });

    it("is byte-stable across repeated calls with the same input", () => {
      const a = createAnnotationRef({ id: "a", kind: "component", payload: { componentId: "chart-1" }, createdAt: "t" });
      expect(serializeAnnotationsForContext([a])).toBe(serializeAnnotationsForContext([a]));
    });
  });

  describe("composeMessageContent", () => {
    it("returns the plain text unchanged when there are no annotations", () => {
      expect(composeMessageContent("hello", [])).toBe("hello");
    });

    it("appends the serialized context block after a blank line when annotations are present", () => {
      const a = createAnnotationRef({ id: "a", kind: "layer", payload: { layerId: "L" }, createdAt: "t" });
      const content = composeMessageContent("What's this?", [a]);
      expect(content).toBe('What\'s this?\n\nContext (user-selected references):\n- [layer] Layer L :: {"layerId":"L"}');
    });
  });
});
