import fs from "node:fs";
import path from "node:path";

const fields = ["headSha", "verdict", "blockedReason", "findings"];
const findingFields = ["kind", "priority", "path", "line", "title", "detail"];
const reviewers = new Set(["claude[bot]", "claude", "github-actions[bot]"]);

/** Comment/dispatch events must hand off to an actual PR-associated run. */
export function selectEligibleReviewRun(response, expected) {
  if (
    expected.mode !== "second-review" ||
    !Array.isArray(response?.workflow_runs) ||
    response.total_count > response.workflow_runs.length
  )
    throw new Error("Incomplete eligible review run discovery.");
  const matches = response.workflow_runs.filter(
    (run) =>
      Number.isSafeInteger(run.id) &&
      run.id > 0 &&
      run.event === "pull_request" &&
      run.path === ".github/workflows/claude-second-review.yml" &&
      run.head_sha === expected.headSha &&
      run.head_repository?.full_name === expected.repository &&
      run.pull_requests?.some(
        (pr) =>
          pr.number === expected.prNumber && pr.head?.sha === expected.headSha && pr.base?.sha === expected.baseSha,
      ),
  );
  const latest = matches.sort((a, b) => b.id - a.id)[0];
  if (!latest) throw new Error("No exact-head PR-associated review run was found.");
  if (latest.status !== "completed") throw new Error("The eligible PR review is still active; let it finish.");
  return latest;
}
const markerText = /<!--\s*claude-(?:second-review|post-merge-audit):/u;
export const reviewResultSchema = {
  type: "object",
  additionalProperties: false,
  required: fields,
  properties: {
    headSha: { type: "string", pattern: "^[a-f0-9]{40}$" },
    verdict: { type: "string", enum: ["no-findings", "findings", "blocked"] },
    blockedReason: { type: "string", maxLength: 2000 },
    findings: {
      type: "array",
      maxItems: 25,
      items: {
        type: "object",
        additionalProperties: false,
        required: findingFields,
        properties: {
          kind: { type: "string", enum: ["fix", "question"] },
          priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
          path: { type: "string", maxLength: 500 },
          line: { type: "integer", minimum: 1, maximum: 1000000 },
          title: { type: "string", maxLength: 160 },
          detail: { type: "string", maxLength: 2000 },
        },
      },
    },
  },
};

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function text(value, limit, empty = false) {
  return (
    typeof value === "string" &&
    value.length <= limit &&
    (empty || value.trim().length > 0) &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13);
    }) &&
    !markerText.test(value)
  );
}
export function validateReviewResult(result, expected, snapshotDirectory) {
  if (
    !/^[a-f0-9]{40}$/u.test(expected.headSha) ||
    !/^[a-f0-9]{40}$/u.test(expected.baseSha) ||
    !["second-review", "post-merge-audit"].includes(expected.mode)
  )
    throw new Error("Invalid pinned review identity.");
  if (
    !exactKeys(result, fields) ||
    result.headSha !== expected.headSha ||
    !["no-findings", "findings", "blocked"].includes(result.verdict) ||
    !text(result.blockedReason, 2000, true) ||
    !Array.isArray(result.findings) ||
    result.findings.length > 25
  )
    throw new Error("The reviewer result is missing, malformed or bound to another head.");
  if (result.verdict === "blocked")
    throw new Error("The reviewer could not complete the review. No receipt was posted.");
  if (result.blockedReason !== "" || (result.verdict === "no-findings") !== (result.findings.length === 0))
    throw new Error("The review verdict conflicts with its findings.");
  for (const finding of result.findings) {
    if (
      !exactKeys(finding, findingFields) ||
      !["fix", "question"].includes(finding.kind) ||
      !["P0", "P1", "P2", "P3"].includes(finding.priority) ||
      !text(finding.path, 500) ||
      /[\\\n\r]/u.test(finding.path) ||
      finding.path.startsWith("/") ||
      finding.path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git") ||
      !Number.isInteger(finding.line) ||
      finding.line < 1 ||
      finding.line > 1000000 ||
      !text(finding.title, 160) ||
      /[\r\n]/u.test(finding.title) ||
      !text(finding.detail, 2000)
    )
      throw new Error("Invalid review finding.");
    if (snapshotDirectory) {
      const root = fs.realpathSync(snapshotDirectory);
      const file = fs.realpathSync(path.join(root, finding.path));
      if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile())
        throw new Error("Finding is outside the reviewed snapshot.");
      const bytes = fs.readFileSync(file);
      if (
        bytes.length > 2 * 1024 * 1024 ||
        bytes.includes(0) ||
        finding.line > bytes.toString("utf8").split("\n").length
      )
        throw new Error("Finding does not identify reviewed source.");
    }
  }
  return result;
}
export function requireCurrentReview(pr, expected) {
  if (
    !/^[a-f0-9]{40}$/u.test(expected.headSha) ||
    !/^[a-f0-9]{40}$/u.test(expected.baseSha) ||
    !["second-review", "post-merge-audit"].includes(expected.mode) ||
    pr.headRefOid !== expected.headSha ||
    pr.baseRefOid !== expected.baseSha ||
    pr.isDraft ||
    (expected.mode === "second-review" ? pr.state !== "OPEN" : pr.state !== "MERGED" || !pr.mergedAt)
  )
    throw new Error("The pull request head, base or lifecycle changed; review publication refused.");
}
export function reviewMarker(expected) {
  return `<!-- claude-${expected.mode}: ${expected.headSha} -->`;
}
export function reviewBody(result, expected) {
  validateReviewResult(result, expected);
  const audit =
    expected.mode === "post-merge-audit"
      ? "\n\nPost-merge audit; this result does not establish historical pre-merge clearance."
      : "";
  const findings = result.findings.map(
    (finding) =>
      `- **${finding.priority} ${finding.kind === "question" ? "Question: " : ""}${finding.title}** — ${finding.path}:${finding.line}\n\n  ${finding.detail.replaceAll("\n", "\n  ")}`,
  );
  return `${reviewMarker(expected)}${audit}\n\n${findings.length ? findings.join("\n\n") : "No findings."}\n`;
}
export function matchingReceipt(comments, expected) {
  return comments.find(
    (comment) =>
      comment.user?.type === "Bot" &&
      reviewers.has(comment.user?.login) &&
      typeof comment.body === "string" &&
      comment.body.split(/\r?\n/u)[0] === reviewMarker(expected) &&
      (expected.mode !== "post-merge-audit" ||
        comment.body.includes("Post-merge audit; this result does not establish historical pre-merge clearance.")),
  );
}
