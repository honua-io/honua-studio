import { appendFileSync, readFileSync } from "node:fs";
import { evaluateSecondReview } from "./lib/second-review-gate.mjs";

const result = evaluateSecondReview({
  pr: JSON.parse(readFileSync("pull-request.json", "utf8")).data.repository.pullRequest,
  comments: JSON.parse(readFileSync("comments.json", "utf8")).flat(),
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
