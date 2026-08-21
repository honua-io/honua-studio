import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export const PROMPT_VERSION = "honua.aws-ecs.ai-arc.prompt/v1";
export const EVAL_VERSION = "honua.aws-ecs.ai-arc.eval/v1";
const HANDOFF_SCHEMA = "honua.studio.real-model-ai-arc-handoff/v1";
const AWS_EVIDENCE_SCHEMA = "honua.aws-ecs.real-model-ai-arc-evidence/v1";
const AWS_RECEIPT_SCHEMA = "honua.aws-ecs.real-model-ai-arc/v1";
const LOCAL_EVIDENCE_SCHEMA = "honua.studio.real-model-ai-arc-evidence/v1";
const RELEASE_RECEIPT_SCHEMA = "honua.release.evidence-receipt/v1";
const CHECKPOINT_SCHEMA = "honua.zero-to-map.checkpoint/v1";
const CONSOLE_SCHEMA = "honua.zero-to-map.console-receipt/v1";
const JOURNEY_ID = "2026.1-zero-to-map";
const RELEASE_CONTRACT = "honua-release#123/D9.3";
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMPONENTS = ["honua-server", "honua-sdk-js", "honua-console", "honua-studio", "honua-devops", "honua-iac"];
const PROVIDERS = new Set(["anthropic", "bedrock", "openai"]);
const SECRET_KEY = /(?:password|authorization|api[-_]?key|access[-_]?key|secret(?:string|[-_]?key)|bearer|token)/i;

const ADMIN_ACTIONS = new Map([
  ["admin-status", ["server-status", undefined]],
  ["create-connection", ["connection-create", undefined]],
  ["test-connection", ["connection-test", undefined]],
  ["import-parcels", ["import-upload-url", "parcels"]],
  ["import-zoning", ["import-upload-url", "zoning"]],
  ["publish-parcels", ["layer-publish", "parcels"]],
  ["publish-zoning", ["layer-publish", "zoning"]],
  ["set-public-access", ["service-access", undefined]],
]);
const ESRI_ACTIONS = new Map([
  ["list-esri-gp-tasks", "list-tasks"],
  ["describe-esri-buffer", "describe-buffer"],
  ["buffer-esri-mcp", "execute-buffer"],
  ["wait-esri-mcp-buffer", "wait-buffer"],
  ["read-esri-mcp-buffer-results", "read-buffer-results"],
]);
const NATIVE_ACTIONS = new Map([
  ["buffer-parcels", "execute-buffer"],
  ["wait-direct-buffer", "wait-buffer"],
  ["read-direct-buffer-results", "read-buffer-results"],
]);
const STUDIO_ROLES = new Map([
  ["honua_studio_create_draft", "create-draft"],
  ["honua_studio_add_layer", "add-layer"],
  ["honua_studio_set_layer_style", "set-layer-style"],
  ["honua_studio_set_view", "set-view"],
  ["honua_studio_add_widget", "add-widget"],
  ["honua_studio_add_control", "add-control"],
  ["honua_studio_validate_draft", "validate-draft"],
  ["honua_studio_save_version", "save-version"],
  ["honua_studio_get_version", "get-version"],
  ["honua_studio_reopen_version", "reopen-version"],
  ["honua_studio_propose_publication", "propose-publication"],
]);
const REQUIRED_STUDIO_ROLES = [...new Set(STUDIO_ROLES.values())];

export class ArcRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "ArcRefusal";
  }
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new ArcRefusal("evidence contains a non-JSON value");
  return encoded;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ArcRefusal(`${label} must be an object`);
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || !value) throw new ArcRefusal(`${label} must be a non-empty string`);
  return value;
}

function exactKeys(value, allowed, label) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new ArcRefusal(`${label} has unexpected fields: ${extra.join(", ")}`);
}

function scalar(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function normalizedEndpoint(value) {
  const url = new URL(text(value, "HONUA_AI_ARC_ENDPOINT"));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new ArcRefusal("HONUA_AI_ARC_ENDPOINT must be credential-free HTTPS");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function httpsUrl(value, label) {
  const url = new URL(text(value, label));
  if (url.protocol !== "https:" || url.username || url.password)
    throw new ArcRefusal(`${label} must be credential-free HTTPS`);
  return url.toString();
}

function stripYamlComment(value) {
  let quoted = false;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && (!quoted || char === quote)) {
      quoted = !quoted;
      quote = quoted ? char : "";
    }
    if (char === "#" && !quoted) return value.slice(0, index).trim();
  }
  return value.trim();
}

function yamlScalar(value) {
  const clean = stripYamlComment(value);
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
    return clean.slice(1, -1);
  }
  return clean;
}

export function parsePlatformManifest(bytes) {
  const source = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  let releaseId;
  let inComponents = false;
  let component;
  const components = {};
  for (const line of source.split(/\r?\n/)) {
    const release = line.match(/^platformRelease:\s*(.+)$/);
    if (release) releaseId = yamlScalar(release[1]);
    if (line === "components:") {
      inComponents = true;
      continue;
    }
    if (!inComponents) continue;
    const entry = line.match(/^ {2}([a-z0-9-]+):\s*(?:#.*)?$/);
    if (entry) {
      component = entry[1];
      continue;
    }
    if (/^[^ ]/.test(line) && line.trim() && !line.startsWith("#")) {
      inComponents = false;
      component = undefined;
      continue;
    }
    const revision = line.match(/^ {4}sha:\s*(.+)$/);
    if (component && revision) components[component] = yamlScalar(revision[1]);
  }
  text(releaseId, "platformManifest.platformRelease");
  for (const name of COMPONENTS) {
    if (!SHA.test(components[name] ?? "")) throw new ArcRefusal(`platform manifest has no exact ${name} SHA`);
  }
  return { releaseId, components };
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes));
  } catch {
    throw new ArcRefusal(`${label} is not valid JSON`);
  }
}

