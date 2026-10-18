import { describe, expect, it } from "vitest";
import { compositionStyleOverride } from "../../src/styles/composition-style-override.js";
describe("authored style visibility", () => {
  it("scales both symbol opacity properties without inventing symbol-opacity", () => {
    const result = compositionStyleOverride({ paint: { "text-opacity": 0.8 } }, "symbol", true, { opacity: 0.5 });
    expect(result.paint).toEqual({ "text-opacity": 0.4, "icon-opacity": 0.5 });
  });
  it("preserves a hidden catalog render layer when its composed source is enabled", () => {
    expect(compositionStyleOverride({ layout: { visibility: "none" } }, "fill", true).layout?.visibility).toBe("none");
    expect(compositionStyleOverride({}, "fill", true).layout?.visibility).toBeUndefined();
  });
  it("masks visibility only while the composed source is disabled", () => {
    expect(compositionStyleOverride({ layout: { visibility: "visible" } }, "fill", false).layout?.visibility).toBe(
      "none",
    );
  });
});
