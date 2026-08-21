#!/usr/bin/env node
import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ArcRefusal,
  LiveMcpCatalogAdapter,
  LiveModelAdapter,
  finalizeArc,
  loadArcContext,
  prepareArc,
  writeJson,
} from "./lib/real-model-ai-arc.mjs";

function required(env, name) {
  const value = env[name];
  if (!value) throw new ArcRefusal(`${name} is required`);
  return value;
}

async function exists(path) {
  if (!path) return false;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
  const evidencePath = required(env, "HONUA_AI_ARC_REAL_MODEL_EVIDENCE");
  const receiptPath = required(env, "HONUA_AI_ARC_REAL_MODEL_RECEIPT");
  const endpoint = required(env, "HONUA_AI_ARC_ENDPOINT");
  const credential = env.HONUA_ADMIN_KEY ?? env.HONUA_API_KEY;
  if (!credential) throw new ArcRefusal("a scoped HTTPS credential is required in HONUA_ADMIN_KEY or HONUA_API_KEY");
  const consolePath = env.HONUA_AI_ARC_CONSOLE_RECEIPT;
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
      sourceSha: env.HONUA_AI_ARC_SOURCE_SHA,
    },
  );
  if (phase === "prepare") {
    if (await exists(evidencePath)) throw new ArcRefusal("prepare evidence output already exists");
    if (await exists(receiptPath)) throw new ArcRefusal("passed receipt output already exists before Console approval");
    const adapters = {
      mcp: new LiveMcpCatalogAdapter({ endpoint: context.endpoint, credential }),
      model: new LiveModelAdapter({ endpoint: context.endpoint, credential }),
    };
    const handoff = await prepareArc(context, adapters);
    await writeJson(evidencePath, handoff);
    process.stdout.write(
      `paused: scoped aggregate Console receipt required at ${consolePath ?? "HONUA_AI_ARC_CONSOLE_RECEIPT"}\n`,
    );
    return 2;
  }

  if (!(await exists(evidencePath))) throw new ArcRefusal("resume requires the sealed prepare handoff evidence");
  const handoff = JSON.parse(await readFile(evidencePath, "utf8"));
  if (handoff.schemaVersion !== "honua.studio.real-model-ai-arc-handoff/v1") {
    throw new ArcRefusal("resume evidence is not a paused real-model handoff");
  }
  if (!consolePath || !(await exists(consolePath))) {
    throw new ArcRefusal("resume requires HONUA_AI_ARC_CONSOLE_RECEIPT from the scoped Console producer");
  }
  if (await exists(receiptPath)) throw new ArcRefusal("real-model receipt output already exists");
  const console = JSON.parse(await readFile(consolePath, "utf8"));
  const finalized = finalizeArc(context, handoff, console, required(env, "HONUA_AI_ARC_EVIDENCE_URL"));
  await writeFile(evidencePath, finalized.evidenceBytes, "utf8");
  await writeJson(receiptPath, finalized.receipt);
  process.stdout.write(`passed: ${context.target} real-model AI arc evidence produced\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof ArcRefusal ? "refused" : "failed"}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