function verifyCheckpoint(checkpoint, planBytes, manifest, endpoint, provisionBytes, nowMs) {
  object(checkpoint, "checkpoint");
  exactKeys(
    checkpoint,
    [
      "schemaVersion",
      "state",
      "createdAt",
      "journeyId",
      "releaseContract",
      "target",
      "planSha256",
      "sourceRevision",
      "mcpEndpointSha256",
      "candidateId",
      "releaseId",
      "provisionReceiptSha256",
      "resume",
      "consoleReceiptRequest",
      "integrity",
    ],
    "checkpoint",
  );
  if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA || checkpoint.state !== "paused") {
    throw new ArcRefusal("SDK checkpoint must be a paused honua.zero-to-map.checkpoint/v1 document");
  }
  if (checkpoint.journeyId !== JOURNEY_ID || checkpoint.releaseContract !== RELEASE_CONTRACT) {
    throw new ArcRefusal("SDK checkpoint has the wrong journey identity");
  }
  if (checkpoint.candidateId !== manifest.candidateId || checkpoint.releaseId !== manifest.releaseId) {
    throw new ArcRefusal("SDK checkpoint is not bound to the exact platform manifest bytes");
  }
  if (checkpoint.sourceRevision !== manifest.components["honua-sdk-js"]) {
    throw new ArcRefusal("SDK checkpoint sourceRevision is not the manifest-pinned honua-sdk-js SHA");
  }
  if (!SHA256.test(checkpoint.planSha256 ?? "") || !SHA256.test(checkpoint.mcpEndpointSha256 ?? "")) {
    throw new ArcRefusal("SDK checkpoint lacks exact plan/endpoint hashes");
  }
  const createdAt = Date.parse(checkpoint.createdAt);
  if (!Number.isFinite(createdAt)) throw new ArcRefusal("SDK checkpoint createdAt is invalid");
  const checkpointAgeMs = nowMs - createdAt;
  if (checkpointAgeMs < 0 || checkpointAgeMs > 24 * 60 * 60 * 1_000) {
    throw new ArcRefusal("SDK checkpoint is stale or has a future creation time");
  }
  if (checkpoint.planSha256 !== sha256(planBytes))
    throw new ArcRefusal("SDK plan bytes do not match checkpoint.planSha256");
  const expectedMcp = sha256(`${endpoint}/mcp`);
  if (checkpoint.mcpEndpointSha256 !== expectedMcp)
    throw new ArcRefusal("SDK checkpoint is not bound to this endpoint /mcp URL");
  const integrity = object(checkpoint.integrity, "checkpoint.integrity");
  const { integrity: _ignored, ...payload } = checkpoint;
  if (integrity.algorithm !== "sha256" || integrity.digest !== sha256(canonicalJson(payload))) {
    throw new ArcRefusal("SDK checkpoint integrity digest is invalid");
  }
  const resume = object(checkpoint.resume, "checkpoint.resume");
  exactKeys(resume, ["startedAt", "capturedVariables", "completedStages", "resumeAt"], "checkpoint.resume");
  if (!Number.isFinite(Date.parse(resume.startedAt)))
    throw new ArcRefusal("SDK checkpoint resume.startedAt is invalid");
  if (canonicalJson(resume.resumeAt) !== canonicalJson({ stageId: "console", actionId: "console-approval" })) {
    throw new ArcRefusal("SDK checkpoint is not paused at the focused Console approval boundary");
  }
  if (checkpoint.target === "aws-ecs") {
    if (!provisionBytes) throw new ArcRefusal("AWS ECS preparation requires HONUA_AI_ARC_PROVISION_BINDING");
    if (checkpoint.provisionReceiptSha256 !== sha256(provisionBytes)) {
      throw new ArcRefusal("provision binding bytes do not match checkpoint.provisionReceiptSha256");
    }
  } else if (checkpoint.target !== "local-docker") {
    throw new ArcRefusal("SDK checkpoint target must be local-docker or aws-ecs");
  } else if (checkpoint.provisionReceiptSha256 !== undefined) {
    throw new ArcRefusal("local-Docker checkpoint cannot bind an AWS provision receipt");
  }
  const request = object(checkpoint.consoleReceiptRequest, "checkpoint.consoleReceiptRequest");
  exactKeys(
    request,
    ["schemaVersion", "actionId", "receiptSchema", "matches", "requiredPointers", "equalPointers"],
    "checkpoint.consoleReceiptRequest",
  );
  if (
    request.schemaVersion !== "honua.zero-to-map.console-receipt-request/v1" ||
    request.actionId !== "console-approval" ||
    request.receiptSchema !== CONSOLE_SCHEMA ||
    !request.matches ||
    typeof request.matches !== "object" ||
    !Array.isArray(request.requiredPointers) ||
    !Array.isArray(request.equalPointers)
  ) {
    throw new ArcRefusal("SDK checkpoint has an invalid Console receipt request");
  }
  assertSecretFree(checkpoint, "SDK checkpoint");
  return checkpoint;
}

