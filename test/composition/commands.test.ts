import { describe, expect, it } from "vitest";

import { validateCompositionCommand } from "../../src/composition/commands.js";

describe("composition/commands validateCompositionCommand", () => {
  it("accepts a well-formed addLayer command", () => {
    const result = validateCompositionCommand({
      name: "addLayer",
      layer: { id: "roads", sourceId: "src-roads", visible: true },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a non-object input", () => {
    const result = validateCompositionCommand("not-a-command");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("command must be an object");
  });

  it("rejects an unknown command name", () => {
    const result = validateCompositionCommand({ name: "deleteEverything" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/not a known composition command/);
  });

  it("rejects addLayer missing required layer fields, collecting every problem", () => {
    const result = validateCompositionCommand({ name: "addLayer", layer: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("layer.layer.id must be a non-empty string");
      expect(result.errors).toContain("layer.layer.sourceId must be a non-empty string");
    }
  });

  it("rejects a target with an unknown kind", () => {
    const result = validateCompositionCommand({ name: "removeLayer", target: { kind: "spaceship", id: "x" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/target\.kind must be one of/);
  });

  it("accepts a feature target requiring sourceId + featureId instead of id", () => {
    const result = validateCompositionCommand({
      name: "pin",
      target: { kind: "feature", sourceId: "parcels", featureId: 7 },
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.command.name === "pin") {
      expect(result.command.target).toEqual({ kind: "feature", sourceId: "parcels", featureId: 7 });
    }
  });

  it("rejects a feature target missing featureId", () => {
    const result = validateCompositionCommand({ name: "pin", target: { kind: "feature", sourceId: "parcels" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/featureId must be a string or number/);
  });

  it("rejects addWidget with an out-of-enum kind", () => {
    const result = validateCompositionCommand({ name: "addWidget", widget: { id: "w1", kind: "map3d" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/widget\.kind must be one of/);
  });

  it("rejects setView with non-tuple bbox", () => {
    const result = validateCompositionCommand({ name: "setView", view: { bbox: [1, 2, 3] } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/bbox must be \[x,y,x,y\]/);
  });

  it("rejects an invalid styleRef shape", () => {
    const result = validateCompositionCommand({
      name: "setLayerStyleRef",
      target: { kind: "layer", id: "roads" },
      styleRef: { kind: "not-a-style-ref", styleId: "s1" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/kind must be "style-ref"/);
  });

  it("accepts unpin/pin/removeWidget/removeAnnotation targeted commands", () => {
    for (const name of ["pin", "unpin", "removeWidget", "removeAnnotation"] as const) {
      const result = validateCompositionCommand({ name, target: { kind: "component", id: "w1" } });
      expect(result.ok, `${name} should validate`).toBe(true);
    }
  });
});
