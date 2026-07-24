// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import {
  HonuaStudioElementRegistryError,
  STUDIO_ELEMENT_TAGS,
  createStudioComponentRegistry,
  registerAllStudioElements,
  registerStudioElement,
} from "../../src/elements/registry.js";

describe("elements/registry", () => {
  it("lists exactly the seven contract tags", () => {
    expect(STUDIO_ELEMENT_TAGS).toEqual([
      "honua-studio-chat",
      "honua-studio-activity-log",
      "honua-studio-canvas",
      "honua-studio-content-browser",
      "honua-studio-lifecycle-panel",
      "honua-studio-gp-panel",
      "honua-studio-app",
    ]);
  });

  it("registers a single known tag on an isolated registry", () => {
    const registry = createStudioComponentRegistry();
    expect(registry.get("honua-studio-canvas")).toBeUndefined();
    registerStudioElement("honua-studio-canvas", registry);
    expect(registry.get("honua-studio-canvas")).toBeDefined();
    // Every other tag stays unregistered — registering one tag never claims the rest.
    expect(registry.get("honua-studio-chat")).toBeUndefined();
    expect(registry.get("honua-studio-app")).toBeUndefined();
  });

  it("registerStudioElement throws for an unknown tag", () => {
    const registry = createStudioComponentRegistry();
    expect(() => registerStudioElement("honua-studio-nope", registry)).toThrow(HonuaStudioElementRegistryError);
  });

  it("registerAllStudioElements defines every tag and is idempotent", () => {
    const registry = createStudioComponentRegistry();
    registerAllStudioElements(registry);
    for (const tag of STUDIO_ELEMENT_TAGS) expect(registry.get(tag)).toBeDefined();
    // Re-registering (a second host page, a hot-reloaded module, a second
    // call from a test) is a no-op, not a NotSupportedError.
    expect(() => registerAllStudioElements(registry)).not.toThrow();
  });

  it("createStudioComponentRegistry instances are independent of each other and of the global registry", () => {
    const a = createStudioComponentRegistry();
    const b = createStudioComponentRegistry();
    registerStudioElement("honua-studio-chat", a);
    expect(a.get("honua-studio-chat")).toBeDefined();
    expect(b.get("honua-studio-chat")).toBeUndefined();
  });
});
