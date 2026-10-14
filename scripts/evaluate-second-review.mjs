import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { completedFirstPassCommit, evaluateSecondReview } from "./lib/second-review-gate.mjs";

const comments = JSON.parse(readFileSync("comments.json", "utf8")).flat();
const completedCommit = completedFirstPassCommit(comments, process.env.FIRST_PASS_REVIEWER);
const resolvedFirstPassCommits = {};
if (completedCommit) {
  try {
    // GitHub rejects ambiguous short SHAs. Never treat a prefix match as exact-head evidence.
    const resolved = execFileSync(
      "gh",
      ["api", `repos/${process.env.REPOSITORY}/commits/${completedCommit}`, "--jq", ".sha"],
      {
        encoding: "utf8",
        timeout: 15000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    if (/^[a-f0-9]{40}$/.test(resolved)) resolvedFirstPassCommits[completedCommit] = resolved;
  } catch {
    console.log("first_pass_summary_commit_resolution=failed");
  }
}

const result = evaluateSecondReview({
  pr: JSON.parse(readFileSync("pull-request.json", "utf8")).data.repository.pullRequest,
  comments,
  resolvedFirstPassCommits,
  repository: process.env.REPOSITORY,
  eventName: process.env.EVENT_NAME,
  postMergeAudit: process.env.POST_MERGE_AUDIT === "true",
  expectedHead: process.env.EXPECTED_HEAD_SHA ?? "",
  firstPassReviewer: process.env.FIRST_PASS_REVIEWER,
});
for (const [key, value] of Object.entries(result.checks)) if (!value) console.log(`blocked_by=${key}`);
console.log(`first_pass_threads=${result.firstPassThreads}`);
console.log(`unresolved_other=${result.unresolvedOther} (informational; does not gate)`);
console.log(`should_review=${result.shouldReview}`);
appendFileSync(
  process.env.GITHUB_OUTPUT,
  `head_sha=${result.headSha}\nmarker=${result.marker}\nreview_mode=${result.mode}\nshould_review=${result.shouldReview}\nthreads_digest_base64=${Buffer.from(result.resolvedThreads).subarray(0, 60000).toString("base64")}\n`,
);
appendFileSync(
  process.env.GITHUB_STEP_SUMMARY,
  `## Claude ${result.mode} gate\n\nPR #${process.env.PR_NUMBER} @ \`${result.headSha}\`\n\n${Object.entries(
    result.checks,
  )
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n")}\n`,
);
