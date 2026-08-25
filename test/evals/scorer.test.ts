import { describe, expect, it } from "vitest";

import { FixtureTurnDriver } from "../../src/evals/driver.js";
import { runEvalTask } from "../../src/evals/runner.js";
import { formatEvalScore, scoreEvalRun } from "../../src/evals/scorer.js";
import type { EvalCheck, EvalExpectation, EvalScore, EvalTask, FixtureAssistantScript } from "../../src/evals/types.js";

/**
 * Unit coverage for the scorer's own behavior — the property honua-studio#46
 * REQ-001 turns on: every assertion is a typed, individually-reported check
 * over the composition/activity-log contract, and a failing one says which
 * field was wrong. Nothing here compares strings for similarity or diffs a
 * whole-state blob.
 */

function task(
  assistant: FixtureAssistantScript,
  expected: EvalExpectation,
  overrides: Partial<EvalTask> = {},
): EvalTask {
  return {
    id: "scorer-probe",
    title: "scorer probe",
    capabilities: ["layer"],
    turns: [{ kind: "instruction", instruction: "compose something", assistant }],
    expected,
    knownBad: [],
    ...overrides,
  };
}

async function score(input: EvalTask): Promise<EvalScore> {
  const run = await runEvalTask(input, { driver: new FixtureTurnDriver() });
  return scoreEvalRun(run);
}

function at(result: EvalScore, path: string): EvalCheck {
  const check = result.checks.find((candidate) => candidate.path === path);
  if (!check) throw new Error(`no check at path "${path}" — paths: ${result.checks.map((c) => c.path).join(", ")}`);
  return check;
}

const addParcels: FixtureAssistantScript = {
  text: "Adding parcels.",
  toolCalls: [{ toolName: "add_layer", arguments: { datasetId: "hi-parcels", styleBy: "zoning" } }],
};

describe("evals/scorer — typed field checks", () => {
  it("reports the exact field, the expectation, and what was actually composed", async () => {
    const result = await score(
      task(addParcels, { state: { layers: { present: [{ id: "hi-parcels", styleId: "district" }] } } }),
    );

    const check = at(result, "state.layers[hi-parcels].styleRef.styleId");
    expect(check.status).toBe("fail");
    expect(check.expected).toBe("district");
    expect(check.actual).toBe("zoning");
    expect(check.message).toBe('expected "district", got "zoning"');
    expect(formatEvalScore(result)).toContain('FAIL state.layers[hi-parcels].styleRef.styleId: expected "district"');
  });

  it("a missing entity fails with the ids that were composed, not a bare false", async () => {
    const result = await score(task(addParcels, { state: { layers: { present: [{ id: "hi-roads" }] } } }));

    const check = at(result, "state.layers[hi-roads]");
    expect(check.status).toBe("fail");
    expect(check.message).toBe('no entry with id "hi-roads" — composed ids: ["hi-parcels"]');
  });

  it("`styleId: null` asserts the layer carries no style ref at all", async () => {
    const unstyled: FixtureAssistantScript = {
      toolCalls: [{ toolName: "addLayer", arguments: { layer: { id: "roads", sourceId: "roads" } } }],
    };

    expect(
      (await score(task(unstyled, { state: { layers: { present: [{ id: "roads", styleId: null }] } } }))).passed,
    ).toBe(true);
    expect(
      (await score(task(addParcels, { state: { layers: { present: [{ id: "hi-parcels", styleId: null }] } } }))).passed,
    ).toBe(false);
  });

  it("the id list is an ordered comparison — layer order is meaningful data", async () => {
    const twoLayers: FixtureAssistantScript = {
      toolCalls: [
        { toolName: "addLayer", arguments: { layer: { id: "base", sourceId: "base" } } },
        { toolName: "addLayer", arguments: { layer: { id: "top", sourceId: "top" } } },
      ],
    };

    expect((await score(task(twoLayers, { state: { layers: { ids: ["base", "top"] } } }))).passed).toBe(true);
    const reversed = await score(task(twoLayers, { state: { layers: { ids: ["top", "base"] } } }));
    expect(reversed.passed).toBe(false);
    expect(at(reversed, "state.layers.ids").message).toBe('expected ["top","base"], got ["base","top"]');
  });

  it("`absent` catches an entity that should have been removed", async () => {
    const result = await score(task(addParcels, { state: { layers: { absent: ["hi-parcels"] } } }));
    const check = at(result, "state.layers[hi-parcels]");
    expect(check.status).toBe("fail");
    expect(check.message).toContain("expected absent, but it is present");
  });

  it("config expectations are a subset match — unnamed keys are not scored", async () => {
    const chart: FixtureAssistantScript = {
      toolCalls: [
        { toolName: "add_chart", arguments: { datasetId: "hi-parcels", groupBy: "zoning", chartType: "bar" } },
      ],
    };
    const result = await score(
      task(chart, {
        state: {
          widgets: { present: [{ id: "chart-hi-parcels-zoning", kind: "chart", config: { groupBy: "zoning" } }] },
        },
      }),
    );

    expect(result.passed, formatEvalScore(result)).toBe(true);
    expect(result.checks.some((check) => check.path.endsWith("config.chartType"))).toBe(false);
  });

  it("pins are scored by their stable target keys", async () => {
    const pinning: FixtureAssistantScript = {
      toolCalls: [
        { toolName: "addLayer", arguments: { layer: { id: "flood", sourceId: "flood" } } },
        { toolName: "pin", arguments: { target: { kind: "layer", id: "flood" } } },
      ],
    };

    expect((await score(task(pinning, { state: { pins: { keys: ["layer:flood"] } } }))).passed).toBe(true);
    const wrong = await score(task(pinning, { state: { pins: { absent: ["layer:flood"] } } }));
    expect(wrong.passed).toBe(false);
    expect(at(wrong, "state.pins[layer:flood]").status).toBe("fail");
  });
});