function verifyProvision(value, manifest, endpoint) {
  const provision = object(value, "provision binding");
  exactKeys(
    provision,
    [
      "schemaVersion",
      "target",
      "status",
      "candidateId",
      "releaseId",
      "endpoint",
      "adminKeySecretRef",
      "serverImage",
      "components",
      "checks",
      "evidence",
    ],
    "provision binding",
  );
  if (
    provision.schemaVersion !== "honua.aws-ecs.provision-binding/v1" ||
    provision.target !== "aws-ecs" ||
    provision.status !== "ready"
  ) {
    throw new ArcRefusal("AWS provision binding is not ready");
  }
  if (
    provision.candidateId !== manifest.candidateId ||
    provision.releaseId !== manifest.releaseId ||
    provision.endpoint !== endpoint
  ) {
    throw new ArcRefusal("AWS provision binding does not identify this candidate endpoint");
  }
  for (const name of ["honua-server", "honua-devops", "honua-iac"]) {
    if (provision.components?.[name] !== manifest.components[name])
      throw new ArcRefusal(`AWS provision binding disagrees on ${name}`);
  }
  for (const check of ["terraform-plan", "terraform-apply", "readiness", "admin-mcp-handoff"]) {
    if (provision.checks?.[check] !== "passed") throw new ArcRefusal(`AWS provision binding does not prove ${check}`);
  }
  if (!/^arn:aws(?:-us-gov|-cn)?:secretsmanager:/.test(provision.adminKeySecretRef ?? "")) {
    throw new ArcRefusal("AWS provision binding has no scoped Secrets Manager reference");
  }
  if (!/@sha256:[0-9a-f]{64}$/.test(provision.serverImage ?? "")) {
    throw new ArcRefusal("AWS provision binding has no immutable server image digest");
  }
  httpsUrl(provision.evidence?.url, "AWS provision evidence URL");
  if (!SHA256.test(provision.evidence?.sha256 ?? "")) {
    throw new ArcRefusal("AWS provision binding has no content-addressed evidence");
  }
  assertSecretFree(provision, "AWS provision binding", new Set(["adminKeySecretRef"]));
}

export function assertSecretFree(value, label = "evidence", allowedKeys = new Set()) {
  const walk = (item, path) => {
    if (Array.isArray(item)) return item.forEach((child, index) => walk(child, `${path}[${index}]`));
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (SECRET_KEY.test(key) && !allowedKeys.has(key))
        throw new ArcRefusal(`${label} contains a forbidden credential field at ${path}.${key}`);
      walk(child, `${path}.${key}`);
    }
  };
  walk(value, label);
}

function pointer(value, path) {
  if (path === "") return value;
  return path
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((current, part) => (current && typeof current === "object" ? current[part] : undefined), value);
}

function resolveTemplate(value, variables, path = "arguments") {
  if (Array.isArray(value)) return value.map((item, index) => resolveTemplate(item, variables, `${path}[${index}]`));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveTemplate(item, variables, `${path}.${key}`)]),
    );
  }
  if (typeof value !== "string") return value;
  const exact = value.match(/^\$\{([^}]+)\}$/);
  if (exact) {
    const name = exact[1];
    if (Object.hasOwn(variables, name)) return variables[name];
    if (SECRET_KEY.test(name) || SECRET_KEY.test(path)) return `<credential-ref:${name}>`;
    throw new ArcRefusal(`SDK plan requires unavailable checkpoint variable ${name}`);
  }
  return value.replace(/\$\{([^}]+)\}/g, (_match, name) => {
    if (Object.hasOwn(variables, name) && scalar(variables[name])) return String(variables[name]);
    if (SECRET_KEY.test(name) || SECRET_KEY.test(path)) return `<credential-ref:${name}>`;
    throw new ArcRefusal(`SDK plan requires unavailable scalar checkpoint variable ${name}`);
  });
}

function familyFor(action) {
  for (const family of ["map", "app", "dashboard"]) {
    if (action.id.includes(family) || action.arguments?.family === family) return family;
  }
  return undefined;
}

