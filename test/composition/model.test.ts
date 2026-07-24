import { describe, expect, it } from "vitest";

import {
  canonicalCompositionJson,
  compositionTargetKey,
  compositionTargetsEqual,
  createEmptyCompositionState,
} from "../../src/composition/model.js";

describe("composition/model", () => {
  it("createEmptyCompositionState returns a fresh, empty composition", () => {
    const state = createEmptyCompositionState();
    expect(state).toEqual({ version: 1, layers: [], view: {}, widgets: [], annotations: [], pins: [] });
  });

  it("canonicalCompositionJson sorts object keys deterministically regardless of insertion order", () => {
    const a = { b: 1, a: 2, nested: { z: 1, y: 2 } };
    const b = { a: 2, nested: { y: 2, z: 1 }, b: 1 };
    expect(canonicalCompositionJson(a)).toBe(canonicalCompositionJson(b));
    expect(canonicalCompositionJson(a)).toBe('{"a":2,"b":1,"nested":{"y":2,"z":1}}');
  });

  it("canonicalCompositionJson preserves array order (order is meaningful data)", () => {
    expect(canonicalCompositionJson([{ b: 1 }, { a: 1 }])).toBe('[{"b":1},{"a":1}]');
  });

  it("canonicalCompositionJson pretty option indents while remaining key-sorted", () => {
    const json = canonicalCompositionJson({ b: 1, a: 2 }, { pretty: true });
    expect(json).toBe('{\n  "a": 2,\n  "b": 1\n}');
  });

  it("compositionTargetKey / compositionTargetsEqual are stable across kinds", () => {
    expect(compositionTargetKey({ kind: "layer", id: "roads" })).toBe("layer:roads");
    expect(compositionTargetKey({ kind: "feature", sourceId: "parcels", featureId: 42 })).toBe("feature:parcels:42");
    expect(
      compositionTargetsEqual(
        { kind: "feature", sourceId: "parcels", featureId: "42" },
        { kind: "feature", sourceId: "parcels", featureId: "42" },
      ),
    ).toBe(true);
    expect(compositionTargetsEqual({ kind: "layer", id: "roads" }, { kind: "component", id: "roads" })).toBe(false);
  });
});
