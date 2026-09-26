import { describe, expect, it } from "vitest";

import { canonicalCompositionJson } from "../../src/composition/model.js";
import { EVAL_CORPUS, evalTaskById } from "../../src/evals/corpus.js";
import { FixtureTurnDriver } from "../../src/evals/driver.js";
import { runEvalTask, withKnownBadVariant } from "../../src/evals/runner.js";
import { failingPaths, formatEvalScore, scoreEvalRun } from "../../src/evals/scorer.js";
import type { EvalCapability } from "../../src/evals/types.js";

/**
 * honua-studio#46 REQ-003's gate, both halves in the default (PR-safe,
 * model-free) suite:
 *
 *  - **known-good** — every corpus task, run against its fixture transcript,
 *    must score with zero failing checks. This is what makes the corpus a
 *    regression test of the composition loop itself: change the tool bridge,
 *    the reducer, or the activity log's contract, and a named check fails.
 *  - **known-bad** — every task's deliberately miscomposed transcripts must
 *    FAIL, and fail at the check paths the variant names. A corpus whose
 *    scorer cannot catch a wrong composition measures nothing; this half is
 *    the induced-regression test #46's Validation section asks for.
 */

const driver = () => new FixtureTurnDriver();

describe("evals/corpus — known-good fixture transcripts", () => {
  for (const task of EVAL_CORPUS) {
    it(`${task.id}: ${task.title}`, async () => {
      const run = await runEvalTask(task, { driver: driver() });
      const score = scoreEvalRun(run);

      expect(score.passed, formatEvalScore(score)).toBe(true);
      expect(score.failures).toEqual([]);
      expect(score.totalCount).toBeGreaterThan(0);
      expect(score.passedCount).toBe(score.totalCount);
      expect(score.driverId).toBe("fixture");
    });
  }

  it("is byte-stable: the same task run twice produces identical state and activity log", async () => {
    const task = EVAL_CORPUS[0];
    const first = await runEvalTask(task, { driver: driver() });
    const second = await runEvalTask(task, { driver: driver() });

    expect(canonicalCompositionJson(second.state)).toBe(canonicalCompositionJson(first.state));
    expect(canonicalCompositionJson(second.entries)).toBe(canonicalCompositionJson(first.entries));
  });
});

describe("evals/corpus — known-bad transcripts must fail, at the named paths", () => {
  for (const task of EVAL_CORPUS) {
    for (const variant of task.knownBad) {
      it(`${task.id} / ${variant.id}: ${variant.description}`, async () => {
        const miscomposed = withKnownBadVariant(task, variant);
        const run = await runEvalTask(miscomposed, { driver: driver() });
        const score = scoreEvalRun(run);

        expect(score.passed, `expected the scorer to catch: ${variant.description}\n${formatEvalScore(score)}`).toBe(
          false,
        );
        // The variant must break the checks it claims to break — proving the
        // scorer caught the intended defect, not an unrelated one. Extra
        // failures are allowed: one wrong tool call often invalidates several
        // expectations at once.
        expect(failingPaths(score)).toEqual(expect.arrayContaining([...variant.expectFailingPaths]));
      });
    }
  }

  it("a known-bad variant leaves the task's instructions and expectations untouched", () => {
    const task = evalTaskById("hide-parcels-keeps-layer");
    if (!task) throw new Error("task missing from the corpus");
    const variant = task.knownBad[0];
    const miscomposed = withKnownBadVariant(task, variant);

    expect(miscomposed.id).toBe(`${task.id}#${variant.id}`);
    expect(miscomposed.turns.map((turn) => (turn.kind === "instruction" ? turn.instruction : turn.action))).toEqual(
      task.turns.map((turn) => (turn.kind === "instruction" ? turn.instruction : turn.action)),
    );
    expect(miscomposed.expected).toBe(task.expected);
    expect(miscomposed.setup).toBe(task.setup);
  });
});

describe("evals/corpus — corpus hygiene", () => {
  it("task ids are unique", () => {
    const ids = EVAL_CORPUS.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every task declares at least one typed expectation, and at least one known-bad variant", () => {
    for (const task of EVAL_CORPUS) {
      expect(task.expected.state ?? task.expected.activityLog, `task "${task.id}"`).toBeDefined();
      expect(task.knownBad.length, `task "${task.id}"`).toBeGreaterThan(0);
      for (const variant of task.knownBad) {
        expect(variant.expectFailingPaths.length, `variant "${task.id}/${variant.id}"`).toBeGreaterThan(0);
      }
    }
  });

  it("covers the composition surface the flagship arc is judged on", () => {
    const covered = new Set(EVAL_CORPUS.flatMap((task) => task.capabilities));
    const required: readonly EvalCapability[] = [
      "layer",
      "style",
      "view",
      "widget",
      "control",
      "interaction",
      "visibility",
      "pinning",
      "undo",
      "lifecycle",
    ];
    expect([...required].filter((capability) => !covered.has(capability))).toEqual([]);
  });
});
