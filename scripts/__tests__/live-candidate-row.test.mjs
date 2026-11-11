import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { armedCandidateRow, switchedOffCandidateRow } from "../live-candidate-row.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const workflowPath = resolve(repoRoot, ".github/workflows/live-candidate-journeys.yml");
const qualifyPath = resolve(repoRoot, ".github/workflows/live-compose-qualify.yml");
const scriptPath = fileURLToPath(new URL("../live-candidate-row.mjs", import.meta.url));
const lock = JSON.parse(readFileSync(new URL("../live-compose-images.json", import.meta.url), "utf8"));
const otherSha = "0123456789abcdef0123456789abcdef01234567";

test("a candidate row stays switched off unless journeys are armed", () => {
  const row = switchedOffCandidateRow(lock, lock.server.revision);
  assert.equal(row.status, "switched-off");
  assert.equal(row.journeys, "not-run");
  assert.equal(row.candidate_sha, lock.server.revision);
});

test("an armed row is ready only when the pinned server revision is that SHA", () => {
  const ready = armedCandidateRow(lock, lock.server.revision);
  assert.equal(ready.status, "armed");
  assert.equal(ready.journeys, "ready");

  const mismatch = armedCandidateRow(lock, otherSha);
  assert.equal(mismatch.status, "lock-mismatch");
  assert.equal(mismatch.journeys, "not-run");
  assert.equal(mismatch.lock_revision, lock.server.revision);
});

test("the command prints one switched-off row and does not start a stack", () => {
  const child = spawnSync(process.execPath, [scriptPath, lock.server.revision], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(child.status, 0, child.stderr);
  const row = JSON.parse(child.stdout);
  assert.equal(row.status, "switched-off");
  assert.equal(row.journeys, "not-run");
  assert.equal(child.stderr, "");
});

test("the command fails when the armed pin does not match the SHA", () => {
  const child = spawnSync(process.execPath, [scriptPath, otherSha], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HONUA_CANDIDATE_JOURNEYS: "on" },
  });
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).status, "lock-mismatch");
});

test("a redirected mismatch keeps the failing exit status", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "candidate-row-"));
  const output = resolve(directory, "row.json");
  try {
    const stdout = openSync(output, "w");
    try {
      const child = spawnSync(process.execPath, [scriptPath, otherSha], {
        encoding: "utf8",
        stdio: ["ignore", stdout, "pipe"],
        env: { PATH: process.env.PATH, HONUA_CANDIDATE_JOURNEYS: "on" },
      });
      assert.equal(child.status, 1, child.stderr);
      assert.equal(JSON.parse(readFileSync(output, "utf8")).status, "lock-mismatch");
    } finally {
      closeSync(stdout);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an armed command rejects a missing SHA before any qualification", () => {
  const child = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HONUA_CANDIDATE_JOURNEYS: "on" },
  });
  assert.equal(child.status, 2);
  assert.match(child.stderr, /40 lowercase hex/);
});

test("the command rejects a SHA that is not 40 lowercase hex characters", () => {
  assert.throws(() => switchedOffCandidateRow(lock, lock.server.revision.slice(0, 7)), /40 lowercase hex/);
  const child = spawnSync(process.execPath, [scriptPath, "not-a-sha"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(child.status, 2);
  assert.match(child.stderr, /40 lowercase hex/);
});

test("candidate journeys have no schedule and stay off until the repository variable is on", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  assert.doesNotMatch(workflow, /schedule:/u);
  assert.doesNotMatch(workflow, /\| tee /u);
  assert.match(workflow, /types:\s*\[candidate-published\]/u);
  assert.match(workflow, /vars\.HONUA_CANDIDATE_JOURNEYS != 'on'/u);
  assert.match(workflow, /vars\.HONUA_CANDIDATE_JOURNEYS == 'on'/u);

  const switchedOff = workflow.split("name: Qualify the pinned candidate")[0];
  const qualify = workflow.split("name: Qualify the pinned candidate")[1];
  const shared = readFileSync(qualifyPath, "utf8");
  assert.ok(qualify, "armed qualification job missing");
  assert.doesNotMatch(switchedOff, /live-compose-stack\.mjs/u);
  assert.doesNotMatch(switchedOff, /live-compose-qualify\.yml/u);
  assert.match(qualify, /uses: \.\/\.github\/workflows\/live-compose-qualify\.yml/u);
  assert.match(qualify, /row_mode: candidate/u);
  assert.match(qualify, /candidate_sha:/u);
  assert.match(shared, /workflow_call:/u);
  assert.match(shared, /live-compose-stack\.mjs check/u);
  assert.match(shared, /inputs\.row_mode == 'candidate'/u);
  assert.doesNotMatch(shared, /candidate_sha != ''/u);
  assert.match(shared, /live-candidate-row\.mjs/u);
  assert.doesNotMatch(workflow, /live-compose-stack\.mjs/u);
});
