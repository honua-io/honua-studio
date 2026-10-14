import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type ReviewComment,
  type ReviewGateInput,
  completedFirstPassCommit,
  evaluateSecondReview,
} from "../../scripts/lib/second-review-gate.mjs";

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

function summary(prefix = head.slice(0, 7)): ReviewComment {
  return {
    user: { login: "chatgpt-codex-connector[bot]", type: "Bot" },
    performed_via_github_app: { id: 1144995, slug: "chatgpt-codex-connector" },
    updated_at: "2026-10-14T12:10:18Z",
    body: `<!-- codex-pull-request-review-summary -->\n\n## Codex Review Summary\n\n| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-10-14T12:10:17.484695Z">2026-10-14T12:10:17.484695Z</relative-time> | \`${prefix}\` | Manual request |`,
  };
}

describe("authenticated comment-only first-pass completion", () => {
  it.each([false, true])(
    "admits the recorded connector format only with exact GitHub resolution (audit=%s)",
    (audit) => {
      const value = input(audit);
      const comment = summary();
      const pr = { ...value.pr, reviews: { totalCount: 0, nodes: [] } };
      expect(completedFirstPassCommit([comment])).toBe(head.slice(0, 7));
      expect(evaluateSecondReview({ ...value, pr, comments: [comment] }).shouldReview).toBe(false);
      expect(
        evaluateSecondReview({
          ...value,
          pr,
          comments: [comment],
          resolvedFirstPassCommits: { [head.slice(0, 7)]: head },
        }).shouldReview,
      ).toBe(true);
    },
  );
  it.each([
    "human",
    "lookalike-login",
    "wrong-type",
    "missing-app",
    "wrong-app-id",
    "wrong-app-slug",
    "queued",
    "failed",
    "security-only",
    "bad-time",
    "bad-prefix",
    "injected-prefix",
    "duplicate-row",
    "missing-marker",
  ])("rejects %s evidence", (kind) => {
    const original = summary();
    const comment = {
      ...original,
      ...(kind === "human" ? { user: { login: "mikemcdougall", type: "User" } } : {}),
      ...(kind === "lookalike-login" ? { user: { login: "fake-chatgpt-codex-connector[bot]", type: "Bot" } } : {}),
      ...(kind === "wrong-type" ? { user: { ...original.user, type: "User" } } : {}),
      ...(kind === "missing-app" ? { performed_via_github_app: null } : {}),
      ...(kind === "wrong-app-id" ? { performed_via_github_app: { id: 1, slug: "chatgpt-codex-connector" } } : {}),
      ...(kind === "wrong-app-slug" ? { performed_via_github_app: { id: 1144995, slug: "other" } } : {}),
      ...(kind === "queued" ? { body: original.body.replace("Completed", "Queued") } : {}),
      ...(kind === "failed" ? { body: original.body.replace("Completed", "Failed") } : {}),
      ...(kind === "security-only" ? { body: original.body.replace("Code Review", "Security Review") } : {}),
      ...(kind === "bad-time" ? { updated_at: "invalid" } : {}),
      ...(kind === "bad-prefix" ? { body: summary("bbb").body } : {}),
      ...(kind === "injected-prefix" ? { body: summary("$(touch /tmp/never)").body } : {}),
      ...(kind === "duplicate-row" ? { body: `${original.body}\n${original.body.split("\n").at(-1)}` } : {}),
      ...(kind === "missing-marker"
        ? { body: original.body.replace("<!-- codex-pull-request-review-summary -->", "") }
        : {}),
    };
    expect(completedFirstPassCommit([comment])).toBeUndefined();
  });
  it("does not reuse an older completed summary while the latest review is running", () => {
    const old = summary();
    const current = { ...old, updated_at: "2026-10-14T12:11:00Z", body: old.body.replace("Completed", "In progress") };
    expect(completedFirstPassCommit([old, current])).toBeUndefined();
    expect(completedFirstPassCommit([current, old])).toBeUndefined();
  });
  it("rejects ambiguous latest summaries instead of depending on API order", () => {
    expect(completedFirstPassCommit([summary(), summary("c".repeat(7))])).toBeUndefined();
  });
  it.each(["failed-resolution", "different-commit", "prefix-collision", "unresolved-thread", "pagination"])(
    "fails closed for %s",
    (kind) => {
      const value = input();
      const prefix = head.slice(0, 7);
      const pr = {
        ...value.pr,
        reviews: { totalCount: kind === "pagination" ? 101 : 0, nodes: [] },
        ...(kind === "unresolved-thread"
          ? {
              reviewThreads: {
                totalCount: 1,
                nodes: [
                  {
                    isResolved: false,
                    comments: { nodes: [{ author: { login: "other-reviewer" }, body: "finding" }] },
                  },
                ],
              },
            }
          : {}),
      };
      const resolved =
        kind === "different-commit" ? "c".repeat(40) : kind === "prefix-collision" ? prefix + "c".repeat(33) : head;
      expect(
        evaluateSecondReview({
          ...value,
          pr,
          comments: [summary()],
          resolvedFirstPassCommits: kind === "failed-resolution" ? {} : { [prefix]: resolved },
        }).shouldReview,
      ).toBe(false);
    },
  );
  it("does not extend connector-specific trust to a configured different reviewer", () => {
    expect(completedFirstPassCommit([summary()], "other-reviewer")).toBeUndefined();
  });
});

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
