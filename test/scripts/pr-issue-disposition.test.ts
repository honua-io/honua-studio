import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadCurrentPullRequestDisposition } from "../../scripts/lib/github-pr-issue-disposition.mjs";
import {
  DEPENDABOT_EXEMPTION,
  PullRequestDispositionError,
  automationExemption,
  parsePullRequestDisposition,
  validatePullRequestDisposition,
} from "../../scripts/lib/pr-issue-disposition.mjs";
import type {
  DispositionIssue,
  DispositionValidationInput,
  PullRequestDispositionCode,
} from "../../scripts/lib/pr-issue-disposition.mjs";

const repository = "honua-io/honua-studio";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "scripts/check-pr-issue-disposition.mjs");

function readWorkflow(name: string): string {
  return fs.readFileSync(path.join(root, ".github/workflows", name), "utf8").replaceAll("\r\n", "\n");
}

function graphqlPayload({
  body = "Refs #40 (S2; the agent loop remains)",
  closingIssueNumbers = [] as number[],
  updatedAt = "2026-08-25T22:00:00Z",
  number = 58,
  title = "ci(workflows): enforce issue disposition",
  headRefName = "ci/57-disposition-gate",
  headSha = "a".repeat(40),
  headRepository = repository,
  baseRefName = "main",
  baseSha = "b".repeat(40),
  baseRepository = repository,
  authorLogin = "mikemcdougall",
  authorType = "User",
} = {}) {
  return {
    data: {
      repository: {
        nameWithOwner: repository,
        pullRequest: {
          number,
          body,
          title,
          state: "OPEN",
          updatedAt,
          headRefName,
          headRefOid: headSha,
          headRepository: headRepository ? { nameWithOwner: headRepository } : null,
          baseRefName,
          baseRefOid: baseSha,
          baseRepository: baseRepository ? { nameWithOwner: baseRepository } : null,
          author: { __typename: authorType, login: authorLogin },
          closingIssuesReferences: {
            nodes: closingIssueNumbers.map((issueNumber) => ({
              number: issueNumber,
              repository: { nameWithOwner: repository },
            })),
            pageInfo: { hasNextPage: false },
          },
        },
      },
    },
  };
}

function graphqlIssuePayload(number: number, { state = "OPEN", type = "Issue" } = {}) {
  return {
    data: {
      repository: {
        nameWithOwner: repository,
        issueOrPullRequest: { __typename: type, number, state },
      },
    },
  };
}

function issue(number: number, overrides: Partial<DispositionIssue> = {}): DispositionIssue {
  return { number, repository, state: "open", isPullRequest: false, ...overrides };
}

function validate(overrides: Partial<DispositionValidationInput> = {}) {
  return validatePullRequestDisposition({
    repository,
    body: "## Summary\n\nA bounded change.\n\nCloses #57",
    authorLogin: "mikemcdougall",
    headRefName: "ci/57-disposition-gate",
    title: "ci(workflows): enforce issue disposition",
    issues: [issue(57)],
    closingIssueNumbers: [57],
    ...overrides,
  });
}

