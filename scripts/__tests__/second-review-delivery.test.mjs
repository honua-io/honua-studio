import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  matchingReceipt,
  pinReviewBase,
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
  baseRefName: "main",
  mode: "second-review",
};
const result = () => ({ headSha: expected.headSha, verdict: "no-findings", blockedReason: "", findings: [] });
const finding = () => ({
  kind: "fix",
  priority: "P1",
  snapshot: "head",
  path: "src/map.ts",
  line: 1,
  title: "Retain the original command",
  detail: "Changing conversations must not create a replacement publication.",
});
const pr = () => ({
  headRefOid: expected.headSha,
  baseRefOid: expected.baseSha,
  baseRefName: expected.baseRefName,
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
  pull_requests: [
    {
      number: expected.prNumber,
      head: { sha: expected.headSha },
      base: { sha: expected.baseSha, ref: expected.baseRefName },
    },
  ],
  status: "completed",
  conclusion: "failure",
});
const pinPr = () => ({ ...pr(), number: expected.prNumber, headRepository: { nameWithOwner: expected.repository } });
const restPr = () => ({
  number: expected.prNumber,
  state: "open",
  merged_at: null,
  head: { sha: expected.headSha, repo: { full_name: expected.repository } },
  base: { sha: expected.baseSha, ref: expected.baseRefName },
});

test("pins an immutable open-PR snapshot and the recorded pre-merge base for retrospective audits", () => {
  assert.deepEqual(pinReviewBase(pinPr(), restPr(), expected), {
    baseSha: expected.baseSha,
    baseRefName: expected.baseRefName,
  });
  assert.deepEqual(pinReviewBase(pinPr(), { ...restPr(), base: { ...restPr().base, sha: "c".repeat(40) } }, expected), {
    baseSha: "c".repeat(40),
    baseRefName: expected.baseRefName,
  });
  const merged = { ...pinPr(), state: "MERGED", baseRefOid: expected.headSha };
  const recorded = { ...restPr(), state: "closed", merged_at: "2026-10-19T00:00:00Z" };
  assert.equal(pinReviewBase(merged, recorded, expected).baseSha, expected.baseSha);
  for (const changed of [
    { ...restPr(), number: 999 },
    { ...restPr(), head: { ...restPr().head, sha: "c".repeat(40) } },
    { ...restPr(), head: { ...restPr().head, repo: { full_name: "untrusted/fork" } } },
    { ...restPr(), base: { ...restPr().base, ref: "other" } },
    { ...restPr(), state: "closed" },
  ])
    assert.throws(() => pinReviewBase(pinPr(), changed, expected));
  assert.throws(() =>
    pinReviewBase(merged, { ...recorded, base: { ...recorded.base, sha: expected.headSha } }, expected),
  );
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
    { path: ".github/workflows/other.yml@main" },
    { path: ".github/workflows/claude-second-review.yml.backup@main" },
    { path: ".github/workflows/claude-second-review.yml@" },
    { path: undefined },
    {
      pull_requests: [
        { number: 999, head: { sha: expected.headSha }, base: { sha: expected.baseSha, ref: expected.baseRefName } },
      ],
    },
    {
      pull_requests: [
        { number: expected.prNumber, head: { sha: expected.headSha }, base: { sha: expected.baseSha, ref: "other" } },
      ],
    },
    { status: "in_progress" },
  ])
    assert.throws(() => selectEligibleReviewRun({ total_count: 1, workflow_runs: [{ ...run, ...change }] }, expected));
  assert.throws(() => selectEligibleReviewRun({ total_count: 101, workflow_runs: [run] }, expected));
  assert.throws(() =>
    selectEligibleReviewRun({ total_count: 1, workflow_runs: [run] }, { ...expected, mode: "post-merge-audit" }),
  );
  const advanced = {
    ...run,
    pull_requests: [
      {
        number: expected.prNumber,
        head: { sha: expected.headSha },
        base: { sha: "c".repeat(40), ref: expected.baseRefName },
      },
    ],
  };
  assert.equal(selectEligibleReviewRun({ total_count: 1, workflow_runs: [advanced] }, expected), advanced);
});

test("review discovery accepts GitHub's bare and ref-qualified workflow paths", () => {
  for (const suffix of ["", "@main", "@refs/pull/108/merge", `@${expected.headSha}`]) {
    const run = { ...eligibleRun(), path: `.github/workflows/claude-second-review.yml${suffix}` };
    assert.equal(selectEligibleReviewRun({ total_count: 1, workflow_runs: [run] }, expected), run);
  }
});