function indexCompletedReceipts(plan, checkpoint) {
  const receipts = new Map();
  const stages = Array.isArray(plan.stages) ? plan.stages : [];
  const completed = checkpoint.resume?.completedStages;
  if (!Array.isArray(completed)) throw new ArcRefusal("SDK checkpoint completedStages must be an array");
  if (completed.length !== stages.findIndex((stage) => stage.id === "console")) {
    throw new ArcRefusal("SDK checkpoint is not the exact completed stage prefix through proposal");
  }
  completed.forEach((actualStage, stageIndex) => {
    const plannedStage = stages[stageIndex];
    if (
      !plannedStage ||
      actualStage.id !== plannedStage.id ||
      actualStage.number !== plannedStage.number ||
      actualStage.status !== "passed"
    ) {
      throw new ArcRefusal(`SDK completed stage ${stageIndex + 1} does not match the plan`);
    }
    if (!Array.isArray(actualStage.actions) || actualStage.actions.length !== plannedStage.actions.length) {
      throw new ArcRefusal(`SDK completed stage ${plannedStage.id} has a different action roster`);
    }
    actualStage.actions.forEach((receipt, index) => {
      const action = plannedStage.actions[index];
      if (receipt.id !== action.id || receipt.kind !== action.kind || receipt.status !== "passed") {
        throw new ArcRefusal(`SDK action receipt ${plannedStage.id}[${index}] is not exact and passed`);
      }
      const allowedCaptures = new Set((action.captures ?? []).map((capture) => capture.variable));
      for (const name of Object.keys(receipt.captures ?? {})) {
        if (!allowedCaptures.has(name))
          throw new ArcRefusal(`SDK action receipt ${action.id} has undeclared capture ${name}`);
      }
      receipts.set(action.id, { action, receipt });
    });
  });
  const captured = object(checkpoint.resume.capturedVariables, "checkpoint.resume.capturedVariables");
  const restored = {};
  // serviceName is the one plan-owned identity DevOps #149 needs even when an
  // Admin mutation does not echo it. The SDK checkpoint must carry it
  // explicitly and byte-for-byte equal the pinned plan variable; no other
  // plan defaults are silently promoted into evidence joins.
  if (Object.hasOwn(captured, "serviceName")) {
    if (!scalar(plan.variables?.serviceName) || captured.serviceName !== plan.variables.serviceName) {
      throw new ArcRefusal("checkpoint serviceName does not equal the manifest-pinned SDK plan variable");
    }
    restored.serviceName = captured.serviceName;
  }
  for (const { receipt } of receipts.values()) {
    for (const [key, value] of Object.entries(receipt.captures ?? {})) {
      if (Object.hasOwn(restored, key)) throw new ArcRefusal(`SDK checkpoint repeats capture ${key}`);
      restored[key] = value;
    }
  }
  if (canonicalJson(restored) !== canonicalJson(captured))
    throw new ArcRefusal("SDK checkpoint captures do not equal action receipt captures");
  return receipts;
}

function operation(lane, role, pair, variables, family, evidenceName) {
  const { action, receipt } = pair;
  let expected;
  let modelTool;
  if (action.kind === "mcp") {
    expected = resolveTemplate(action.arguments ?? {}, variables);
    modelTool = action.tool;
  } else if (action.kind === "mcp-resource") {
    expected = { uri: resolveTemplate(action.uri, variables) };
    modelTool = "honua_read_governed_resource";
  } else if (action.kind === "gpserver") {
    expected = resolveTemplate(
      {
        serviceId: action.serviceId,
        taskName: action.taskName,
        processId: action.processId,
        parameters: action.parameters,
        resultNames: action.resultNames,
      },
      variables,
    );
    modelTool = "honua_execute_gpserver_task";
  } else {
    throw new ArcRefusal(`real-model action ${action.id} has unsupported kind ${action.kind}`);
  }
  return {
    lane,
    role,
    family,
    evidenceName: evidenceName ?? action.tool ?? expected.uri,
    action,
    receipt,
    expected,
    modelTool,
  };
}

export function buildOperations(plan, checkpoint, advertisedTools) {
  if (
    plan.schemaVersion !== "honua.zero-to-map.plan/v1" ||
    plan.journeyId !== JOURNEY_ID ||
    plan.releaseContract !== RELEASE_CONTRACT
  ) {
    throw new ArcRefusal("SDK journey plan has the wrong schema or journey identity");
  }
  const receipts = indexCompletedReceipts(plan, checkpoint);
  const variables = {
    ...(plan.variables ?? {}),
    ...checkpoint.resume.capturedVariables,
    candidateId: checkpoint.candidateId,
    releaseId: checkpoint.releaseId,
  };
  const operations = [];
  for (const [id, [role, family]] of ADMIN_ACTIONS) {
    const pair = receipts.get(id);
    if (!pair) throw new ArcRefusal(`SDK plan is missing exact Admin action ${id}`);
    operations.push(operation("admin", role, pair, variables, family));
  }
  for (const [id, role] of ESRI_ACTIONS) {
    const pair = receipts.get(id);
    if (!pair) throw new ArcRefusal(`SDK plan is missing exact Esri GP action ${id}`);
    operations.push(operation("esriGp", role, pair, variables));
  }
  for (const [id, role] of NATIVE_ACTIONS) {
    const pair = receipts.get(id);
    if (!pair) throw new ArcRefusal(`SDK plan is missing exact native analysis action ${id}`);
    operations.push(operation("nativeAnalysis", role, pair, variables));
  }
  const gpserver = receipts.get("buffer-esri-gpserver");
  if (!gpserver) throw new ArcRefusal("SDK plan is missing exact direct GPServer Buffer action");
  operations.push(
    operation("nativeAnalysis", "execute-buffer-gpserver", gpserver, variables, undefined, "GPServer/analysis/Buffer"),
  );

  for (const family of ["map", "app", "dashboard"]) {
    const found = new Set();
    for (const pair of receipts.values()) {
      const role = STUDIO_ROLES.get(pair.action.tool);
      if (!role || familyFor(pair.action) !== family) continue;
      found.add(role);
      operations.push(operation("studioPublication", role, pair, variables, family));
    }
    const missing = REQUIRED_STUDIO_ROLES.filter((role) => !found.has(role));
    if (missing.length) {
      throw new ArcRefusal(`manifest-pinned SDK plan lacks ${family} real-model actions: ${missing.join(", ")}`);
    }
  }

  const advertised = new Map(advertisedTools.map((tool) => [tool.name, tool]));
  for (const item of operations) {
    if (item.action.kind !== "mcp") continue;
    const descriptor = advertised.get(item.action.tool);
    if (!descriptor || !descriptor.inputSchema || typeof descriptor.inputSchema !== "object") {
      throw new ArcRefusal(`candidate endpoint does not advertise authoritative schema for ${item.action.tool}`);
    }
    item.toolDefinition = {
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
    };
  }
  return operations;
}

