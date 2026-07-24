import { describe, expect, it } from "vitest";

import { isCompositionToolCall } from "../../src/composition/tool-call.js";

describe("composition/tool-call isCompositionToolCall", () => {
  it("accepts a well-shaped { tool, input } entry", () => {
    expect(isCompositionToolCall({ tool: "addLayer", input: { id: "roads" } })).toBe(true);
  });

  it("accepts an empty input object", () => {
    expect(isCompositionToolCall({ tool: "pin", input: {} })).toBe(true);
  });

  it("rejects a missing tool", () => {
    expect(isCompositionToolCall({ input: {} })).toBe(false);
  });

  it("rejects a non-object input", () => {
    expect(isCompositionToolCall({ tool: "pin", input: "nope" })).toBe(false);
  });

  it("rejects non-object values entirely", () => {
    expect(isCompositionToolCall(null)).toBe(false);
    expect(isCompositionToolCall("string")).toBe(false);
    expect(isCompositionToolCall(42)).toBe(false);
  });
});