describe("evals/scorer — view tolerance", () => {
  const setView: FixtureAssistantScript = {
    toolCalls: [{ toolName: "setView", arguments: { view: { center: [-157.8583, 21.3069], zoom: 12.5 } } }],
  };

  it("accepts a camera inside the stated tolerance", async () => {
    const result = await score(
      task(setView, { state: { view: { center: [-157.86, 21.31], zoom: 12, tolerance: 1, centerTolerance: 0.05 } } }),
    );
    expect(result.passed, formatEvalScore(result)).toBe(true);
  });

  it("rejects one outside it, and says by how much it was allowed to differ", async () => {
    const result = await score(task(setView, { state: { view: { zoom: 8, tolerance: 0.5 } } }));
    expect(at(result, "state.view.zoom").message).toBe("expected 8 ±0.5, got 12.5");
  });

  it("`unset` asserts the model did not move the camera at all", async () => {
    const result = await score(task(setView, { state: { view: { unset: ["zoom"] } } }));
    expect(at(result, "state.view.zoom").message).toBe("expected unset, got 12.5");
  });
});

describe("evals/scorer — activity-log checks", () => {
  const rejected: FixtureAssistantScript = {
    toolCalls: [{ toolName: "reticulate_splines", arguments: {} }],
  };

  it("counts entries by type", async () => {
    const result = await score(task(rejected, { activityLog: { counts: { composition_command_rejected: 1 } } }));
    expect(result.passed, formatEvalScore(result)).toBe(true);
  });

  it("matches an entry by type plus a subset of its detail", async () => {
    const result = await score(
      task(rejected, {
        activityLog: { present: [{ type: "composition_command_rejected", detail: { code: "unknown-tool" } }] },
      }),
    );
    expect(result.passed, formatEvalScore(result)).toBe(true);

    const wrongDetail = await score(
      task(rejected, {
        activityLog: { present: [{ type: "composition_command_rejected", detail: { code: "invalid-arguments" } }] },
      }),
    );
    expect(wrongDetail.passed).toBe(false);
    expect(at(wrongDetail, "activityLog.entries[0:composition_command_rejected]").message).toContain(
      'no "composition_command_rejected" entry matching',
    );
  });

  it("the sequence check is an ordered subsequence, so unrelated entries may fall between", async () => {
    const ordered = await score(
      task(addParcels, {
        activityLog: { sequence: ["user_message_sent", "composition_command_applied", "assistant_turn_completed"] },
      }),
    );
    expect(ordered.passed, formatEvalScore(ordered)).toBe(true);

    const backwards = await score(
      task(addParcels, { activityLog: { sequence: ["assistant_turn_completed", "user_message_sent"] } }),
    );
    expect(backwards.passed).toBe(false);
    expect(at(backwards, "activityLog.sequence").message).toContain("in this order");
  });

  it("`absentTypes` proves something never happened", async () => {
    const result = await score(task(addParcels, { activityLog: { absentTypes: ["lifecycle_action"] } }));
    expect(result.passed).toBe(true);

    const violated = await score(task(addParcels, { activityLog: { absentTypes: ["composition_command_applied"] } }));
    expect(at(violated, "activityLog.counts.composition_command_applied").message).toBe(
      'expected no "composition_command_applied" entries, found 1',
    );
  });
});

describe("evals/scorer — what it deliberately does not score", () => {
  it("assistant prose never affects the score", async () => {
    const expectation: EvalExpectation = { state: { layers: { ids: ["hi-parcels"] } } };
    const terse = await score(task({ ...addParcels, text: "Done." }, expectation));
    const chatty = await score(
      task(
        { ...addParcels, text: "Certainly! I have added the parcels layer for you, styled by zoning." },
        expectation,
      ),
    );

    expect(terse.checks.map((check) => `${check.path}=${check.status}`)).toEqual(
      chatty.checks.map((check) => `${check.path}=${check.status}`),
    );
  });

  it("a task that declares no expectations fails rather than passing vacuously", async () => {
    const result = await score(task(addParcels, {}));
    expect(result.passed).toBe(false);
    expect(at(result, "expected").message).toContain("declares no typed expectations");
  });
});