function syntheticToolDefinition(item) {
  if (item.action.kind === "mcp-resource") {
    return {
      name: item.modelTool,
      description: "Read the exact governed Honua job resource selected by the deterministic SDK plan.",
      inputSchema: {
        type: "object",
        properties: { uri: { type: "string" } },
        required: ["uri"],
        additionalProperties: false,
      },
    };
  }
  return {
    name: item.modelTool,
    description:
      "Use the SDK-pinned direct Esri GPServer-compatible task contract; do not translate it to another API.",
    inputSchema: {
      type: "object",
      properties: {
        serviceId: { type: "string" },
        taskName: { type: "string" },
        processId: { type: "string" },
        parameters: { type: "object" },
        resultNames: { type: "array", items: { type: "string" } },
      },
      required: ["serviceId", "taskName", "processId", "parameters", "resultNames"],
      additionalProperties: false,
    },
  };
}

function identitiesFor(item, joins) {
  const result = {};
  for (const [name, value] of Object.entries(item.receipt.captures ?? {})) {
    if (scalar(value) && joins[name] === value) result[name] = value;
  }
  const haystack = canonicalJson(item.expected);
  for (const [name, value] of Object.entries(joins)) {
    if (scalar(value) && haystack.includes(JSON.stringify(value))) result[name] = value;
  }
  if (Object.keys(result).length === 0) result.candidateId = joins.candidateId;
  return result;
}

function promptFor(item, context) {
  const family = item.family ? ` ${item.family}` : "";
  return [
    `For Honua candidate ${context.candidateId}, use the governed ${item.lane}${family} surface to ${item.action.title}.`,
    "Select the one supplied operation and preserve the deterministic SDK inputs exactly.",
    "This is reconciliation against an already-passed checkpoint: do not invent another service, draft, job, translator, or publication.",
    `Deterministic inputs: ${canonicalJson(item.expected)}`,
  ].join(" ");
}

export async function prepareArc(context, adapters) {
  const advertised = await adapters.mcp.listTools();
  const operations = buildOperations(context.plan, context.checkpoint, advertised);
  const joins = scalarJoins(context.checkpoint.resume.capturedVariables);
  joins.candidateId = context.candidateId;
  joins.releaseId = context.releaseId;
  const lanes = { admin: [], esriGp: [], nativeAnalysis: [], studioPublication: [] };
  let actualModel;
  for (const item of operations) {
    const prompt = promptFor(item, context);
    const definition = item.toolDefinition ?? syntheticToolDefinition(item);
    const selected = await adapters.model.selectTool({
      provider: context.provider,
      model: context.requestedModel,
      prompt,
      tool: definition,
      expectedArguments: item.expected,
    });
    if (
      !selected ||
      selected.toolName !== item.modelTool ||
      canonicalJson(selected.arguments) !== canonicalJson(item.expected)
    ) {
      throw new ArcRefusal(`real model did not select exact SDK action ${item.action.id}`);
    }
    if (!text(selected.modelId, `model identity for ${item.action.id}`))
      throw new ArcRefusal("real model returned no model identity");
    if (actualModel && actualModel !== selected.modelId)
      throw new ArcRefusal("real-model arc changed model identity between calls");
    actualModel = selected.modelId;
    const actionReceiptSha256 = sha256(canonicalJson(item.receipt));
    lanes[item.lane].push({
      role: item.role,
      ...(item.family ? { family: item.family } : {}),
      kind: item.action.kind === "mcp" ? "mcp" : "mcp-resource",
      name: item.evidenceName,
      status: "passed",
      responseSha256: sha256(canonicalJson({ modelTranscriptSha256: selected.transcriptSha256, actionReceiptSha256 })),
      result: { status: "reconciled", identities: identitiesFor(item, joins) },
      _promptSha256: sha256(prompt),
      _transcriptSha256: selected.transcriptSha256,
    });
  }
  const finalizedLanes = {};
  for (const [name, calls] of Object.entries(lanes)) {
    finalizedLanes[name] = {
      promptSha256: sha256(canonicalJson(calls.map((call) => call._promptSha256))),
      transcriptSha256: sha256(canonicalJson(calls.map((call) => call._transcriptSha256))),
      calls: calls.map(({ _promptSha256, _transcriptSha256, ...call }) => call),
    };
  }
  const transcriptSha256 = sha256(canonicalJson(Object.values(finalizedLanes).map((lane) => lane.transcriptSha256)));
  const handoffPayload = {
    schemaVersion: HANDOFF_SCHEMA,
    status: "paused",
    target: context.target,
    candidateId: context.candidateId,
    releaseId: context.releaseId,
    endpointSha256: context.endpointSha256,
    source: context.source,
    components: context.components,
    model: { provider: context.provider, modelId: actualModel },
    promptVersion: PROMPT_VERSION,
    evalVersion: EVAL_VERSION,
    transcriptSha256,
    deterministic: {
      target: context.target,
      ...(context.provisionReceiptSha256 ? { provisionReceiptSha256: context.provisionReceiptSha256 } : {}),
      checkpointDigest: context.checkpoint.integrity.digest,
    },
    lanes: finalizedLanes,
    joins,
    consoleReceiptRequest: context.checkpoint.consoleReceiptRequest,
  };
  assertSecretFree(handoffPayload, "real-model handoff");
  return { ...handoffPayload, integrity: { algorithm: "sha256", digest: sha256(canonicalJson(handoffPayload)) } };
}

