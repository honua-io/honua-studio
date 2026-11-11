import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { candidateJourneyRow } from "../live-candidate-row.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const workflowPath = resolve(repoRoot, ".github/workflows/live-candidate-journeys.yml");
const scriptPath = fileURLToPath(new URL("../live-candidate-row.mjs", import.meta.url));
const lock = JSON.parse(readFileSync(new URL("../live-compose-images.json", import.meta.url), "utf8"));
const otherSha = "0123456789abcdef0123456789abcdef01234567";

test("a candidate row stays switched off unless journeys are armed", () => {
  const row = candidateJourneyRow(lock, lock.server.revision, false);
  assert.equal(row.status, "switched-off");
  assert.equal(row.journeys, "not-run");
  assert.equal(row.candidate_sha, lock.server.revision);
});

test("an armed row is ready only when the pinned server revision is that SHA", () => {
  const ready = candidateJourneyRow(lock, lock.server.revision, true);
  assert.equal(ready.status, "armed");
  assert.equal(ready.journeys, "ready");

  const mismatch = candidateJourneyRow(lock, otherSha, true);
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
    const child = spawnSync("bash", ["-c", 'node "$1" "$2" > "$3"', "bash", scriptPath, otherSha, output], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HONUA_CANDIDATE_JOURNEYS: "on" },
    });
    assert.equal(child.status, 1, child.stderr);
    assert.equal(JSON.parse(readFileSync(output, "utf8")).status, "lock-mismatch");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the command rejects a SHA that is not 40 lowercase hex characters", () => {
  assert.throws(() => candidateJourneyRow(lock, lock.server.revision.slice(0, 7), false), /40 lowercase hex/);
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
  assert.ok(qualify, "armed qualification job missing");
  assert.doesNotMatch(switchedOff, /live-compose-stack\.mjs/u);
  assert.match(qualify, /live-compose-stack\.mjs check/u);
  assert.match(qualify, /live-candidate-row\.mjs/u);
});