function expectFailure(code: PullRequestDispositionCode, action: () => unknown): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected a PullRequestDispositionError with code ${code}`).toBeInstanceOf(
    PullRequestDispositionError,
  );
  expect((thrown as PullRequestDispositionError).code).toBe(code);
}

function requestBodyQuery(options: Record<string, unknown> | undefined): string {
  return String(JSON.parse(String(options?.body ?? "{}")).query ?? "");
}

describe("pull request issue disposition policy", () => {
  it("keeps the required workflow pinned, least-privilege, and bound to trusted base code", () => {
    const workflow = readWorkflow("pr-issue-disposition.yml");
    expect(workflow).toMatch(/^ {2}pull_request:\n {4}branches:\n {6}- main\n/mu);
    expect(workflow).toMatch(/^ {4}types: \[opened, edited, synchronize, reopened, ready_for_review\]$/mu);
    expect(workflow).toMatch(/^ {2}workflow_dispatch:\n/mu);
    expect(workflow).not.toMatch(/pull_request_target/u);
    expect(workflow).toMatch(/^ {2}contents: read\n {2}issues: read\n {2}pull-requests: read$/mu);
    expect(workflow).not.toMatch(/(?:write|secrets:)/u);
    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}/u);
    expect(workflow).toMatch(/actions\/setup-node@[0-9a-f]{40}/u);
    expect(workflow).toMatch(
      /ref: \$\{\{ github\.event\.pull_request\.base\.ref \|\| github\.event\.repository\.default_branch \}\}/u,
    );
    expect(workflow).not.toMatch(/pull_request\.base\.sha/u);
    expect(workflow).toMatch(/path: trusted-policy/u);
    expect(workflow).toMatch(/persist-credentials: false/u);
    expect(workflow).toMatch(/working-directory: \$\{\{ steps\.policy\.outputs\.directory \}\}/u);
    expect(workflow).toMatch(/^ {4}name: PR Issue Disposition$/mu);
  });

  it("prefers the trusted base validator and only falls back when the base has none", () => {
    const workflow = readWorkflow("pr-issue-disposition.yml");
    const selection = workflow.slice(workflow.indexOf("- name: Select the policy revision"));
    expect(selection).toMatch(
      /if \[\[ -f trusted-policy\/scripts\/check-pr-issue-disposition\.mjs \]\]; then\n\s*echo "directory=trusted-policy"/u,
    );
    expect(selection).toMatch(/echo "directory=head-policy"/u);
    // The fallback must never be reachable while `main` carries the validator.
    expect(fs.existsSync(path.join(root, "scripts/check-pr-issue-disposition.mjs"))).toBe(true);
  });

  it("documents the gate in AGENTS.md so agents get the grammar right on the first push", () => {
    const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(agents).toMatch(/`PR Issue Disposition`/u);
    expect(agents).toMatch(/scripts\/lib\/pr-issue-disposition\.mjs/u);
    expect(agents).not.toMatch(/No CI check enforces the grammar here/u);
  });

  it("accepts exact completion and partial-slice footer blocks", () => {
    expect(validate()).toEqual({ status: "valid", exemption: null, closes: [57], refs: [] });
    expect(
      validate({
        body: "## Summary\n\nRaster groundwork.\n\nRefs #36 (S1; tile rendering remains)",
        issues: [issue(36)],
        closingIssueNumbers: [],
      }),
    ).toEqual({ status: "valid", exemption: null, closes: [], refs: [36] });
    expect(
      validate({
        body:
          "Completes one prerequisite and advances an epic.\n\nCloses #57\n" +
          "Refs #40 (partial workstream; the closed agent loop remains)",
        issues: [issue(40), issue(57)],
        closingIssueNumbers: [57],
      }),
    ).toEqual({ status: "valid", exemption: null, closes: [57], refs: [40] });
  });

  it("requires the exact footer as the final nonblank block", () => {
    expectFailure("missing-footer", () => validate({ body: "No disposition" }));
    expectFailure("missing-footer", () => validate({ body: "Closes #57\n\nTrailing prose" }));
    expectFailure("missing-footer", () => validate({ body: "Fixes #57" }));
    expectFailure("missing-footer", () => validate({ body: "Refs honua-io/honua-sdk-js#120" }));
    expectFailure("invalid-reference-explanation", () => validate({ body: "Refs #40 (agent loop)" }));
    expectFailure("invalid-reference-explanation", () => validate({ body: "Refs #40 ( S2 remains)" }));
    for (const malformed of ["Refs #40", "Refs #40 (S2; S3 remains)   ", "Refs #40 (S2; S3 remains) extra"]) {
      expectFailure("misplaced-reference", () => validate({ body: `${malformed}\nCloses #57` }));
    }
  });

  it("rejects dangerous closing keywords outside the exact footer", () => {
    for (const prose of ["does not close #41", "Do not fix #41", "will not resolve: #41", "Fixes #41"]) {
      expectFailure("ambiguous-closing-keyword", () => validate({ body: `${prose}\n\nRefs #40 (S2; S3 remains)` }));
    }
    expectFailure("ambiguous-closing-keyword", () =>
      validate({ body: "Refs #40 (S2; does not close #41 and S3 remains)" }),
    );
    expectFailure("nested-reference", () => validate({ body: "Refs #40 (S2; Refs #41 remains)" }));
  });

  it("rejects duplicate and excessive dispositions", () => {
    expectFailure("duplicate-disposition", () => parsePullRequestDisposition("Closes #57\nRefs #57 (S1; S2 remains)"));
    const excessive = Array.from({ length: 21 }, (_, index) => `Closes #${index + 1}`).join("\n");
    expectFailure("too-many-dispositions", () => parsePullRequestDisposition(excessive));
  });

  it("requires same-repository open issues rather than pull requests", () => {
    expectFailure("missing-referenced-issue", () => validate({ issues: [] }));
    expectFailure("closed-issue-target", () => validate({ issues: [issue(57, { state: "closed" })] }));
    expectFailure("pull-request-target", () => validate({ issues: [issue(57, { isPullRequest: true })] }));
    expectFailure("cross-repository-issue", () =>
      validate({ issues: [issue(57, { repository: "honua-io/honua-sdk-js" })] }),
    );
    expectFailure("invalid-repository", () => validate({ repository: "honua-studio" }));
  });

  it("requires exact agreement with GitHub closingIssuesReferences", () => {
    expectFailure("github-closing-mismatch", () => validate({ closingIssueNumbers: [] }));
    expectFailure("github-closing-mismatch", () => validate({ closingIssueNumbers: [57, 41] }));
    expectFailure("reference-would-close", () =>
      validate({
        body: "Refs #40 (S2; S3 remains)",
        issues: [issue(40)],
        closingIssueNumbers: [40],
      }),
    );
  });

  it("exempts Dependabot alone, and only on its own branches", () => {
    expect(
      automationExemption({
        authorLogin: "dependabot[bot]",
        authorType: "Bot",
        headRefName: "dependabot/npm_and_yarn/vite-8.1.4",
      }),
    ).toBe(DEPENDABOT_EXEMPTION);
    expect(
      validatePullRequestDisposition({
        repository,
        body: "",
        authorLogin: "app/dependabot",
        authorType: "Bot",
        headRefName: "dependabot/github_actions/actions/checkout-7",
        title: "chore(deps): bump actions/checkout",
        issues: [],
        closingIssueNumbers: [],
      }),
    ).toEqual({ status: "exempt", exemption: DEPENDABOT_EXEMPTION, closes: [], refs: [] });

    for (const override of [
      { authorLogin: "octocat[bot]" },
      { authorLogin: "mallory[bot]" },
      { authorType: "User" },
      { headRefName: "feature/dependabot-lookalike" },
      // The sdk-js automation lanes have no counterpart here and must not pass.
      { authorLogin: "github-actions[bot]", headRefName: "release-please--branches--main" },
      { authorLogin: "github-actions[bot]", headRefName: "automation/derived-artifacts-1-1" },
      { authorLogin: "github-actions[bot]", headRefName: "automation/mcp-certification-1-1" },
      { authorLogin: "github-actions[bot]", headRefName: "automation/kepler-audit-renewal-2026-09-01" },
    ]) {
      expect(
        automationExemption({
          authorLogin: "dependabot[bot]",
          authorType: "Bot",
          headRefName: "dependabot/npm_and_yarn/vite-8.1.4",
          ...override,
        }),
        `unexpected exemption for ${JSON.stringify(override)}`,
      ).toBeNull();
    }
  });
});

