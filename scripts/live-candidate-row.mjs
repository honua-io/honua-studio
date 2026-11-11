import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CANDIDATE_SHA = /^[0-9a-f]{40}$/u;

function lockRevision(lock) {
  return typeof lock?.server?.revision === "string" ? lock.server.revision : "";
}

function requireCandidateSha(candidateSha) {
  if (typeof candidateSha !== "string" || !CANDIDATE_SHA.test(candidateSha)) {
    throw new Error("candidate SHA must be 40 lowercase hex characters");
  }
}

function candidateRow(lock, candidateSha, status, journeys) {
  return {
    candidate_sha: candidateSha,
    lock_revision: lockRevision(lock),
    status,
    journeys,
  };
}

export function switchedOffCandidateRow(lock, candidateSha) {
  requireCandidateSha(candidateSha);
  return candidateRow(lock, candidateSha, "switched-off", "not-run");
}

export function armedCandidateRow(lock, candidateSha) {
  requireCandidateSha(candidateSha);
  if (lockRevision(lock) !== candidateSha) {
    return candidateRow(lock, candidateSha, "lock-mismatch", "not-run");
  }
  return candidateRow(lock, candidateSha, "armed", "ready");
}

function main() {
  const candidateSha = process.argv[2] ?? "";
  const lock = JSON.parse(readFileSync(new URL("./live-compose-images.json", import.meta.url), "utf8"));
  const record = process.env.HONUA_CANDIDATE_JOURNEYS === "on" ? armedCandidateRow : switchedOffCandidateRow;
  let row;
  try {
    row = record(lock, candidateSha);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "invalid candidate row");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(row)}\n`);
  if (row.status === "lock-mismatch") process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
