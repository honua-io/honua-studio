import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  matchingReceipt,
  requireCurrentReview,
  reviewBody,
  selectEligibleReviewRun,
  validateReviewResult,
} from "../lib/second-review-delivery.mjs";
import { evaluateSecondReview } from "../lib/second-review-gate.mjs";

const expected = {
  repository: "honua-io/honua-studio",
  prNumber: 108,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  mode: "second-review",
};
const result = () => ({ headSha: expected.headSha, verdict: "no-findings", blockedReason: "", findings: [] });
const finding = () => ({
  kind: "fix",
  priority: "P1",
  path: "src/map.ts",
  line: 1,
  title: "Retain the original command",
  detail: "Changing conversations must not create a replacement publication.",
});
const pr = () => ({
  headRefOid: expected.headSha,
  baseRefOid: expected.baseSha,
  state: "OPEN",
  isDraft: false,
  mergedAt: null,
});
const eligibleRun = () => ({
  id: 123,
  event: "pull_request",
  path: ".github/workflows/claude-second-review.yml",
  head_sha: expected.headSha,
  head_repository: { full_name: expected.repository },
  pull_requests: [{ number: expected.prNumber, head: { sha: expected.headSha }, base: { sha: expected.baseSha } }],
  status: "completed",
  conclusion: "failure",
});

test("comment admission selects only the exact PR-associated head/base/repository workflow", () => {
  const run = eligibleRun();
  assert.equal(selectEligibleReviewRun({ total_count: 1, workflow_runs: [run] }, expected), run);
  for (const change of [
    { event: "issue_comment" },
    { event: "workflow_dispatch" },
    { head_sha: "c".repeat(40) },
    { head_repository: { full_name: "untrusted/fork" } },
    { path: ".github/workflows/other.yml" },
    { pull_requests: [{ number: 999, head: { sha: expected.headSha }, base: { sha: expected.baseSha } }] },
    { pull_requests: [{ number: expected.prNumber, head: { sha: expected.headSha }, base: { sha: "c".repeat(40) } }] },
    { status: "in_progress" },
  ])
    assert.throws(() => selectEligibleReviewRun({ total_count: 1, workflow_runs: [{ ...run, ...change }] }, expected));
  assert.throws(() => selectEligibleReviewRun({ total_count: 101, workflow_runs: [run] }, expected));
  assert.throws(() =>
    selectEligibleReviewRun({ total_count: 1, workflow_runs: [run] }, { ...expected, mode: "post-merge-audit" }),
  );
});

test("completed results produce the exact current-head receipt", () => {
  assert.equal(reviewBody(result(), expected), `<!-- claude-second-review: ${expected.headSha} -->\n\nNo findings.\n`);
  const audit = { ...expected, mode: "post-merge-audit" };
  const body = reviewBody(result(), audit);
  assert.ok(body.startsWith(`<!-- claude-post-merge-audit: ${expected.headSha} -->\n`));
  assert.ok(body.includes("Post-merge audit; this result does not establish historical pre-merge clearance."));
});

for (const [name, change] of [
  ["missing", () => undefined],
  ["wrong head", (value) => ({ ...value, headSha: "c".repeat(40) })],
  ["unknown verdict", (value) => ({ ...value, verdict: "success" })],
  ["blocked", (value) => ({ ...value, verdict: "blocked", blockedReason: "Source could not be inspected." })],
  ["extra fields", (value) => ({ ...value, command: "publish" })],
  ["inconsistent findings", (value) => ({ ...value, findings: [finding()] })],
  ["empty findings verdict", (value) => ({ ...value, verdict: "findings" })],
  ["unexplained completion", (value) => ({ ...value, blockedReason: "Permission denied." })],
])
  test(`refuses ${name} output before publication`, () => {
    assert.throws(() => reviewBody(change(result()), expected));
  });