function scalarJoins(value) {
  return Object.fromEntries(
    Object.entries(object(value, "captured variables")).filter(
      ([name, item]) =>
        scalar(item) &&
        (name === "route" ||
          name === "serviceName" ||
          ["Id", "Hash", "Name", "Generation"].some((suffix) => name.endsWith(suffix))),
    ),
  );
}

function verifyHandoff(handoff, context) {
  const value = object(handoff, "real-model handoff");
  const integrity = object(value.integrity, "real-model handoff integrity");
  const { integrity: _ignored, ...payload } = value;
  if (value.schemaVersion !== HANDOFF_SCHEMA || value.status !== "paused")
    throw new ArcRefusal("real-model evidence is not a paused Studio handoff");
  if (integrity.algorithm !== "sha256" || integrity.digest !== sha256(canonicalJson(payload)))
    throw new ArcRefusal("real-model handoff integrity is invalid");
  for (const name of ["target", "candidateId", "releaseId", "endpointSha256"]) {
    if (value[name] !== context[name]) throw new ArcRefusal(`real-model handoff disagrees on ${name}`);
  }
  if (
    canonicalJson(value.source) !== canonicalJson(context.source) ||
    canonicalJson(value.components) !== canonicalJson(context.components)
  ) {
    throw new ArcRefusal("real-model handoff source/components do not match this candidate");
  }
  if (value.model?.provider !== context.provider) throw new ArcRefusal("real-model handoff provider changed at resume");
  if (value.deterministic?.checkpointDigest !== context.checkpoint.integrity.digest)
    throw new ArcRefusal("real-model handoff checkpoint digest changed");
  assertSecretFree(value, "real-model handoff");
  return value;
}

export function verifyConsole(console, checkpoint, context) {
  const receipt = object(console, "Console receipt");
  if (
    receipt.schemaVersion !== CONSOLE_SCHEMA ||
    receipt.journeyId !== JOURNEY_ID ||
    receipt.releaseContract !== RELEASE_CONTRACT ||
    receipt.status !== "passed"
  ) {
    throw new ArcRefusal("Console receipt has not passed the exact 2026.1 journey contract");
  }
  if (receipt.candidate?.candidateId !== context.candidateId || receipt.candidate?.releaseId !== context.releaseId) {
    throw new ArcRefusal("Console receipt is not bound to this candidate");
  }
  const request = object(checkpoint.consoleReceiptRequest, "checkpoint.consoleReceiptRequest");
  for (const [path, expected] of Object.entries(request.matches ?? {})) {
    if (canonicalJson(pointer(receipt, path)) !== canonicalJson(expected))
      throw new ArcRefusal(`Console receipt does not match ${path}`);
  }
  for (const path of request.requiredPointers ?? []) {
    const value = pointer(receipt, path);
    if (value === undefined || value === null || value === "") throw new ArcRefusal(`Console receipt omits ${path}`);
  }
  for (const pair of request.equalPointers ?? []) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      canonicalJson(pointer(receipt, pair[0])) !== canonicalJson(pointer(receipt, pair[1]))
    ) {
      throw new ArcRefusal("Console receipt violates a required identity join");
    }
  }
  for (const family of ["map", "app", "dashboard"])
    httpsUrl(receipt.publications?.[family]?.publicUrl, `Console ${family} publicUrl`);
  httpsUrl(receipt.shareUrl, "Console shareUrl");
  assertSecretFree(receipt, "Console receipt");
  return receipt;
}

function consoleJoins(console) {
  const joins = {};
  for (const family of ["map", "app", "dashboard"]) {
    const proposal = console.proposals[family];
    const publication = console.publications[family];
    const audit = console.audit[family];
    joins[`${family}ProposalId`] = proposal.proposalId;
    joins[`${family}ExecutionOperationId`] = proposal.executionOperationId;
    joins[`${family}PublicationRequestId`] = publication.requestId;
    joins[`${family}PublicationId`] = publication.publicationId;
    joins[`${family}PublicationStatus`] = publication.status;
    joins[`${family}PublicUrl`] = publication.publicUrl;
    joins[`${family}AuditCorrelationId`] = audit.correlationId;
  }
  return joins;
}

