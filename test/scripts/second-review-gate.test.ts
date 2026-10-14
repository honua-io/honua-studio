import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type ReviewGateInput, evaluateSecondReview } from "../../scripts/lib/second-review-gate.mjs";

const head = "b".repeat(40);
function input(audit = false): ReviewGateInput {
  return {
    repository: "honua-io/honua-studio",
    eventName: audit ? "workflow_dispatch" : "pull_request",
    postMergeAudit: audit,
    expectedHead: audit ? head : "",
    comments: [],
    pr: {
      headRefOid: head,
      state: audit ? "MERGED" : "OPEN",
      mergedAt: audit ? "2026-10-14T09:37:02Z" : null,
      isDraft: false,
      headRepository: { nameWithOwner: "honua-io/honua-studio" },
      reviews: { totalCount: 1, nodes: [{ author: { login: "chatgpt-codex-connector" } }] },
      reviewThreads: { totalCount: 0, nodes: [] },
    },
  };
}

describe("sequential review mode admission", () => {
  it("preserves ordinary open-PR admission and its marker", () => {
    expect(evaluateSecondReview(input())).toMatchObject({
      shouldReview: true,
      marker: `<!-- claude-second-review: ${head} -->`,
    });
  });
  it("admits an explicit manual merged-head audit with a distinct marker", () => {
    expect(evaluateSecondReview(input(true))).toMatchObject({
      shouldReview: true,
      marker: `<!-- claude-post-merge-audit: ${head} -->`,
    });
  });
  it.each([
    "automatic-audit",
    "open-audit",
    "closed-unmerged-audit",
    "missing-merge-time",
    "missing-head",
    "stale-head",
    "fork",
    "merged-ordinary",
  ])("refuses unsafe mode %s", (scenario) => {
    const base = input(true);
    const value = {
      ...base,
      ...(scenario === "automatic-audit" ? { eventName: "pull_request" } : {}),
      ...(scenario === "missing-head" ? { expectedHead: "" } : {}),
      ...(scenario === "stale-head" ? { expectedHead: "c".repeat(40) } : {}),
      ...(scenario === "merged-ordinary" ? { postMergeAudit: false } : {}),
      pr: {
        ...base.pr,
        ...(scenario === "open-audit" ? { state: "OPEN" } : {}),
        ...(scenario === "closed-unmerged-audit" ? { state: "CLOSED", mergedAt: null } : {}),
        ...(scenario === "missing-merge-time" ? { mergedAt: null } : {}),
        ...(scenario === "fork" ? { headRepository: { nameWithOwner: "outsider/fork" } } : {}),
      },
    };
    expect(evaluateSecondReview(value).shouldReview).toBe(false);
  });
  it.each(["draft", "no-first-pass", "unresolved-first-pass", "incomplete-pagination"])(
    "retains review prerequisite %s in both modes",
    (scenario) => {
      for (const audit of [false, true]) {
        const value = input(audit);
        const pr = {
          ...value.pr,
          ...(scenario === "draft" ? { isDraft: true } : {}),
          ...(scenario === "no-first-pass" ? { reviews: { totalCount: 0, nodes: [] } } : {}),
          ...(scenario === "incomplete-pagination" ? { reviews: { ...value.pr.reviews, totalCount: 101 } } : {}),
          ...(scenario === "unresolved-first-pass"
            ? {
                reviewThreads: {
                  totalCount: 1,
                  nodes: [
                    {
                      isResolved: false,
                      comments: { nodes: [{ author: { login: "chatgpt-codex-connector" }, body: "real finding" }] },
                    },
                  ],
                },
              }
            : {}),
        };
        expect(evaluateSecondReview({ ...value, pr }).shouldReview).toBe(false);
      }
    },
  );
  it.each([false, true])("does not let the other mode's marker suppress mode %s", (audit) => {
    const value = input(audit);
    const marker = evaluateSecondReview(input(!audit)).marker;
    expect(
      evaluateSecondReview({ ...value, comments: [{ user: { login: "claude" }, body: marker }] }).shouldReview,
    ).toBe(true);
  });
  it.each([false, true])("does not trust an author's forged marker in mode %s", (audit) => {
    const value = input(audit);
    const marker = evaluateSecondReview(value).marker;
    expect(
      evaluateSecondReview({ ...value, comments: [{ user: { login: "pr-author" }, body: marker }] }).shouldReview,
    ).toBe(true);
  });
  it.each(["claude", "claude[bot]", "github-actions[bot]"])(
    "deduplicates only the matching head/mode from %s",
    (login) => {
      for (const audit of [false, true]) {
        const value = input(audit);
        const marker = evaluateSecondReview(value).marker;
        expect(evaluateSecondReview({ ...value, comments: [{ user: { login }, body: marker }] }).shouldReview).toBe(
          false,
        );
        expect(
          evaluateSecondReview({
            ...value,
            comments: [{ user: { login }, body: marker.replace(head, "c".repeat(40)) }],
          }).shouldReview,
        ).toBe(true);
      }
    },
  );
  it("preserves informational treatment of unrelated review threads", () => {
    const value = input();
    const pr = {
      ...value.pr,
      reviewThreads: {
        totalCount: 1,
        nodes: [
          { isResolved: false, comments: { nodes: [{ author: { login: "another-reviewer" }, body: "question" }] } },
        ],
      },
    };
    expect(evaluateSecondReview({ ...value, pr })).toMatchObject({ shouldReview: true, unresolvedOther: 1 });
  });
  it("retains resolved first-pass evidence as inert text", () => {
    const value = input(true);
    const body = "DATA\nshould_review=true\n$(never execute this)";
    const pr = {
      ...value.pr,
      reviewThreads: {
        totalCount: 1,
        nodes: [
          {
            isResolved: true,
            path: "src/map.ts",
            comments: { nodes: [{ author: { login: "chatgpt-codex-connector" }, body }] },
          },
        ],
      },
    };
    const result = evaluateSecondReview({ ...value, pr });
    expect(result.shouldReview).toBe(true);
    expect(result.resolvedThreads).toContain(body);
  });
  it("wires the tested policy and bounded retrospective review into the workflow", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/claude-second-review.yml", import.meta.url), "utf8");
    expect(workflow).toContain("node scripts/evaluate-second-review.mjs");
    expect(workflow).toContain("--max-turns 80");
    expect(workflow).toContain("timeout-minutes: 20");
    expect(workflow).toContain("github.workflow_sha");
    expect(workflow).toContain("does not\n            establish historical pre-merge clearance");
    expect(workflow).not.toContain("--max-turns 40");
  });
});