for (const target of ["../secret", "/etc/passwd", "src/../../secret", "src\\map.ts", ".git/config", "src//map.ts"]) {
  test(`refuses finding path ${target}`, () => {
    assert.throws(() =>
      reviewBody({ ...result(), verdict: "findings", findings: [{ ...finding(), path: target }] }, expected),
    );
  });
}

test("finding bounds and embedded review markers cannot forge another receipt", () => {
  for (const change of [
    { line: 0 },
    { line: 1.2 },
    { title: "a\nb" },
    { detail: "x".repeat(2001) },
    { detail: `<!-- claude-second-review: ${"c".repeat(40)} -->` },
    { priority: "P99" },
    { kind: "command" },
  ]) {
    assert.throws(() =>
      reviewBody({ ...result(), verdict: "findings", findings: [{ ...finding(), ...change }] }, expected),
    );
  }
  assert.throws(() =>
    reviewBody({ ...result(), verdict: "findings", findings: Array.from({ length: 26 }, finding) }, expected),
  );
});

test("checks finding locations against actual pinned source without executing it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-source-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "review-outside-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src/map.ts"), "throw new Error('candidate code must not execute');\n");
    const value = { ...result(), verdict: "findings", findings: [finding()] };
    assert.equal(validateReviewResult(value, expected, root), value);
    assert.throws(() => validateReviewResult({ ...value, findings: [{ ...finding(), line: 10 }] }, expected, root));
    assert.throws(() =>
      validateReviewResult({ ...value, findings: [{ ...finding(), path: "missing.ts" }] }, expected, root),
    );
    if (process.platform !== "win32") {
      fs.writeFileSync(path.join(outside, "secret"), "outside the admitted source\n");
      fs.symlinkSync(outside, path.join(root, "outside"));
      assert.throws(() =>
        validateReviewResult({ ...value, findings: [{ ...finding(), path: "outside/secret" }] }, expected, root),
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("rechecks head, base, draft status and pre/post-merge lifecycle", () => {
  requireCurrentReview(pr(), expected);
  for (const change of [
    { headRefOid: "c".repeat(40) },
    { baseRefOid: "c".repeat(40) },
    { isDraft: true },
    { state: "CLOSED" },
    { state: "MERGED", mergedAt: "2026-10-19T00:00:00Z" },
  ]) {
    assert.throws(() => requireCurrentReview({ ...pr(), ...change }, expected));
  }
  const audit = { ...expected, mode: "post-merge-audit" };
  assert.throws(() => requireCurrentReview(pr(), audit));
  requireCurrentReview({ ...pr(), state: "MERGED", mergedAt: "2026-10-19T00:00:00Z" }, audit);
});

test("receipt reconciliation ignores quoted, wrong-mode, wrong-head and untrusted markers", () => {
  const body = reviewBody(result(), expected);
  const valid = { id: 99, user: { login: "github-actions[bot]", type: "Bot" }, body };
  for (const value of [
    { ...valid, user: { login: "untrusted", type: "Bot" } },
    { ...valid, user: { login: "claude", type: "User" } },
    { ...valid, body: `quoted\n${body}` },
    { ...valid, body: body.replace(expected.headSha, "c".repeat(40)) },
    { ...valid, body: body.replace("second-review", "post-merge-audit") },
  ]) {
    assert.equal(matchingReceipt([value], expected), undefined);
  }
  assert.equal(matchingReceipt([valid], expected), valid);
});

test("admission and delivery agree on authenticated current-head receipts", () => {
  const input = {
    repository: expected.repository,
    eventName: "pull_request",
    comments: [],
    pr: {
      ...pr(),
      headRepository: { nameWithOwner: expected.repository },
      reviews: { totalCount: 1, nodes: [{ author: { login: "chatgpt-codex-connector" } }] },
      reviewThreads: { totalCount: 0, nodes: [] },
    },
  };
  const receipt = { user: { login: "github-actions[bot]", type: "Bot" }, body: reviewBody(result(), expected) };
  assert.equal(evaluateSecondReview({ ...input, comments: [receipt] }).shouldReview, false);
  assert.equal(
    evaluateSecondReview({ ...input, comments: [{ ...receipt, user: { login: "claude", type: "User" } }] })
      .shouldReview,
    true,
  );
});

function runPublisher({
  mutateArtifact,
  env = {},
  initialReceipt,
  repeat = false,
  command = "publish",
  reviewRun = eligibleRun(),
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-publisher-"));
  try {
    const bin = path.join(root, "bin");
    const output = path.join(root, ".claude-second-review");
    fs.mkdirSync(bin);
    fs.mkdirSync(output);
    const artifact = { schemaVersion: 1, expected, result: result() };
    mutateArtifact?.(artifact);
    fs.writeFileSync(path.join(output, "validated-result.json"), JSON.stringify(artifact));
    if (command === "prepare") {
      const fixture = spawnSync(
        "python3",
        [
          "-c",
          "import zipfile\nwith zipfile.ZipFile('fixture.zip','w') as z:\n z.writestr('repo/src/map.ts',\"throw new Error('never execute');\\n\")",
        ],
        { cwd: root, encoding: "utf8", timeout: 15000 },
      );
      assert.equal(fixture.status, 0, fixture.stderr);
    }
    if (initialReceipt) fs.writeFileSync(path.join(root, "receipt.json"), JSON.stringify(initialReceipt));
    const stub = `#!${process.execPath}
const fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync('trace.jsonl',JSON.stringify(a)+'\\n');
const receipt=()=>JSON.parse(fs.readFileSync('receipt.json','utf8'));
if(a[0]==='pr'&&a[1]==='view'){
const p=JSON.parse(process.env.TEST_PR);
if(process.env.CHANGED_HEAD==='true'||process.env.CHANGE_AFTER_POST==='true'&&fs.existsSync('receipt.json')||process.env.CHANGE_AFTER_SNAPSHOT==='true'&&fs.existsSync('.claude-second-review/head'))p.headRefOid='c'.repeat(40);
console.log(JSON.stringify(p));
}else if(a[0]==='pr'&&a[1]==='diff')console.log('diff --git a/src/map.ts b/src/map.ts');
else if(a[0]==='api'&&a[1].includes('/zipball/'))process.stdout.write(fs.readFileSync('fixture.zip'));
else if(a[0]==='api'&&a[1].includes('/actions/workflows/'))console.log(process.env.TEST_REVIEW_RUNS);
else if(a[0]==='api'&&a[1].endsWith('/rerun')&&a.includes('POST'))console.log('{}');
else if(a.includes('--method')){
const body=JSON.parse(fs.readFileSync(a[a.indexOf('--input')+1],'utf8')).body;
const r={id:99,user:{login:'github-actions[bot]',type:process.env.SPOOFED_USER==='true'?'User':'Bot'},body};
fs.writeFileSync('receipt.json',JSON.stringify(r));
if(process.env.LOST_RESPONSE==='true')process.exit(1);
console.log(JSON.stringify(r));
}else if(a.includes('--paginate'))console.log(JSON.stringify([fs.existsSync('receipt.json')?[receipt()]:[]]));
else if(a[0]==='api'&&a[1].endsWith('/99'))console.log(JSON.stringify(receipt()));
else process.exit(90);
`;
    fs.writeFileSync(path.join(bin, "gh"), stub, { mode: 0o755 });
    const script = fileURLToPath(new URL("../second-review-delivery.mjs", import.meta.url));
    const childEnv = {
      ...process.env,
      ...env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: expected.repository,
      PR_NUMBER: String(expected.prNumber),
      HEAD_SHA: expected.headSha,
      BASE_SHA: expected.baseSha,
      REVIEW_MODE: expected.mode,
      TEST_PR: JSON.stringify(pr()),
      TEST_REVIEW_RUNS: JSON.stringify({ total_count: 1, workflow_runs: [reviewRun] }),
      GITHUB_OUTPUT: path.join(root, "outputs"),
    };
    const runs = [
      spawnSync(process.execPath, [script, command], { cwd: root, env: childEnv, encoding: "utf8", timeout: 15000 }),
    ];
    if (repeat)
      runs.push(
        spawnSync(process.execPath, [script, command], {
          cwd: root,
          env: { ...childEnv, LOST_RESPONSE: "false" },
          encoding: "utf8",
          timeout: 15000,
        }),
      );
    const trace = fs.existsSync(path.join(root, "trace.jsonl"))
      ? fs
          .readFileSync(path.join(root, "trace.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
    return {
      runs,
      trace,
      receipt: fs.existsSync(path.join(root, "receipt.json"))
        ? JSON.parse(fs.readFileSync(path.join(root, "receipt.json"), "utf8"))
        : null,
      prepared: fs.existsSync(path.join(output, "identity.json")),
      source: fs.existsSync(path.join(output, "head/src/map.ts"))
        ? fs.readFileSync(path.join(output, "head/src/map.ts"), "utf8")
        : null,
      archiveRemoved: !fs.existsSync(path.join(output, "source.zip")),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const posts = (value) => value.trace.filter((args) => args.includes("POST"));

test("comment/manual admission requeues the whole exact-head PR workflow, not only its failed publisher", () => {
  const value = runPublisher({ command: "requeue" });
  assert.equal(value.runs[0].status, 0, value.runs[0].stderr);
  assert.deepEqual(posts(value), [["api", `repos/${expected.repository}/actions/runs/123/rerun`, "--method", "POST"]]);
});

test("requeue refuses stale/foreign events and does not rerun successful or still-active PR reviews", () => {
  for (const options of [
    { env: { CHANGED_HEAD: "true" } },
    { reviewRun: { ...eligibleRun(), event: "workflow_dispatch" } },
    { reviewRun: { ...eligibleRun(), status: "in_progress" } },
  ]) {
    const value = runPublisher({ command: "requeue", ...options });
    assert.notEqual(value.runs[0].status, 0);
    assert.equal(posts(value).length, 0);
  }
  const succeeded = runPublisher({ command: "requeue", reviewRun: { ...eligibleRun(), conclusion: "success" } });
  assert.equal(succeeded.runs[0].status, 0, succeeded.runs[0].stderr);
  assert.equal(posts(succeeded).length, 0);
});

test("the actual collector reads only the admitted commit archive and removes the compressed input", () => {
  const value = runPublisher({ command: "prepare" });
  assert.equal(value.runs[0].status, 0, value.runs[0].stderr);
  assert.deepEqual(
    value.trace.filter((args) => args.includes("api")),
    [["api", `repos/${expected.repository}/zipball/${expected.headSha}`]],
  );
  assert.equal(value.source, "throw new Error('never execute');\n");
  assert.equal(value.prepared, true);
  assert.equal(value.archiveRemoved, true);
  assert.equal(posts(value).length, 0);
});

test("the actual collector rejects head changes before and after source download", () => {
  for (const env of [{ CHANGED_HEAD: "true" }, { CHANGE_AFTER_SNAPSHOT: "true" }]) {
    const value = runPublisher({ command: "prepare", env });
    assert.notEqual(value.runs[0].status, 0);
    assert.equal(value.prepared, false);
    assert.equal(value.archiveRemoved, true);
    assert.equal(posts(value).length, 0);
  }
});

test("the actual publisher posts once and verifies its observed receipt", () => {
  const value = runPublisher();
  assert.equal(value.runs[0].status, 0, value.runs[0].stderr);
  assert.equal(posts(value).length, 1);
  assert.equal(value.receipt.body, reviewBody(result(), expected));
});

test("the actual publisher refuses changed heads, foreign artifacts and blocked results before POST", () => {
  for (const options of [
    { env: { CHANGED_HEAD: "true" } },
    {
      mutateArtifact: (value) => {
        value.expected = { ...expected, prNumber: 999 };
      },
    },
    {
      mutateArtifact: (value) => {
        value.result.verdict = "blocked";
      },
    },
  ]) {
    const value = runPublisher(options);
    assert.notEqual(value.runs[0].status, 0);
    assert.equal(posts(value).length, 0);
  }
});

test("a lost comment response reconciles without a second POST", () => {
  const value = runPublisher({ env: { LOST_RESPONSE: "true" }, repeat: true });
  assert.notEqual(value.runs[0].status, 0);
  assert.equal(value.runs[1].status, 0, value.runs[1].stderr);
  assert.equal(posts(value).length, 1);
});

test("a changed head or spoofed receipt after posting cannot report completion", () => {
  for (const env of [{ CHANGE_AFTER_POST: "true" }, { SPOOFED_USER: "true" }]) {
    const value = runPublisher({ env });
    assert.notEqual(value.runs[0].status, 0);
    assert.equal(posts(value).length, 1);
  }
});

test("verification fails without a receipt even if the reviewer action succeeded", () => {
  const missing = runPublisher({ command: "verify" });
  assert.notEqual(missing.runs[0].status, 0);
  assert.equal(posts(missing).length, 0);
  const present = runPublisher({
    command: "verify",
    initialReceipt: {
      id: 99,
      user: { login: "github-actions[bot]", type: "Bot" },
      body: reviewBody(result(), expected),
    },
  });
  assert.equal(present.runs[0].status, 0, present.runs[0].stderr);
  assert.equal(posts(present).length, 0);
});

test("the required review check belongs to the trusted publisher and the model has read-only credentials/tools", () => {
  const workflow = fs.readFileSync(
    new URL("../../.github/workflows/claude-second-review.yml", import.meta.url),
    "utf8",
  );
  const collect = workflow.split("\n  review:\n")[1].split("\n  publish:\n")[0];
  const publish = workflow.split("\n  publish:\n")[1];
  assert.match(collect, /pull-requests: read/u);
  assert.doesNotMatch(collect, /pull-requests: write|id-token: write/u);
  assert.match(collect, /github_token: \$\{\{ github.token \}\}/u);
  assert.doesNotMatch(collect, /ref: \$\{\{ needs.gate.outputs.head_sha \}\}/u);
  assert.match(collect, /--disallowedTools "Bash,Edit,Write,Agent,WebFetch,WebSearch"/u);
  assert.match(publish, /name: Claude second-pass review/u);
  assert.match(publish, /always\(\) && needs.gate.result != 'skipped'/u);
  for (const job of [collect, publish]) {
    assert.match(job, /github.event_name == 'pull_request'/u);
    assert.match(job, /github.event_name == 'pull_request_review'/u);
    assert.match(job, /needs.gate.outputs.review_mode == 'post-merge-audit'/u);
  }
  const requeue = workflow.split("\n  requeue:\n")[1].split("\n  review:\n")[0];
  assert.match(requeue, /actions: write/u);
  assert.doesNotMatch(requeue, /secrets\.|pull-requests: write/u);
  assert.match(requeue, /node scripts\/second-review-delivery.mjs requeue/u);
  assert.match(publish, /node scripts\/second-review-delivery.mjs verify/u);
  assert.match(publish, /ELIGIBLE: \$\{\{ needs.gate.outputs.eligible_for_receipt \}\}/u);
  assert.match(publish, /artifact-ids: \$\{\{ needs.review.outputs.artifact_id \}\}/u);
});

test("candidate archive extraction preserves inert data and rejects boundary escapes", () => {
  const suite = fileURLToPath(new URL("./review-source-archive.test.py", import.meta.url));
  const execution = spawnSync("python3", [suite], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.ifError(execution.error);
  assert.equal(execution.status, 0, execution.stderr);
});