test("completed results produce the exact current-head receipt", () => {
  assert.equal(
    reviewBody(result(), expected),
    `<!-- claude-second-review: ${expected.headSha} -->\n<!-- claude-review-base: bWFpbg ${expected.baseSha} -->\n\nNo findings.\n`,
  );
  const audit = { ...expected, mode: "post-merge-audit" };
  const body = reviewBody(result(), audit);
  assert.ok(body.startsWith(`<!-- claude-post-merge-audit: ${expected.headSha} -->\n`));
  assert.ok(body.includes("Post-merge audit; this result does not establish historical pre-merge clearance."));
});

test("missing or control-bearing target branches cannot enter artifacts or review receipts", () => {
  for (const baseRefName of [undefined, "", "main\ninjected", " main", "m\u0000ain"]) {
    assert.throws(() => reviewBody(result(), { ...expected, baseRefName }));
  }
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
    { snapshot: "worktree" },
    { snapshot: undefined },
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

test("base locations preserve findings on deleted or renamed files and removed lines", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-deleted-source-"));
  const head = path.join(root, "head");
  const base = path.join(root, "base");
  try {
    for (const directory of [head, base]) fs.mkdirSync(path.join(directory, "src"), { recursive: true });
    fs.writeFileSync(path.join(base, "src/deleted.ts"), "old context\nremoved behavior\n");
    fs.writeFileSync(path.join(base, "src/old-name.ts"), "renamed behavior\n");
    fs.writeFileSync(path.join(head, "src/new-name.ts"), "renamed behavior\n");
    fs.writeFileSync(path.join(base, "src/map.ts"), "context\nremoved behavior\n");
    fs.writeFileSync(path.join(head, "src/map.ts"), "context");
    for (const [file, line] of [
      ["deleted.ts", 2],
      ["old-name.ts", 1],
      ["map.ts", 2],
    ]) {
      const location = { ...finding(), snapshot: "base", path: `src/${file}`, line };
      const value = { ...result(), verdict: "findings", findings: [location] };
      assert.equal(validateReviewResult(value, expected, head, base), value);
      assert.ok(reviewBody(value, expected).includes(`src/${file}:${line} (base snapshot)`));
      assert.throws(() =>
        validateReviewResult({ ...value, findings: [{ ...location, snapshot: "head" }] }, expected, head, base),
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("base locations retain source containment and actual line bounds", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-base-boundary-"));
  const base = path.join(root, "base");
  try {
    fs.mkdirSync(base);
    fs.writeFileSync(path.join(base, "deleted.ts"), "removed behavior\n");
    const location = { ...finding(), snapshot: "base", path: "deleted.ts" };
    const value = { ...result(), verdict: "findings", findings: [location] };
    assert.equal(validateReviewResult(value, expected, undefined, base), value);
    assert.throws(() => validateReviewResult(value, expected, root));
    for (const change of [{ line: 99 }, { path: "missing.ts" }, { path: "../secret" }])
      assert.throws(() =>
        validateReviewResult({ ...value, findings: [{ ...location, ...change }] }, expected, root, base),
      );
    if (process.platform !== "win32") {
      fs.writeFileSync(path.join(root, "secret"), "outside the admitted source\n");
      fs.symlinkSync(path.join(root, "secret"), path.join(base, "link.ts"));
      assert.throws(() =>
        validateReviewResult({ ...value, findings: [{ ...location, path: "link.ts" }] }, expected, root, base),
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rechecks head, target branch, draft status and pre/post-merge lifecycle while allowing target-tip advances", () => {
  requireCurrentReview(pr(), expected);
  requireCurrentReview({ ...pr(), baseRefOid: "c".repeat(40) }, expected);
  for (const change of [
    { headRefOid: "c".repeat(40) },
    { baseRefName: "other" },
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
    { ...valid, body: body.replace("bWFpbg", "b3RoZXI") },
    { ...valid, body: `<!-- claude-second-review: ${expected.headSha} -->\n\nNo findings.\n` },
    { ...valid, body: body.split("\n").slice(0, 2).join("\n") },
  ]) {
    assert.equal(matchingReceipt([value], expected), undefined);
  }
  assert.equal(matchingReceipt([valid], expected), valid);
  assert.equal(matchingReceipt([valid], { ...expected, baseSha: "c".repeat(40) }), valid);
});

test("admission and delivery agree on authenticated current-head receipts", () => {
  const input = {
    repository: expected.repository,
    eventName: "pull_request",
    comments: [],
    pr: {
      ...pr(),
      headRepository: { nameWithOwner: expected.repository },
      reviews: {
        totalCount: 1,
        nodes: [
          {
            author: { login: "chatgpt-codex-connector", __typename: "Bot" },
            state: "COMMENTED",
            commit: { oid: expected.headSha },
          },
        ],
      },
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

test("old formal reviews and resolved threads cannot admit a new-head collector", () => {
  const input = {
    repository: expected.repository,
    eventName: "pull_request",
    comments: [],
    pr: {
      ...pr(),
      headRepository: { nameWithOwner: expected.repository },
      reviews: {
        totalCount: 1,
        nodes: [
          {
            author: { login: "chatgpt-codex-connector", __typename: "Bot" },
            state: "COMMENTED",
            commit: { oid: "c".repeat(40) },
          },
        ],
      },
      reviewThreads: {
        totalCount: 1,
        nodes: [
          {
            isResolved: true,
            comments: {
              nodes: [{ author: { login: "chatgpt-codex-connector", __typename: "Bot" }, body: "Prior finding" }],
            },
          },
        ],
      },
    },
  };
  assert.equal(evaluateSecondReview(input).checks.first_pass_done, false);
  assert.equal(evaluateSecondReview(input).shouldReview, false);
  assert.match(evaluateSecondReview(input).resolvedThreads, /Prior finding/u);
});

function runPublisher({
  mutateArtifact,
  collectedResult = result(),
  publishAfterValidation = false,
  env = {},
  initialReceipt,
  repeat = false,
  command = "publish",
  reviewRun = eligibleRun(),
  pinMetadata = restPr(),
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-publisher-"));
  try {
    const bin = path.join(root, "bin");
    const output = path.join(root, ".claude-second-review");
    fs.mkdirSync(bin);
    fs.mkdirSync(output);
    const artifact = { schemaVersion: 1, expected, result: collectedResult };
    mutateArtifact?.(artifact);
    fs.writeFileSync(path.join(output, "validated-result.json"), JSON.stringify(artifact));
    fs.writeFileSync(
      path.join(root, "pull-request.json"),
      JSON.stringify({ data: { repository: { pullRequest: pinPr() } } }),
    );
    if (command === "prepare") {
      const fixture = spawnSync(
        "python3",
        [
          "-c",
          "import zipfile\nfor filename in ['fixture.zip','base-fixture.zip']:\n with zipfile.ZipFile(filename,'w') as z:\n  z.writestr('repo/src/map.ts',\"throw new Error('never execute');\\n\")\n  if filename=='base-fixture.zip': z.writestr('repo/src/deleted.ts','removed behavior\\n')",
        ],
        { cwd: root, encoding: "utf8", timeout: 15000 },
      );
      assert.equal(fixture.status, 0, fixture.stderr);
    }
    if (command === "validate") {
      fs.writeFileSync(path.join(output, "identity.json"), JSON.stringify(expected));
      for (const snapshot of ["head", "base"]) fs.mkdirSync(path.join(output, snapshot, "src"), { recursive: true });
      fs.writeFileSync(path.join(output, "head/src/map.ts"), "current behavior\n");
      fs.writeFileSync(path.join(output, "base/src/deleted.ts"), "removed behavior\n");
    }
    if (initialReceipt) fs.writeFileSync(path.join(root, "receipt.json"), JSON.stringify(initialReceipt));
    const stub = `#!${process.execPath}
const fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync('trace.jsonl',JSON.stringify(a)+'\\n');
const receipt=()=>JSON.parse(fs.readFileSync('receipt.json','utf8'));
if(a[0]==='pr'&&a[1]==='view'){
const p=JSON.parse(process.env.TEST_PR);
if(process.env.CHANGED_HEAD==='true'||process.env.CHANGE_AFTER_POST==='true'&&fs.existsSync('receipt.json')||process.env.CHANGE_AFTER_SNAPSHOT==='true'&&fs.existsSync('.claude-second-review/head'))p.headRefOid='c'.repeat(40);
if(process.env.ADVANCED_BASE==='true')p.baseRefOid='c'.repeat(40);
if(process.env.RETARGETED_BASE==='true')p.baseRefName='other';
console.log(JSON.stringify(p));
}else if(a[0]==='api'&&a[1].includes('/compare/'))console.log('diff --git a/src/map.ts b/src/map.ts');
else if(a[0]==='api'&&a[1].includes('/zipball/'))process.stdout.write(fs.readFileSync(a[1].endsWith('/'+process.env.BASE_SHA)?'base-fixture.zip':'fixture.zip'));
else if(a[0]==='api'&&a[1].includes('/pulls/'))console.log(process.env.TEST_PIN_PR);
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
      BASE_REF_NAME: expected.baseRefName,
      REVIEW_MODE: expected.mode,
      STRUCTURED_REVIEW_RESULT: JSON.stringify(collectedResult),
      TEST_PR: JSON.stringify(pr()),
      TEST_PIN_PR: JSON.stringify(pinMetadata),
      TEST_REVIEW_RUNS: JSON.stringify({ total_count: 1, workflow_runs: [reviewRun] }),
      GITHUB_OUTPUT: path.join(root, "outputs"),
    };
    const runs = [
      spawnSync(process.execPath, [script, command], { cwd: root, env: childEnv, encoding: "utf8", timeout: 15000 }),
    ];
    if (publishAfterValidation && runs[0].status === 0)
      runs.push(
        spawnSync(process.execPath, [script, "publish"], {
          cwd: root,
          env: childEnv,
          encoding: "utf8",
          timeout: 15000,
        }),
      );
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
      baseDeletedSource: fs.existsSync(path.join(output, "base/src/deleted.ts"))
        ? fs.readFileSync(path.join(output, "base/src/deleted.ts"), "utf8")
        : null,
      headHasDeletedSource: fs.existsSync(path.join(output, "head/src/deleted.ts")),
      archiveRemoved: ["source.zip", "head.zip", "base.zip"].every((name) => !fs.existsSync(path.join(output, name))),
      outputs: fs.existsSync(path.join(root, "outputs")) ? fs.readFileSync(path.join(root, "outputs"), "utf8") : "",
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const posts = (value) => value.trace.filter((args) => args.includes("POST"));

test("the actual base-pinning CLI uses canonical PR metadata without any mutation", () => {
  const value = runPublisher({ command: "pin-base" });
  assert.equal(value.runs[0].status, 0, value.runs[0].stderr);
  assert.equal(value.outputs, `base_sha=${expected.baseSha}\nbase_ref_name=${expected.baseRefName}\n`);
  assert.equal(posts(value).length, 0);
});

test("base-pinning refuses head, target and lifecycle races without producing a review identity or receipt", () => {
  for (const pinMetadata of [
    { ...restPr(), head: { ...restPr().head, sha: "c".repeat(40) } },
    { ...restPr(), base: { ...restPr().base, ref: "other" } },
    { ...restPr(), state: "closed", merged_at: "2026-10-19T22:00:00Z" },
  ]) {
    const value = runPublisher({ command: "pin-base", pinMetadata });
    assert.notEqual(value.runs[0].status, 0);
    assert.match(value.runs[0].stderr, /PR snapshot changed/u);
    assert.equal(value.outputs, "");
    assert.equal(value.receipt, null);
    assert.equal(posts(value).length, 0);
  }
});

test("comment/manual admission requeues the whole exact-head PR workflow, not only its failed publisher", () => {
  const value = runPublisher({
    command: "requeue",
    reviewRun: { ...eligibleRun(), path: ".github/workflows/claude-second-review.yml@main" },
  });
  assert.equal(value.runs[0].status, 0, value.runs[0].stderr);
  assert.deepEqual(posts(value), [["api", `repos/${expected.repository}/actions/runs/123/rerun`, "--method", "POST"]]);
});

test("requeue refuses stale/foreign events and does not rerun still-active PR reviews", () => {
  for (const options of [
    { env: { CHANGED_HEAD: "true" } },
    { reviewRun: { ...eligibleRun(), event: "workflow_dispatch" } },
    { reviewRun: { ...eligibleRun(), status: "in_progress" } },
  ]) {
    const value = runPublisher({ command: "requeue", ...options });
    assert.notEqual(value.runs[0].status, 0);
    assert.equal(posts(value).length, 0);
  }
});

test("a successful run with a deleted or untrusted receipt is requeued for actual review recovery", () => {
  const valid = { id: 99, user: { login: "github-actions[bot]", type: "Bot" }, body: reviewBody(result(), expected) };
  for (const initialReceipt of [
    undefined,
    { ...valid, user: { login: "github-actions[bot]", type: "User" } },
    { ...valid, body: valid.body.replace(expected.headSha, "c".repeat(40)) },
  ]) {
    const value = runPublisher({
      command: "requeue",
      reviewRun: { ...eligibleRun(), conclusion: "success" },
      initialReceipt,
    });
    assert.equal(value.runs[0].status, 0, value.runs[0].stderr);
    assert.deepEqual(posts(value), [
      ["api", `repos/${expected.repository}/actions/runs/123/rerun`, "--method", "POST"],
    ]);
  }
});

test("a successful PR review with an observed authenticated receipt coalesces without another rerun", () => {
  const succeeded = runPublisher({
    command: "requeue",
    reviewRun: { ...eligibleRun(), conclusion: "success" },
    initialReceipt: {
      id: 99,
      user: { login: "github-actions[bot]", type: "Bot" },
      body: reviewBody(result(), expected),
    },
  });
  assert.equal(succeeded.runs[0].status, 0, succeeded.runs[0].stderr);
  assert.equal(posts(succeeded).length, 0);
});

test("the actual collector reads both admitted commit archives and removes compressed inputs", () => {
  const value = runPublisher({ command: "prepare" });
  assert.equal(value.runs[0].status, 0, value.runs[0].stderr);
  assert.ok(
    value.trace.some(
      (args) => args[0] === "api" && args[1] === `repos/${expected.repository}/zipball/${expected.headSha}`,
    ),
  );
  assert.ok(
    value.trace.some(
      (args) => args[0] === "api" && args[1] === `repos/${expected.repository}/zipball/${expected.baseSha}`,
    ),
  );
  assert.ok(
    value.trace.some(
      (args) =>
        args[0] === "api" &&
        args[1] === `repos/${expected.repository}/compare/${expected.baseSha}...${expected.headSha}` &&
        args.includes("Accept: application/vnd.github.diff"),
    ),
  );
  assert.equal(value.source, "throw new Error('never execute');\n");
  assert.equal(value.baseDeletedSource, "removed behavior\n");
  assert.equal(value.headHasDeletedSource, false);
  assert.equal(value.prepared, true);
  assert.equal(value.archiveRemoved, true);
  assert.equal(posts(value).length, 0);
});

test("the actual validator and publisher deliver a deleted-source finding and refuse the wrong snapshot or line", () => {
  const location = { ...finding(), snapshot: "base", path: "src/deleted.ts" };
  const value = runPublisher({
    command: "validate",
    publishAfterValidation: true,
    collectedResult: { ...result(), verdict: "findings", findings: [location] },
  });
  assert.equal(value.runs.length, 2);
  for (const run of value.runs) assert.equal(run.status, 0, run.stderr);
  assert.equal(posts(value).length, 1);
  assert.ok(value.receipt.body.includes("src/deleted.ts:1 (base snapshot)"));
  for (const change of [{ snapshot: "head" }, { line: 99 }]) {
    const invalid = runPublisher({
      command: "validate",
      publishAfterValidation: true,
      collectedResult: { ...result(), verdict: "findings", findings: [{ ...location, ...change }] },
    });
    assert.notEqual(invalid.runs[0].status, 0);
    assert.equal(posts(invalid).length, 0);
  }
});

test("collection and publication use an immutable comparison despite unrelated target merges, but reject retargeting", () => {
  for (const command of ["prepare", "publish"]) {
    const advanced = runPublisher({ command, env: { ADVANCED_BASE: "true" } });
    assert.equal(advanced.runs[0].status, 0, advanced.runs[0].stderr);
    const retargeted = runPublisher({ command, env: { RETARGETED_BASE: "true" } });
    assert.notEqual(retargeted.runs[0].status, 0);
    assert.equal(posts(retargeted).length, 0);
  }
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
  const basePin = workflow.split("      - name: Pin the review base\n")[1].split("\n  requeue:\n")[0];
  assert.match(basePin, /if: steps.evaluate.outputs.eligible_for_receipt == 'true'/u);
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
