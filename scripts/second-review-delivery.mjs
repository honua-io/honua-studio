import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  matchingReceipt,
  pinReviewBase,
  requireCurrentReview,
  reviewBody,
  reviewResultSchema,
  selectEligibleReviewRun,
  validateReviewResult,
} from "./lib/second-review-delivery.mjs";

// This is trusted workflow code. Candidate files are only read from the isolated snapshot.
if (process.env.GITHUB_ACTIONS !== "true") throw new Error("This entrypoint runs only in GitHub Actions.");
const directory = ".claude-second-review";
const metadataFile = path.join(directory, "identity.json");
function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
}
function boundedJson(filename) {
  const bytes = fs.readFileSync(filename);
  if (bytes.length > 100000) throw new Error("Review artifact exceeded its bound.");
  return JSON.parse(bytes.toString("utf8"));
}
function targetIdentity() {
  const target = {
    repository: process.env.GITHUB_REPOSITORY,
    prNumber: Number(process.env.PR_NUMBER),
  };
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(target.repository ?? "") ||
    !Number.isSafeInteger(target.prNumber) ||
    target.prNumber < 1
  )
    throw new Error("Invalid review target.");
  return target;
}
function identity() {
  const expected = {
    ...targetIdentity(),
    headSha: process.env.HEAD_SHA,
    baseSha: process.env.BASE_SHA,
    baseRefName: process.env.BASE_REF_NAME,
    mode: process.env.REVIEW_MODE,
  };
  // Reuse the result validator to check the pinned SHA/mode vocabulary.
  validateReviewResult(
    { headSha: expected.headSha, verdict: "no-findings", blockedReason: "", findings: [] },
    expected,
  );
  return expected;
}
function current(expected) {
  return JSON.parse(
    gh([
      "pr",
      "view",
      String(expected.prNumber),
      "--repo",
      expected.repository,
      "--json",
      "headRefOid,baseRefOid,baseRefName,state,mergedAt,isDraft",
    ]),
  );
}
const mode = process.argv[2];
if (mode === "schema") {
  console.log(JSON.stringify(reviewResultSchema));
} else if (mode === "pin-base") {
  const target = targetIdentity();
  const pr = JSON.parse(fs.readFileSync("pull-request.json", "utf8")).data.repository.pullRequest;
  const metadata = JSON.parse(gh(["api", `repos/${target.repository}/pulls/${target.prNumber}`]));
  const pinned = pinReviewBase(pr, metadata, target);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `base_sha=${pinned.baseSha}\nbase_ref_name=${pinned.baseRefName}\n`);
} else if (mode === "requeue") {
  const expected = identity();
  requireCurrentReview(current(expected), expected);
  const runs = JSON.parse(
    gh([
      "api",
      `repos/${expected.repository}/actions/workflows/claude-second-review.yml/runs?event=pull_request&head_sha=${expected.headSha}&per_page=100`,
    ]),
  );
  const eligible = selectEligibleReviewRun(runs, expected);
  let recorded;
  if (eligible.conclusion === "success") {
    const comments = JSON.parse(
      gh([
        "api",
        "--paginate",
        "--slurp",
        `repos/${expected.repository}/issues/${expected.prNumber}/comments?per_page=100`,
      ]),
    ).flat();
    recorded = matchingReceipt(comments, expected);
  }
  requireCurrentReview(current(expected), expected);
  if (eligible.conclusion === "success" && recorded) {
    console.log(
      `PR-associated review run ${eligible.id} succeeded with observed receipt ${recorded.id} for ${expected.headSha}.`,
    );
  } else {
    // Rerun the whole eligible workflow: rerunning only the failed publisher
    // would reuse the old gate's "not admitted" outputs indefinitely.
    gh(["api", `repos/${expected.repository}/actions/runs/${eligible.id}/rerun`, "--method", "POST"]);
    console.log(`Requeued PR-associated review run ${eligible.id} for ${expected.headSha}.`);
  }
} else if (mode === "prepare") {
  const expected = identity();
  requireCurrentReview(current(expected), expected);
  fs.mkdirSync(directory, { recursive: true });
  for (const [snapshot, sha] of [
    ["head", expected.headSha],
    ["base", expected.baseSha],
  ]) {
    const archiveFile = path.join(directory, `${snapshot}.zip`);
    try {
      const archive = execFileSync("gh", ["api", `repos/${expected.repository}/zipball/${sha}`], {
        timeout: 60000,
        maxBuffer: 64 * 1024 * 1024,
      });
      fs.writeFileSync(archiveFile, archive);
      const extractor = fileURLToPath(new URL("./lib/review-source-archive.py", import.meta.url));
      console.log(
        execFileSync("python3", [extractor, archiveFile, path.join(directory, snapshot)], { encoding: "utf8" }).trim(),
      );
    } finally {
      fs.rmSync(archiveFile, { force: true });
    }
  }
  const diff = gh([
    "api",
    `repos/${expected.repository}/compare/${expected.baseSha}...${expected.headSha}`,
    "--header",
    "Accept: application/vnd.github.diff",
  ]);
  requireCurrentReview(current(expected), expected);
  fs.writeFileSync(path.join(directory, "current.diff"), diff);
  fs.writeFileSync(metadataFile, JSON.stringify(expected));
} else if (mode === "validate") {
  const expected = boundedJson(metadataFile);
  const raw = process.env.STRUCTURED_REVIEW_RESULT;
  if (!raw || Buffer.byteLength(raw) > 100000) throw new Error("No bounded structured reviewer result was returned.");
  const result = validateReviewResult(
    JSON.parse(raw),
    expected,
    path.join(directory, "head"),
    path.join(directory, "base"),
  );
  requireCurrentReview(current(expected), expected);
  fs.writeFileSync(
    path.join(directory, "validated-result.json"),
    JSON.stringify({ schemaVersion: 1, expected, result }),
  );
} else if (["existing", "verify"].includes(mode)) {
  const expected = identity();
  requireCurrentReview(current(expected), expected);
  const comments = JSON.parse(
    gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${expected.repository}/issues/${expected.prNumber}/comments?per_page=100`,
    ]),
  ).flat();
  const found = matchingReceipt(comments, expected);
  requireCurrentReview(current(expected), expected);
  if (mode === "verify" && !found) throw new Error("No current-head review receipt was observed.");
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `exists=${Boolean(found)}\n`);
  console.log(found ? `Verified review receipt ${found.id} for ${expected.headSha}.` : "No existing review receipt.");
} else if (mode === "publish") {
  const expected = identity();
  const artifact = boundedJson(path.join(directory, "validated-result.json"));
  if (
    artifact.schemaVersion !== 1 ||
    !artifact.expected ||
    Object.keys(artifact.expected).length !== Object.keys(expected).length ||
    !Object.keys(expected).every((key) => artifact.expected[key] === expected[key])
  )
    throw new Error("Artifact identity differs from the admitted review.");
  const body = reviewBody(artifact.result, expected);
  requireCurrentReview(current(expected), expected);
  const comments = JSON.parse(
    gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${expected.repository}/issues/${expected.prNumber}/comments?per_page=100`,
    ]),
  ).flat();
  const recorded = matchingReceipt(comments, expected);
  if (recorded) {
    if (recorded.body !== body)
      throw new Error("Another review receipt already exists for this head; publication refused.");
    requireCurrentReview(current(expected), expected);
    console.log(`Review receipt ${recorded.id} already exists.`);
  } else {
    requireCurrentReview(current(expected), expected);
    const input = path.join(directory, "comment-input.json");
    fs.writeFileSync(input, JSON.stringify({ body }));
    const posted = JSON.parse(
      gh([
        "api",
        "--method",
        "POST",
        `repos/${expected.repository}/issues/${expected.prNumber}/comments`,
        "--input",
        input,
      ]),
    );
    const receipt = JSON.parse(gh(["api", `repos/${expected.repository}/issues/comments/${posted.id}`]));
    requireCurrentReview(current(expected), expected);
    if (!matchingReceipt([receipt], expected) || receipt.body !== body)
      throw new Error("The expected review receipt was not observed.");
    console.log(`Posted and verified review receipt ${receipt.id} for ${expected.headSha}.`);
  }
} else throw new Error("Expected schema, pin-base, requeue, prepare, validate, existing, verify or publish.");
