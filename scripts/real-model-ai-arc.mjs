#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ArcRefusal,
  LiveMcpCatalogAdapter,
  LiveModelAdapter,
  finalizeArc,
  loadArcContext,
  prepareArc,
  verifyHandoff,
} from "./lib/real-model-ai-arc.mjs";

const CLAIM_SCHEMA = "honua.studio.real-model-ai-arc-claim/v1";
const CLAIM_STALE_MS = 15 * 60 * 1_000;
const CREDENTIAL_ENV_NAMES = [
  "HONUA_AI_ARC_PREPARE_CREDENTIAL",
  "HONUA_AI_ARC_CONSOLE_TOKEN",
  "HONUA_ADMIN_KEY",
  "HONUA_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];

function required(env, name) {
  const value = env[name];
  if (!value) throw new ArcRefusal(`${name} is required`);
  return value;
}

async function readMaybe(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeExclusiveAtomic(path, bytes) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(path);
    if (!existing.equals(bytes)) throw new ArcRefusal(`refusing to replace occupied output ${path}`);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function ensureExactOutput(path, bytes) {
  const existing = await readMaybe(path);
  if (existing) {
    if (!existing.equals(bytes)) throw new ArcRefusal(`occupied output ${path} does not match this handoff`);
    return "verified";
  }
  await writeExclusiveAtomic(path, bytes);
  return "created";
}

export async function acquireClaim(path, handoffDigest, nowMs = Date.now()) {
  const claim = {
    schemaVersion: CLAIM_SCHEMA,
    claimId: randomUUID(),
    handoffDigest,
    createdAt: new Date(nowMs).toISOString(),
  };
  const bytes = jsonBytes(claim);
  try {
    await writeExclusiveAtomic(path, bytes);
  } catch (error) {
    if (!(error instanceof ArcRefusal) || !String(error.message).startsWith("refusing to replace occupied output")) {
      throw error;
    }
    let current;
    try {
      current = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new ArcRefusal("AI arc claim is occupied by an unreadable producer");
    }
    const age = nowMs - Date.parse(current.createdAt);
    if (
      JSON.stringify(Object.keys(current).sort()) !==
        JSON.stringify(["schemaVersion", "claimId", "handoffDigest", "createdAt"].sort()) ||
      current.schemaVersion !== CLAIM_SCHEMA ||
      typeof current.claimId !== "string" ||
      !current.claimId ||
      current.handoffDigest !== handoffDigest ||
      !Number.isFinite(age) ||
      age < CLAIM_STALE_MS
    ) {
      throw new ArcRefusal("AI arc claim is occupied by another active or different producer");
    }
    const stale = `${path}.stale.${process.pid}.${randomUUID()}`;
    try {
      await rename(path, stale);
      await writeExclusiveAtomic(path, bytes);
    } catch (takeoverError) {
      throw new ArcRefusal(`could not take over stale AI arc claim: ${takeoverError.message}`);
    } finally {
      await unlink(stale).catch(() => undefined);
    }
  }
  return async () => {
    const current = await readMaybe(path);
    if (current?.equals(bytes)) await unlink(path).catch(() => undefined);
  };
}

export function rejectCredentialEnvironment(env, phase) {
  const present = CREDENTIAL_ENV_NAMES.filter((name) => env[name]);
  if (phase === "prepare") {
    const broad = present.filter((name) => name !== "HONUA_AI_ARC_PREPARE_CREDENTIAL");
    if (broad.length) {
      throw new ArcRefusal(`broad credential variables are forbidden: ${broad.join(", ")}`);
    }
    return required(env, "HONUA_AI_ARC_PREPARE_CREDENTIAL");
  }
  if (present.length) {
    throw new ArcRefusal(`resume is credential-free; unset ${present.join(", ")}`);
  }
  return undefined;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const phase = argv[0];
  if (phase !== "prepare" && phase !== "resume") {
    throw new ArcRefusal("first argument must be the explicit prepare or resume phase");
  }
  if (!argv.includes("--execute") || !argv.includes("--yes")) {
    throw new ArcRefusal("live real-model production requires --execute --yes");
  }

  const checkpointPath = required(env, "HONUA_AI_ARC_CHECKPOINT");
  const planPath = required(env, "HONUA_AI_ARC_SDK_PLAN");
  const manifestPath = required(env, "HONUA_PLATFORM_MANIFEST");
  const handoffPath = required(env, "HONUA_AI_ARC_REAL_MODEL_HANDOFF");
  const evidencePath = required(env, "HONUA_AI_ARC_REAL_MODEL_EVIDENCE");
  const receiptPath = required(env, "HONUA_AI_ARC_REAL_MODEL_RECEIPT");
  const endpoint = required(env, "HONUA_AI_ARC_ENDPOINT");
  const context = await loadArcContext(
    {
      checkpoint: checkpointPath,
      plan: planPath,
      manifest: manifestPath,
      provision: env.HONUA_AI_ARC_PROVISION_BINDING,
    },
    {
      endpoint,
      provider: required(env, "HONUA_AI_PROVIDER"),
      model: required(env, "HONUA_AI_MODEL"),
    },
  );

  if (phase === "prepare") {
    const credential = rejectCredentialEnvironment(env, phase);
    if ((await readMaybe(evidencePath)) || (await readMaybe(receiptPath))) {
      throw new ArcRefusal("prepare refuses final evidence/receipt that already exists");
    }
    const existingHandoff = await readMaybe(handoffPath);
    if (existingHandoff) {
      verifyHandoff(JSON.parse(existingHandoff.toString("utf8")), context);
      process.stdout.write("paused: existing immutable Studio handoff verified\n");
      return 2;
    }
    const releaseClaim = await acquireClaim(`${handoffPath}.claim`, context.checkpoint.integrity.digest);
    try {
      const adapters = {
        mcp: new LiveMcpCatalogAdapter({ endpoint: context.endpoint, credential }),
        model: new LiveModelAdapter({ endpoint: context.endpoint, credential }),
      };
      const handoff = await prepareArc(context, adapters);
      await writeExclusiveAtomic(handoffPath, jsonBytes(handoff));
    } finally {
      await releaseClaim();
    }
    process.stdout.write("paused: scoped aggregate Console receipt and Console evidence sidecar required\n");
    return 2;
  }

  rejectCredentialEnvironment(env, phase);
  const consolePath = required(env, "HONUA_AI_ARC_CONSOLE_RECEIPT");
  const consoleEvidencePath = required(env, "HONUA_AI_ARC_CONSOLE_EVIDENCE");
  const [handoffBytes, aggregateBytes, sidecarBytes] = await Promise.all([
    readMaybe(handoffPath),
    readMaybe(consolePath),
    readMaybe(consoleEvidencePath),
  ]);
  if (!handoffBytes) throw new ArcRefusal("resume requires the immutable Studio prepare handoff");
  if (!aggregateBytes) throw new ArcRefusal("resume requires the strict three-family Console aggregate");
  if (!sidecarBytes) throw new ArcRefusal("resume requires HONUA_AI_ARC_CONSOLE_EVIDENCE");
  const handoff = JSON.parse(handoffBytes.toString("utf8"));
  const handoffDigest = handoff.integrity?.digest;
  if (!/^[0-9a-f]{64}$/.test(handoffDigest ?? "")) throw new ArcRefusal("immutable handoff has no claim digest");
  const releaseClaim = await acquireClaim(env.HONUA_AI_ARC_CLAIM ?? `${receiptPath}.claim`, handoffDigest);
  try {
    const console = JSON.parse(aggregateBytes.toString("utf8"));
    const consoleEvidence = JSON.parse(sidecarBytes.toString("utf8"));
    const finalized = await finalizeArc(context, handoff, console, required(env, "HONUA_AI_ARC_EVIDENCE_URL"), {
      consoleEvidence,
      aggregateBytes,
      sidecarBytes,
      consoleOrigin: required(env, "HONUA_AI_ARC_CONSOLE_ORIGIN"),
    });
    const evidenceStatus = await ensureExactOutput(evidencePath, Buffer.from(finalized.evidenceBytes, "utf8"));
    const receiptStatus = await ensureExactOutput(receiptPath, jsonBytes(finalized.receipt));
    process.stdout.write(
      `passed: ${context.target} real-model AI arc evidence ${evidenceStatus}; receipt ${receiptStatus}\n`,
    );
  } finally {
    await releaseClaim();
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`real-model AI arc refused: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
