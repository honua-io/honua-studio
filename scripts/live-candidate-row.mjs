import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CANDIDATE_SHA = /^[0-9a-f]{40}$/u;

export function candidateJourneyRow(lock, candidateSha, journeysArmed) {
  if (typeof candidateSha !== "string" || !CANDIDATE_SHA.test(candidateSha)) {
    throw new Error("candidate SHA must be 40 lowercase hex characters");
  }

  const lockRevision = typeof lock?.server?.revision === "string" ? lock.server.revision : "";
  const matches = lockRevision === candidateSha;
  if (!journeysArmed) {
    return {
      candidate_sha: candidateSha,
      lock_revision: lockRevision,
      status: "switched-off",
      journeys: "not-run",
    };
  }
  if (!matches) {
    return {
      candidate_sha: candidateSha,
      lock_revision: lockRevision,
      status: "lock-mismatch",
      journeys: "not-run",
    };
  }
  return {
    candidate_sha: candidateSha,
    lock_revision: lockRevision,
    status: "armed",
    journeys: "ready",
  };
}

function main() {
  const candidateSha = process.argv[2] ?? "";
  const lock = JSON.parse(readFileSync(new URL("./live-compose-images.json", import.meta.url), "utf8"));
  let row;
  try {
    row = candidateJourneyRow(lock, candidateSha, process.env.HONUA_CANDIDATE_JOURNEYS === "on");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "invalid candidate row");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(row)}\n`);
  if (row.status === "lock-mismatch") process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
