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
  it("lists exactly the nine contract tags", () => {
    expect(STUDIO_ELEMENT_TAGS).toEqual([
      "honua-studio-chat",
      "honua-studio-activity-log",
      "honua-studio-widget-deck",
      "honua-studio-control-bar",
      "honua-studio-canvas",
      "honua-studio-content-browser",
      "honua-studio-lifecycle-panel",
      "honua-studio-gp-panel",
      "honua-studio-app",
    ]);
  });

  it("registers a single known tag on an isolated registry", () => {
    const registry = createStudioComponentRegistry();
    expect(registry.get("honua-studio-chat")).toBeUndefined();
    registerStudioElement("honua-studio-chat", registry);
    expect(registry.get("honua-studio-chat")).toBeDefined();
    // Every other tag stays unregistered — registering one tag never claims the rest.
    expect(registry.get("honua-studio-canvas")).toBeUndefined();
    expect(registry.get("honua-studio-app")).toBeUndefined();
  });

  /**
   * honua-studio#24: `<honua-studio-canvas>` composes a
   * `<honua-studio-widget-deck>` into its own shadow DOM by tag name. If a
   * host registers only the canvas, an undefined deck tag upgrades to nothing
   * and the composed widgets silently do not render — so the canvas pulls its
   * dependency in with it. This is the one exception to "registering one tag
   * never claims the rest", and it is deliberate.
   */
  it("registering the canvas also defines the widget deck it composes", () => {
    const registry = createStudioComponentRegistry();
    registerStudioElement("honua-studio-canvas", registry);
    expect(registry.get("honua-studio-canvas")).toBeDefined();
    expect(registry.get("honua-studio-widget-deck")).toBeDefined();
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