function requireJoinCoverage(lanes, joins) {
  const requiredBase = [
    "connectionId",
    "parcelsLayerId",
    "zoningLayerId",
    "esriMcpJobId",
    "gpServerJobId",
    "directAnalysisJobId",
    "mapVersionId",
    "appVersionId",
    "dashboardVersionId",
    "mapPublicationVersionId",
    "appPublicationVersionId",
    "dashboardPublicationVersionId",
    "mapPublicationContentHash",
    "appPublicationContentHash",
    "dashboardPublicationContentHash",
  ];
  const absentBase = requiredBase.filter((name) => !Object.hasOwn(joins, name));
  if (absentBase.length)
    throw new ArcRefusal(`deterministic checkpoint omits real-model joins: ${absentBase.join(", ")}`);
  const expected = {
    admin: ["connectionId", "parcelsLayerId", "zoningLayerId", "serviceName"],
    esriGp: ["esriMcpJobId"],
    nativeAnalysis: ["directAnalysisJobId", "gpServerJobId"],
    studioPublication: [
      "mapProposalId",
      "appProposalId",
      "dashboardProposalId",
      "mapPublicationVersionId",
      "appPublicationVersionId",
      "dashboardPublicationVersionId",
    ],
  };
  for (const [laneName, names] of Object.entries(expected)) {
    const observed = new Set(lanes[laneName].calls.flatMap((call) => Object.keys(call.result.identities)));
    const missing = names.filter((name) => !observed.has(name) || !Object.hasOwn(joins, name));
    if (missing.length) throw new ArcRefusal(`${laneName} evidence omits deterministic joins: ${missing.join(", ")}`);
  }
}

export function finalizeArc(context, rawHandoff, rawConsole, evidenceUrl) {
  const handoff = verifyHandoff(rawHandoff, context);
  const console = verifyConsole(rawConsole, context.checkpoint, context);
  const joins = { ...handoff.joins, ...consoleJoins(console) };
  const lanes = structuredClone(handoff.lanes);
  for (const call of lanes.studioPublication.calls) {
    if (call.role === "propose-publication" && call.family) {
      call.result.identities[`${call.family}ProposalId`] = joins[`${call.family}ProposalId`];
    }
  }
  requireJoinCoverage(lanes, joins);
  const common = {
    candidateId: context.candidateId,
    releaseId: context.releaseId,
    endpointSha256: context.endpointSha256,
    source: context.source,
    model: handoff.model,
    promptVersion: PROMPT_VERSION,
    evalVersion: EVAL_VERSION,
    transcriptSha256: handoff.transcriptSha256,
    target: context.target,
    ...(context.provisionReceiptSha256 ? { provisionReceiptSha256: context.provisionReceiptSha256 } : {}),
    checkpointDigest: context.checkpoint.integrity.digest,
    lanes,
    joins,
  };
  const evidence =
    context.target === "aws-ecs"
      ? { schemaVersion: AWS_EVIDENCE_SCHEMA, ...common }
      : { schemaVersion: LOCAL_EVIDENCE_SCHEMA, ...common };
  assertSecretFree(evidence, "real-model evidence");
  const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
  const evidenceSha256 = sha256(evidenceBytes);
  const url = httpsUrl(evidenceUrl, "HONUA_AI_ARC_EVIDENCE_URL");
  if (context.target === "aws-ecs") {
    return {
      evidence,
      evidenceBytes,
      receipt: {
        schemaVersion: AWS_RECEIPT_SCHEMA,
        id: "aws-ecs-real-model-ai-arc",
        status: "passed",
        target: "aws-ecs",
        candidateId: context.candidateId,
        releaseId: context.releaseId,
        endpointSha256: context.endpointSha256,
        source: context.source,
        components: context.components,
        model: handoff.model,
        promptVersion: PROMPT_VERSION,
        evalVersion: EVAL_VERSION,
        transcriptSha256: handoff.transcriptSha256,
        deterministic: {
          target: "aws-ecs",
          provisionReceiptSha256: context.provisionReceiptSha256,
          checkpointDigest: context.checkpoint.integrity.digest,
        },
        lanes,
        joins,
        checks: Object.fromEntries(
          [
            "natural-language-admin-setup-config-publish",
            "natural-language-esri-gp",
            "natural-language-native-analysis",
            "natural-language-map-app-dashboard-composition-publication",
            "deterministic-id-join",
            "same-endpoint-candidate",
            "no-secret-serialization",
          ].map((name) => [name, "passed"]),
        ),
        evidence: { url, sha256: evidenceSha256 },
      },
    };
  }
  return {
    evidence,
    evidenceBytes,
    receipt: {
      schemaVersion: RELEASE_RECEIPT_SCHEMA,
      id: "studio-real-model",
      status: "passed",
      candidateId: context.candidateId,
      releaseId: context.releaseId,
      source: context.source,
      components: { "honua-studio": context.components["honua-studio"] },
      evidence: { url, sha256: evidenceSha256 },
      claims: {
        target: "local-docker",
        journeyId: JOURNEY_ID,
        releaseContract: RELEASE_CONTRACT,
        checks: {
          "real-model-turn": "passed",
          "map-compose-save-reopen": "passed",
          "app-compose-save-reopen": "passed",
          "dashboard-compose-save-reopen": "passed",
        },
      },
    },
  };
}

