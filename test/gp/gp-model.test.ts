import { describe, expect, it } from "vitest";

import {
  GpModelError,
  addGpInput,
  addGpOutput,
  addGpParameter,
  createEmptyGpPackageBody,
  gpValidationCaveat,
  removeGpInput,
  removeGpOutput,
  removeGpParameter,
  setGpParameterValue,
  setGpSteps,
  validateGpPackageBodyStructurally,
} from "../../src/gp/gp-model.js";

describe("gp-model: builders", () => {
  it("createEmptyGpPackageBody starts with empty collections", () => {
    const body = createEmptyGpPackageBody("Buffer flood zones");
    expect(body).toEqual({ title: "Buffer flood zones", inputs: [], parameters: [], outputs: [], steps: [] });
  });

  it("createEmptyGpPackageBody carries an optional description", () => {
    const body = createEmptyGpPackageBody("t", "d");
    expect(body.description).toBe("d");
  });

  it("addGpInput/addGpParameter/addGpOutput append immutably (never mutate the input body)", () => {
    const empty = createEmptyGpPackageBody("t");
    const withInput = addGpInput(empty, { id: "flood-zones", datasetRef: "hi-flood-zones" });
    expect(empty.inputs).toEqual([]);
    expect(withInput.inputs).toEqual([{ id: "flood-zones", datasetRef: "hi-flood-zones" }]);

    const withParameter = addGpParameter(withInput, { id: "buffer-m", type: "number", value: 500 });
    expect(withParameter.parameters).toEqual([{ id: "buffer-m", type: "number", value: 500 }]);

    const withOutput = addGpOutput(withParameter, { id: "result", title: "Result" });
    expect(withOutput.outputs).toEqual([{ id: "result", title: "Result" }]);
  });

  it("addGpInput/addGpParameter/addGpOutput reject a duplicate id", () => {
    const body = addGpInput(createEmptyGpPackageBody("t"), { id: "a", datasetRef: "ref-a" });
    expect(() => addGpInput(body, { id: "a", datasetRef: "ref-b" })).toThrow(GpModelError);

    const withParam = addGpParameter(createEmptyGpPackageBody("t"), { id: "p", type: "number", value: 1 });
    expect(() => addGpParameter(withParam, { id: "p", type: "number", value: 2 })).toThrow(GpModelError);

    const withOutput = addGpOutput(createEmptyGpPackageBody("t"), { id: "o" });
    expect(() => addGpOutput(withOutput, { id: "o" })).toThrow(GpModelError);
  });

  it("removeGpInput/removeGpParameter/removeGpOutput drop the matching entry only", () => {
    let body = createEmptyGpPackageBody("t");
    body = addGpInput(body, { id: "a", datasetRef: "ref-a" });
    body = addGpInput(body, { id: "b", datasetRef: "ref-b" });
    body = removeGpInput(body, "a");
    expect(body.inputs.map((i) => i.id)).toEqual(["b"]);

    body = addGpParameter(body, { id: "p1", type: "number", value: 1 });
    body = addGpParameter(body, { id: "p2", type: "number", value: 2 });
    body = removeGpParameter(body, "p1");
    expect(body.parameters.map((p) => p.id)).toEqual(["p2"]);

    body = addGpOutput(body, { id: "o1" });
    body = addGpOutput(body, { id: "o2" });
    body = removeGpOutput(body, "o1");
    expect(body.outputs.map((o) => o.id)).toEqual(["o2"]);
  });

  it("setGpParameterValue updates the value in place, leaving id/type/unit untouched", () => {
    const body = addGpParameter(createEmptyGpPackageBody("t"), {
      id: "buffer-m",
      type: "number",
      value: 500,
      unit: "meters",
    });
    const updated = setGpParameterValue(body, "buffer-m", 750);
    expect(updated.parameters).toEqual([{ id: "buffer-m", type: "number", value: 750, unit: "meters" }]);
  });

  it("setGpParameterValue throws for an unknown parameter id", () => {
    expect(() => setGpParameterValue(createEmptyGpPackageBody("t"), "missing", 1)).toThrow(GpModelError);
  });

  it("setGpSteps replaces the steps array wholesale", () => {
    const body = setGpSteps(createEmptyGpPackageBody("t"), [{ id: "s1", operation: "buffer" }]);
    expect(body.steps).toEqual([{ id: "s1", operation: "buffer" }]);
  });
});

describe("gp-model: validateGpPackageBodyStructurally", () => {
  const validBody = () =>
    addGpOutput(
      addGpInput(createEmptyGpPackageBody("Buffer flood zones"), { id: "flood-zones", datasetRef: "hi-flood-zones" }),
      { id: "result" },
    );

  it("accepts a well-formed body", () => {
    const result = validateGpPackageBodyStructurally(validBody());
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("rejects an empty title", () => {
    const result = validateGpPackageBodyStructurally({ ...validBody(), title: "" });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("title must be a non-empty string.");
  });

  it("rejects a body with no declared outputs", () => {
    const body = createEmptyGpPackageBody("t");
    const result = validateGpPackageBodyStructurally(body);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("at least one output"))).toBe(true);
  });

  it("collects duplicate ids across inputs/parameters/outputs/steps as separate errors", () => {
    const body = {
      title: "t",
      inputs: [
        { id: "dup", datasetRef: "a" },
        { id: "dup", datasetRef: "b" },
      ],
      parameters: [],
      outputs: [{ id: "o" }],
      steps: [
        { id: "dup-step", operation: "buffer" },
        { id: "dup-step", operation: "intersect" },
      ],
    };
    const result = validateGpPackageBodyStructurally(body);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('duplicate inputs id "dup".');
    expect(result.errors).toContain('duplicate steps id "dup-step".');
  });

  it("rejects a step that depends on an unknown step id", () => {
    const body = {
      ...validBody(),
      steps: [{ id: "s1", operation: "intersect", dependsOn: ["missing-step"] }],
    };
    const result = validateGpPackageBodyStructurally(body);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('step "s1" depends on unknown step "missing-step".');
  });

  it("returns every problem at once, not just the first", () => {
    const result = validateGpPackageBodyStructurally({ title: "", inputs: [], parameters: [], outputs: [], steps: [] });
    expect(result.errors.length).toBeGreaterThan(1);
  });
});

describe("gp-model: gpValidationCaveat (the honesty note)", () => {
  it("mentions envelope-only validation and planning-only preview by name", () => {
    const caveat = gpValidationCaveat();
    expect(caveat).toMatch(/envelope-only/i);
    expect(caveat).toMatch(/planning-only/i);
  });

  it("is a single stable string (never inlined/duplicated with different wording)", () => {
    expect(gpValidationCaveat()).toBe(gpValidationCaveat());
  });
});
