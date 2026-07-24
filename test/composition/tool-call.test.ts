import { describe, expect, it } from "vitest";

import { isCompositionToolCall } from "../../src/composition/tool-call.js";

describe("composition/tool-call isCompositionToolCall", () => {
  it("accepts a well-shaped { toolName, arguments } entry (matches HonuaStudioChatToolCallResultDetail)", () => {
    expect(isCompositionToolCall({ toolName: "addLayer", arguments: { id: "roads" } })).toBe(true);
  });

  it("accepts an empty arguments object", () => {
    expect(isCompositionToolCall({ toolName: "pin", arguments: {} })).toBe(true);
  });

  it("rejects a missing toolName", () => {
    expect(isCompositionToolCall({ arguments: {} })).toBe(false);
  });

  it("rejects a non-object arguments", () => {
    expect(isCompositionToolCall({ toolName: "pin", arguments: "nope" })).toBe(false);
  });

  it("rejects non-object values entirely", () => {
    expect(isCompositionToolCall(null)).toBe(false);
    expect(isCompositionToolCall("string")).toBe(false);
    expect(isCompositionToolCall(42)).toBe(false);
  });
});