export async function loadArcContext(paths, settings) {
  const [manifestBytes, checkpointBytes, planBytes, provisionBytes] = await Promise.all([
    readFile(paths.manifest),
    readFile(paths.checkpoint),
    readFile(paths.plan),
    paths.provision ? readFile(paths.provision) : undefined,
  ]);
  const parsedManifest = parsePlatformManifest(manifestBytes);
  const manifest = { ...parsedManifest, candidateId: `manifest-sha256:${sha256(manifestBytes)}` };
  const endpoint = normalizedEndpoint(settings.endpoint);
  const checkpoint = verifyCheckpoint(
    parseJson(checkpointBytes, "SDK checkpoint"),
    planBytes,
    manifest,
    endpoint,
    provisionBytes,
    settings.now?.getTime() ?? Date.now(),
  );
  if (checkpoint.target === "aws-ecs")
    verifyProvision(parseJson(provisionBytes, "AWS provision binding"), manifest, endpoint);
  const sourceSha = settings.sourceSha ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!SHA.test(sourceSha) || sourceSha !== manifest.components["honua-studio"]) {
    throw new ArcRefusal("producer is not running from the manifest-pinned honua-studio SHA");
  }
  if (!PROVIDERS.has(settings.provider))
    throw new ArcRefusal("HONUA_AI_PROVIDER must be anthropic, bedrock, or openai");
  text(settings.model, "HONUA_AI_MODEL");
  return {
    target: checkpoint.target,
    endpoint,
    endpointSha256: sha256(endpoint),
    candidateId: manifest.candidateId,
    releaseId: manifest.releaseId,
    source: { repository: "honua-io/honua-studio", sha: sourceSha },
    components: Object.fromEntries(COMPONENTS.map((name) => [name, manifest.components[name]])),
    provider: settings.provider,
    requestedModel: settings.model,
    plan: parseJson(planBytes, "SDK plan"),
    checkpoint,
    ...(provisionBytes ? { provisionReceiptSha256: sha256(provisionBytes) } : {}),
  };
}

function parseSse(textValue) {
  const events = [];
  for (const frame of textValue.split(/\r?\n\r?\n/)) {
    const eventName = frame
      .split(/\r?\n/)
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!eventName || !data) continue;
    try {
      events.push({ eventName, ...JSON.parse(data) });
    } catch {
      throw new ArcRefusal("Studio AI proxy returned malformed SSE JSON");
    }
  }
  return events;
}

export class LiveModelAdapter {
  constructor({ endpoint, credential, fetchImpl = fetch }) {
    this.endpoint = endpoint;
    this.credential = credential;
    this.fetchImpl = fetchImpl;
  }

  async selectTool({ provider, model, prompt, tool, expectedArguments: _expectedArguments }) {
    const response = await this.fetchImpl(`${this.endpoint}/api/v1/studio/ai/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", "x-api-key": this.credential },
      body: JSON.stringify({
        provider,
        model,
        system:
          "You are the Honua 2026.1 candidate verifier. Use only server-authoritative schemas. Never approve publication; Console owns that boundary.",
        messages: [{ role: "user", content: prompt }],
        tools: [tool],
        toolChoice: { mode: "specific", toolName: tool.name },
        temperature: 0,
      }),
    });
    if (!response.ok) throw new ArcRefusal(`Studio AI proxy refused the real-model turn with HTTP ${response.status}`);
    const events = parseSse(await response.text());
    const failure = events.find((event) => event.eventName === "error" || event.type === "error");
    if (failure) throw new ArcRefusal("Studio AI proxy returned an error event");
    const starts = events.filter((event) => event.eventName === "tool_call_start");
    const stops = events.filter((event) => event.eventName === "tool_call_stop");
    if (starts.length !== 1 || stops.length !== 1 || starts[0].toolCallId !== stops[0].toolCallId) {
      throw new ArcRefusal("real model must return exactly one complete tool call");
    }
    const stop = events.find((event) => event.eventName === "message_stop");
    if (stop?.stopReason !== "toolCall") throw new ArcRefusal("real model did not stop for the governed tool call");
    const modelId = events.find((event) => event.eventName === "message_start")?.model;
    return {
      modelId,
      toolName: starts[0].toolName,
      arguments: stops[0].toolArguments,
      transcriptSha256: sha256(canonicalJson(events)),
    };
  }
}

export class LiveMcpCatalogAdapter {
  constructor({ endpoint, credential, fetchImpl = fetch }) {
    this.url = `${endpoint}/mcp`;
    this.credential = credential;
    this.fetchImpl = fetchImpl;
    this.sessionId = undefined;
    this.sequence = 0;
  }

  async request(method, params) {
    this.sequence += 1;
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-api-key": this.credential,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: `honua-studio-ai-arc-${this.sequence}`, method, params }),
    });
    if (!response.ok) throw new ArcRefusal(`candidate MCP endpoint refused ${method} with HTTP ${response.status}`);
    this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
    const raw = await response.text();
    const data = response.headers.get("content-type")?.includes("text/event-stream")
      ? raw
          .split(/\r?\n/)
          .find((line) => line.startsWith("data:"))
          ?.slice(5)
          .trim()
      : raw;
    let envelope;
    try {
      envelope = JSON.parse(data);
    } catch {
      throw new ArcRefusal(`candidate MCP endpoint returned malformed ${method} evidence`);
    }
    if (envelope.error) throw new ArcRefusal(`candidate MCP endpoint returned a protocol error for ${method}`);
    return envelope.result;
  }

  async listTools() {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "honua-studio-real-model-ai-arc", version: "2026.1" },
    });
    const tools = [];
    let cursor;
    do {
      const page = await this.request("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(page?.tools)) throw new ArcRefusal("candidate MCP endpoint returned no tool roster");
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }
}

export async function writeJson(path, value) {
  assertSecretFree(value, `output ${path}`);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