describe("pull request issue disposition CLI", () => {
  it("loads current GraphQL metadata and fails a reordered snapshot closed", async () => {
    const livePayload = graphqlPayload();
    const requests: string[] = [];
    const request = async (url: string, options?: Record<string, unknown>) => {
      requests.push(requestBodyQuery(options));
      if (!url.endsWith("/graphql")) throw new Error(`Unexpected request: ${url}`);
      return requestBodyQuery(options).includes("issueOrPullRequest") ? graphqlIssuePayload(40) : livePayload;
    };

    const current = await loadCurrentPullRequestDisposition({ repository, pullRequestNumber: 58 }, request);
    expect(current.body).toBe("Refs #40 (S2; the agent loop remains)");
    expect(current.closingIssueNumbers).toEqual([]);
    expect(current.issues).toEqual([issue(40)]);
    expect(requests).toHaveLength(3);
    expect(requests.filter((query) => query.includes("issueOrPullRequest"))).toHaveLength(1);

    let pullRequestCalls = 0;
    const reorderedRequest = async (_url: string, options?: Record<string, unknown>) => {
      if (requestBodyQuery(options).includes("issueOrPullRequest")) return graphqlIssuePayload(40);
      pullRequestCalls += 1;
      return pullRequestCalls === 1
        ? livePayload
        : graphqlPayload({ body: "Footer removed", updatedAt: "2026-08-25T22:01:00Z" });
    };
    await expect(
      loadCurrentPullRequestDisposition({ repository, pullRequestNumber: 58 }, reorderedRequest),
    ).rejects.toThrow(/changed during validation/u);

    const incompletePayload = graphqlPayload();
    // @ts-expect-error deliberately truncating the GraphQL response under test
    incompletePayload.data.repository.pullRequest.closingIssuesReferences.nodes = undefined;
    await expect(
      loadCurrentPullRequestDisposition({ repository, pullRequestNumber: 58 }, async () => incompletePayload),
    ).rejects.toThrow(/closingIssuesReferences metadata is missing/u);
  });

  it("validates offline event metadata and fails closed on ambiguous prose", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-pr-disposition-"));
    try {
      const eventPath = path.join(temporaryRoot, "event.json");
      const metadataPath = path.join(temporaryRoot, "metadata.json");
      const event = {
        repository: { full_name: repository },
        pull_request: {
          number: 58,
          title: "ci(workflows): enforce issue disposition",
          body: "A bounded change.\n\nCloses #57",
          user: { login: "mikemcdougall" },
          head: { ref: "ci/57-disposition-gate", sha: "a".repeat(40) },
        },
      };
      fs.writeFileSync(eventPath, JSON.stringify(event));
      fs.writeFileSync(metadataPath, JSON.stringify({ issues: [issue(57)], closingIssueNumbers: [57] }));

      const valid = spawnSync(process.execPath, [cli, "--event", eventPath, "--metadata", metadataPath], {
        cwd: root,
        encoding: "utf8",
      });
      expect(valid.status, valid.stderr).toBe(0);
      expect(valid.stdout).toMatch(/Validated honua-io\/honua-studio#58/u);
      expect(valid.stdout).toMatch(/Closes: #57/u);

      event.pull_request.body = "This does not close #41.\n\nRefs #40 (S2; S3 remains)";
      fs.writeFileSync(eventPath, JSON.stringify(event));
      fs.writeFileSync(metadataPath, JSON.stringify({ issues: [issue(40)], closingIssueNumbers: [41] }));
      const invalid = spawnSync(process.execPath, [cli, "--event", eventPath, "--metadata", metadataPath], {
        cwd: root,
        encoding: "utf8",
      });
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toMatch(/Closing keyword/u);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("exempts an allowlisted automation identity without API access", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "honua-pr-disposition-bot-"));
    try {
      const eventPath = path.join(temporaryRoot, "event.json");
      const metadataPath = path.join(temporaryRoot, "metadata.json");
      fs.writeFileSync(
        eventPath,
        JSON.stringify({
          repository: { full_name: repository },
          pull_request: {
            number: 59,
            title: "chore(deps): bump vite",
            body: "",
            user: { login: "dependabot[bot]", type: "Bot" },
            head: { ref: "dependabot/npm_and_yarn/vite-8.1.4", sha: "b".repeat(40) },
          },
        }),
      );
      fs.writeFileSync(metadataPath, JSON.stringify({ issues: [], closingIssueNumbers: [] }));
      const result = spawnSync(process.execPath, [cli, "--event", eventPath, "--metadata", metadataPath], {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/Exempt: Dependabot dependency update/u);

      fs.writeFileSync(
        metadataPath,
        JSON.stringify({
          repository,
          pullRequestNumber: 60,
          body: "",
          authorLogin: "github-actions[bot]",
          authorType: "Bot",
          headRefName: "automation/derived-artifacts-1-1",
          headSha: "c".repeat(40),
          headRepository: repository,
          baseRefName: "main",
          baseSha: "d".repeat(40),
          baseRepository: repository,
          title: "chore(evidence): regenerate derived artifacts",
          issues: [],
          closingIssueNumbers: [],
        }),
      );
      // No such lane exists here, so the sdk-js automation identity is not exempt.
      const dispatched = spawnSync(
        process.execPath,
        [cli, "--repository", repository, "--pull-request", "60", "--metadata", metadataPath],
        { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
      );
      expect(dispatched.status).toBe(1);
      expect(dispatched.stderr).toMatch(/The final nonblank line must be/u);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
