import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  ArcRefusal,
  EXPECTED_PLAN_SHA256,
  EXPECTED_SDK_SHA,
  LOCAL_EVAL_VERSION,
  LOCAL_PROMPT_VERSION,
  MODEL_ACTION_SPECS,
  buildOperations,
  canonicalJson,
  finalizeArc,
  indexCompletedReceipts,
  parsePlatformManifest,
  prepareArc,
  sha256,
  verifyHandoff,
  verifySourceRevision,
  verifyTranscriptArtifact,
} from "../../scripts/lib/real-model-ai-arc.mjs";

const FAMILIES = ["map", "app", "dashboard"];
const CANONICAL_PLAN_BYTES = await readFile(new URL("./fixtures/zero-to-map/journey.v1.json", import.meta.url));
const CANONICAL_PLAN = JSON.parse(CANONICAL_PLAN_BYTES);
const CANONICAL_CHECKPOINT = JSON.parse(
  await readFile(new URL("./fixtures/zero-to-map/checkpoint.v1.json", import.meta.url), "utf8"),
);
const CANONICAL_ADVERTISED_TOOLS = [
  ...new Set(
    CANONICAL_PLAN.stages
      .flatMap((stage) => stage.actions)
      .filter((action) => action.kind === "mcp")
      .map((action) => action.tool),
  ),
].map((name) => ({ name, description: `Canonical ${name} fixture`, inputSchema: { type: "object" } }));
const CURRENT_HEAD = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const CANDIDATE = `manifest-sha256:${"a".repeat(64)}`;
const COMPONENTS = Object.fromEntries(
  ["honua-server", "honua-sdk-js", "honua-console", "honua-studio", "honua-devops", "honua-iac"].map((name, index) => [
    name,
    name === "honua-sdk-js" ? EXPECTED_SDK_SHA : name === "honua-studio" ? CURRENT_HEAD : String(index + 1).repeat(40),
  ]),
);

const CAPTURES = {
  "create-connection": { connectionId: "connection-1" },
  "publish-parcels": { parcelsLayerId: 7 },
  "publish-zoning": { zoningLayerId: 8 },
  "buffer-esri-mcp": {
    esriMcpJobId: "esri-job",
    esriMcpServiceId: "analysis",
    esriMcpTaskName: "Buffer",
    esriMcpProcessId: "geometry.buffer",
  },
  "read-esri-mcp-buffer-results": {
    esriMcpArtifactId: "esri-artifact",
    esriMcpResultPackageId: "esri-result-package",
  },
  "buffer-esri-gpserver": { gpServerJobId: "gpserver-job" },
  "buffer-parcels": { directAnalysisJobId: "native-job" },
  "read-direct-buffer-results": { bufferArtifactId: "buffer-artifact" },
  "create-map-draft": { mapDraftId: "map-draft", mapItemId: "map-item" },
  "save-map-version": { mapVersionId: "map-version", mapContentHash: "map-hash" },
  "reopen-map-version": { mapReopenedDraftId: "map-reopened" },
  "propose-map-publication": { mapProposalGeneration: 3 },
  "save-map-publication-version": {
    mapPublicationVersionId: "map-publication-version",
    mapPublicationContentHash: "map-publication-hash",
  },
  "create-app-draft": { appDraftId: "app-draft", appItemId: "app-item" },
  "save-app-version": { appVersionId: "app-version", appContentHash: "app-hash" },
  "reopen-app-version": { appReopenedDraftId: "app-reopened" },
  "propose-app-publication": { appProposalGeneration: 3 },
  "save-app-publication-version": {
    appPublicationVersionId: "app-publication-version",
    appPublicationContentHash: "app-publication-hash",
  },
  "create-dashboard-draft": { dashboardDraftId: "dashboard-draft", dashboardItemId: "dashboard-item" },
  "save-dashboard-version": { dashboardVersionId: "dashboard-version", dashboardContentHash: "dashboard-hash" },
  "reopen-dashboard-version": { dashboardReopenedDraftId: "dashboard-reopened" },
  "propose-dashboard-publication": { dashboardProposalGeneration: 3 },
  "save-dashboard-publication-version": {
    dashboardPublicationVersionId: "dashboard-publication-version",
    dashboardPublicationContentHash: "dashboard-publication-hash",
  },
};

function modelAction(spec) {
  const captures = CAPTURES[spec.id] ?? {};
  if (spec.kind === "mcp-resource") {
    const job = spec.id.includes("esri") ? "${esriMcpJobId}" : "${directAnalysisJobId}";
    return {
      id: spec.id,
      title: spec.id,
      kind: "mcp-resource",
      uri: `honua://jobs/${job}${spec.id.includes("read-") ? "/results" : ""}`,
      captures: Object.keys(captures).map((variable) => ({ variable, pointers: [`/contents/0/${variable}`] })),
      _captures: captures,
    };
  }
  if (spec.kind === "gpserver") {
    return {
      id: spec.id,
      title: spec.id,
      kind: "gpserver",
      serviceId: "analysis",
      taskName: "Buffer",
      processId: "geometry.buffer",
      parameters: { distance: 25 },
      resultNames: ["result"],
      captures: Object.keys(captures).map((variable) => ({ variable, pointers: [`/${variable}`] })),
      _captures: captures,
    };
  }
  const argumentsValue = FAMILIES.includes(spec.family)
    ? {
        family: spec.family,
        draftId: `\${${spec.family}${spec.id.includes("publication") ? "Reopened" : ""}DraftId}`,
      }
    : spec.id === "test-connection"
      ? { id: "${connectionId}" }
      : spec.id === "set-public-access"
        ? { serviceName: "${serviceName}" }
        : {};
  return {
    id: spec.id,
    title: spec.id,
    kind: "mcp",
    tool: spec.tool,
    arguments: argumentsValue,
    captures: Object.keys(captures).map((variable) => ({ variable, pointers: [`/structuredContent/${variable}`] })),
    _captures: captures,
  };
}

function fixture(target = "aws-ecs") {
  const install = [
    { id: "install-local", title: "install-local", kind: "cli", args: ["admin", "install"] },
    { id: "install-status", title: "install-status", kind: "cli", args: ["admin", "status"] },
  ];
  const modeled = MODEL_ACTION_SPECS.map(modelAction);
  const proposalIds = new Set([
    "propose-map-publication",
    "save-map-publication-version",
    "propose-app-publication",
    "save-app-publication-version",
    "propose-dashboard-publication",
    "save-dashboard-publication-version",
  ]);
  const stages = [
    { number: 1, id: "install", title: "install", actions: install },
    {
      number: 2,
      id: "admin",
      title: "admin",
      actions: modeled.filter(
        (item) =>
          item.id.startsWith("admin-") ||
          [
            "create-connection",
            "test-connection",
            "import-parcels",
            "import-zoning",
            "publish-parcels",
            "publish-zoning",
            "set-public-access",
            "create-scoped-key",
          ].includes(item.id),
      ),
    },
    {
      number: 3,
      id: "geoprocessing",
      title: "geoprocessing",
      actions: modeled.filter((item) =>
        ["esriGp", "nativeAnalysis"].includes(MODEL_ACTION_SPECS.find((spec) => spec.id === item.id).lane),
      ),
    },
    {
      number: 4,
      id: "studio",
      title: "studio",
      actions: modeled.filter(
        (item) =>
          MODEL_ACTION_SPECS.find((spec) => spec.id === item.id).lane === "studioPublication" &&
          !proposalIds.has(item.id),
      ),
    },
    { number: 5, id: "proposal", title: "proposal", actions: modeled.filter((item) => proposalIds.has(item.id)) },
    {
      number: 6,
      id: "console",
      title: "console",
      actions: [
        {
          id: "console-approval",
          title: "console",
          kind: "receipt",
          receiptSchema: "honua.zero-to-map.console-receipt/v1",
          matches: { "/candidate/candidateId": "${candidateId}" },
          requiredPointers: ["/proposals/map/proposalId"],
          equalPointers: [["/proposals/map/proposalId", "/publications/map/requestId"]],
        },
      ],
    },
  ];
  const capturedVariables = {
    serviceName: "zero-to-map",
    fixtureBaseUrl: "https://fixtures.example.test",
  };
  let actionSecond = 0;
  const completedStages = stages.slice(0, 5).map((stage) => ({
    number: stage.number,
    id: stage.id,
    title: stage.title,
    status: "passed",
    actions: stage.actions.map(({ _captures = {}, ...planned }) => {
      Object.assign(capturedVariables, _captures);
      const startedAt = new Date(Date.UTC(2026, 7, 20, 0, 0, actionSecond++)).toISOString();
      const finishedAt = new Date(Date.UTC(2026, 7, 20, 0, 0, actionSecond++)).toISOString();
      return {
        id: planned.id,
        kind: planned.kind,
        status: "passed",
        startedAt,
        finishedAt,
        ...(Object.keys(_captures).length ? { captures: _captures } : {}),
      };
    }),
  }));
  const plan = {
    schemaVersion: "honua.zero-to-map.plan/v1",
    journeyId: "2026.1-zero-to-map",
    releaseContract: "honua-release#123/D9.3",
    variables: { serviceName: "zero-to-map" },
    stages: stages.map((stage) => ({
      ...stage,
      actions: stage.actions.map(({ _captures, ...planned }) => planned),
    })),
  };
  const checkpoint = {
    schemaVersion: "honua.zero-to-map.checkpoint/v1",
    state: "paused",
    journeyId: plan.journeyId,
    releaseContract: plan.releaseContract,
    target,
    candidateId: CANDIDATE,
    releaseId: "2026.1-rc.2",
    resume: {
      startedAt: "2026-08-20T00:00:00.000Z",
      capturedVariables,
      completedStages,
      resumeAt: { stageId: "console", actionId: "console-approval" },
    },
    consoleReceiptRequest: {
      schemaVersion: "honua.zero-to-map.console-receipt-request/v1",
      actionId: "console-approval",
      receiptSchema: "honua.zero-to-map.console-receipt/v1",
      matches: { "/candidate/candidateId": CANDIDATE },
      requiredPointers: ["/proposals/map/proposalId"],
      equalPointers: [["/proposals/map/proposalId", "/publications/map/requestId"]],
    },
    integrity: { algorithm: "sha256", digest: "b".repeat(64) },
  };
  const context = {
    target,
    endpoint: "https://candidate.example.test",
    candidateId: CANDIDATE,
    releaseId: "2026.1-rc.2",
    endpointSha256: "c".repeat(64),
    source: { repository: "honua-io/honua-studio", sha: COMPONENTS["honua-studio"] },
    components: COMPONENTS,
    provider: "bedrock",
    requestedModel: "claude-sonnet",
    ...(target === "aws-ecs" ? { provisionReceiptSha256: "d".repeat(64) } : {}),
    checkpoint,
    plan,
  };
  const tools = [...new Set(MODEL_ACTION_SPECS.map((spec) => spec.tool).filter(Boolean))].map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object" },
  }));
  return { context, tools };
}

function consoleReceipt(context) {
  const captured = context.checkpoint.resume.capturedVariables;
  const proposals = {};
  const publications = {};
  const audit = {};
  for (const family of FAMILIES) {
    proposals[family] = {
      draftId: captured[`${family}ReopenedDraftId`],
      generation: captured[`${family}ProposalGeneration`],
      route: `${family}-route`,
      proposalId: `${family}-proposal`,
      executionOperationId: `${family}-operation`,
    };
    publications[family] = {
      requestId: `${family}-proposal`,
      itemId: captured[`${family}ItemId`],
      versionId: captured[`${family}PublicationVersionId`],
      status: "published",
      publicationId: `${family}-publication`,
      publicUrl: `https://public.example.test/${family}`,
    };
    audit[family] = { correlationId: `${family}-audit`, operationId: `${family}-operation` };
  }
  return {
    schemaVersion: "honua.zero-to-map.console-receipt/v1",
    journeyId: "2026.1-zero-to-map",
    releaseContract: "honua-release#123/D9.3",
    status: "passed",
    candidate: { candidateId: context.candidateId, releaseId: context.releaseId },
    proposals,
    publications,
    audit,
    resources: {
      connectionId: captured.connectionId,
      serviceId: captured.serviceName,
      layerIds: { parcels: captured.parcelsLayerId, zoning: captured.zoningLayerId },
      jobs: {
        esriMcp: captured.esriMcpJobId,
        gpServer: captured.gpServerJobId,
        directAnalysis: captured.directAnalysisJobId,
      },
      gp: {
        jobId: captured.esriMcpJobId,
        serviceId: captured.esriMcpServiceId,
        taskName: captured.esriMcpTaskName,
        processId: captured.esriMcpProcessId,
        resultPackageId: captured.esriMcpResultPackageId,
        artifactId: captured.esriMcpArtifactId,
      },
      artifactId: captured.bufferArtifactId,
      studio: Object.fromEntries(
        FAMILIES.map((family) => [
          family,
          {
            draftId: captured[`${family}DraftId`],
            itemId: captured[`${family}ItemId`],
            versionId: captured[`${family}VersionId`],
            contentHash: captured[`${family}ContentHash`],
            reopenedDraftId: captured[`${family}ReopenedDraftId`],
          },
        ]),
      ),
    },
    checks: { health: "passed", audit: "passed", recovery: "passed" },
    shareUrl: publications.app.publicUrl,
  };
}

function sidecar(context, handoff, console, aggregateBytes) {
  const payload = {
    schemaVersion: "honua.console.ai-arc-evidence/v1",
    status: "passed",
    target: context.target,
    candidate: { candidateId: context.candidateId, releaseId: context.releaseId },
    endpointSha256: context.endpointSha256,
    components: context.components,
    handoffDigest: handoff.integrity.digest,
    checkpointDigest: context.checkpoint.integrity.digest,
    aggregateSha256: sha256(aggregateBytes),
    runtime: {
      consoleCommit: context.components["honua-console"],
      serverSourceRevision: context.components["honua-server"],
    },
    publications: Object.fromEntries(
      FAMILIES.map((family) => [
        family,
        {
          proposalId: console.proposals[family].proposalId,
          executionOperationId: console.proposals[family].executionOperationId,
          publicationId: console.publications[family].publicationId,
          publicUrl: console.publications[family].publicUrl,
          auditCorrelationId: console.audit[family].correlationId,
          recovery: {
            status: "passed",
            deliberateFailureJobId: "deliberate-job",
            resumedJobId: "resumed-job",
            actionableDiagnostics: true,
          },
        },
      ]),
    ),
    checks: { browser: "passed", approval: "passed", publication: "passed", audit: "passed", recovery: "passed" },
  };
  return { ...payload, integrity: { algorithm: "sha256", digest: sha256(canonicalJson(payload)) } };
}

function publicFetch(context, overrides = {}) {
  return vi.fn(async (url) => {
    if (String(url).endsWith("/api/v1/capabilities")) {
      return new Response(
        JSON.stringify({
          data: {
            server: {
              deploymentRevision: overrides.serverRevision ?? context.components["honua-server"],
              deploymentRevisionSource: "git",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (String(url).endsWith("/version.json")) {
      return new Response(JSON.stringify({ commit: overrides.consoleCommit ?? context.components["honua-console"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("public", { status: overrides.publicStatus ?? 200 });
  });
}

async function preparedFixture(target = "aws-ecs") {
  const { context, tools } = fixture(target);
  const selectTool = vi.fn(async ({ model, tool, expectedArguments }) => {
    const events = [
      { eventName: "message_start", model },
      { eventName: "tool_call_start", toolCallId: `call-${tool.name}`, toolName: tool.name },
      { eventName: "tool_call_stop", toolCallId: `call-${tool.name}`, toolArguments: expectedArguments },
      { eventName: "message_stop", stopReason: "toolCall" },
    ];
    const transcript = canonicalJson(events);
    const response = canonicalJson({ modelId: model, toolName: tool.name, arguments: expectedArguments });
    return {
      modelId: model,
      toolName: tool.name,
      arguments: expectedArguments,
      transcript,
      transcriptSha256: sha256(transcript),
      response,
      responseSha256: sha256(response),
    };
  });
  const prepared = await prepareArc(context, { mcp: { listTools: async () => tools }, model: { selectTool } });
  return { context, tools, ...prepared, selectTool };
}

async function finalizeFixture(context, prepared, console, fetchImpl = publicFetch(context)) {
  const { handoff, transcriptArtifact, transcriptBytes } = prepared;
  const aggregateBytes = Buffer.from(`${JSON.stringify(console, null, 2)}\n`);
  const consoleEvidence = sidecar(context, handoff, console, aggregateBytes);
  const sidecarBytes = Buffer.from(`${JSON.stringify(consoleEvidence, null, 2)}\n`);
  return finalizeArc(context, handoff, console, "https://evidence.example.test/arc.json", {
    consoleEvidence,
    transcriptArtifact,
    transcriptBytes,
    aggregateBytes,
    sidecarBytes,
    consoleOrigin: "https://console.example.test",
    fetchImpl,
  });
}

function canonicalAction(plan, id) {
  const action = plan.stages.flatMap((stage) => stage.actions).find((candidate) => candidate.id === id);
  if (!action) throw new Error(`canonical fixture action ${id} is missing`);
  return action;
}

function canonicalActionReceipt(checkpoint, id) {
  const receipt = checkpoint.resume.completedStages
    .flatMap((stage) => stage.actions)
    .find((candidate) => candidate.id === id);
  if (!receipt) throw new Error(`canonical fixture action receipt ${id} is missing`);
  return receipt;
}

describe("candidate-bound real-model AI arc", () => {
  it("pins the exact SDK source and canonical plan digest", () => {
    const yaml = [
      'platformRelease: "2026.1-rc.2"',
      "components:",
      ...Object.entries(COMPONENTS).flatMap(([name, revision]) => [`  ${name}:`, `    sha: "${revision}"`]),
    ].join("\n");
    expect(parsePlatformManifest(yaml)).toEqual({ releaseId: "2026.1-rc.2", components: COMPONENTS });
    expect(EXPECTED_PLAN_SHA256).toBe("4358e1c03a56f0cc8996133a608f421a5d9828cb8462a458983eab635348a1fe");

    const stale = yaml.replace(EXPECTED_SDK_SHA, "9".repeat(40));
    expect(() => parsePlatformManifest(stale)).toThrow(EXPECTED_SDK_SHA);
  });

  it("accepts the checksum-bound canonical SDK plan/checkpoint generation timeline", () => {
    expect(sha256(CANONICAL_PLAN_BYTES)).toBe(EXPECTED_PLAN_SHA256);
    expect(CANONICAL_CHECKPOINT.sourceRevision).toBe(EXPECTED_SDK_SHA);
    expect(CANONICAL_CHECKPOINT.planSha256).toBe(EXPECTED_PLAN_SHA256);
    const { integrity, ...checkpointPayload } = CANONICAL_CHECKPOINT;
    expect(integrity).toEqual({ algorithm: "sha256", digest: sha256(canonicalJson(checkpointPayload)) });
    expect(indexCompletedReceipts(CANONICAL_PLAN, CANONICAL_CHECKPOINT)).toHaveProperty("size", 60);
    const operations = buildOperations(CANONICAL_PLAN, CANONICAL_CHECKPOINT, CANONICAL_ADVERTISED_TOOLS);
    expect(operations).toHaveLength(MODEL_ACTION_SPECS.length);
    expect(operations.find((operation) => operation.action.id === "import-parcels")?.expected).toMatchObject({
      body: { sourceUrl: "https://fixtures.example.test/parcels.geojson" },
    });
    expect(CANONICAL_CHECKPOINT.resume.capturedVariables).toMatchObject({
      mapGeneration: 8,
      appGeneration: 8,
      dashboardGeneration: 6,
      mapReopenedGeneration: 2,
      appReopenedGeneration: 2,
      dashboardReopenedGeneration: 2,
    });
  });

  it("rejects hostile generation advances, final snapshots, identities, tools, draft streams, sources, and receipts", () => {
    const generationJump = structuredClone(CANONICAL_CHECKPOINT);
    canonicalActionReceipt(generationJump, "add-map-parcels-layer").captures.mapGeneration = 3;
    expect(() => indexCompletedReceipts(CANONICAL_PLAN, generationJump)).toThrow("must advance by exactly one");

    const finalMismatch = structuredClone(CANONICAL_CHECKPOINT);
    finalMismatch.resume.capturedVariables.mapGeneration = 999;
    expect(() => indexCompletedReceipts(CANONICAL_PLAN, finalMismatch)).toThrow(
      "captures do not equal action receipt captures",
    );

    const missingFixtureSource = structuredClone(CANONICAL_CHECKPOINT);
    const { fixtureBaseUrl: _missingFixture, ...remainingVariables } = missingFixtureSource.resume.capturedVariables;
    missingFixtureSource.resume.capturedVariables = remainingVariables;
    expect(() => indexCompletedReceipts(CANONICAL_PLAN, missingFixtureSource)).toThrow(
      "checkpoint fixtureBaseUrl seed is missing",
    );

    const privateFixtureSource = structuredClone(CANONICAL_CHECKPOINT);
    privateFixtureSource.resume.capturedVariables.fixtureBaseUrl = "https://127.0.0.1";
    expect(() => indexCompletedReceipts(CANONICAL_PLAN, privateFixtureSource)).toThrow(
      "must not use a loopback or private endpoint",
    );

    const immutablePlan = structuredClone(CANONICAL_PLAN);
    const immutableCheckpoint = structuredClone(CANONICAL_CHECKPOINT);
    canonicalAction(immutablePlan, "test-connection").captures = [
      { variable: "connectionId", pointers: ["/structuredContent/connectionId"] },
    ];
    canonicalActionReceipt(immutableCheckpoint, "test-connection").captures = { connectionId: "connectionId-fixture" };
    expect(() => indexCompletedReceipts(immutablePlan, immutableCheckpoint)).toThrow("repeats immutable capture");

    const nonStudioPlan = structuredClone(CANONICAL_PLAN);
    canonicalAction(nonStudioPlan, "add-map-parcels-layer").tool = "honua_admin_generation_advance";
    expect(() => indexCompletedReceipts(nonStudioPlan, CANONICAL_CHECKPOINT)).toThrow("repeats immutable capture");

    const crossDraftPlan = structuredClone(CANONICAL_PLAN);
    canonicalAction(crossDraftPlan, "add-map-parcels-layer").arguments.draftId = "${appDraftId}";
    expect(() => indexCompletedReceipts(crossDraftPlan, CANONICAL_CHECKPOINT)).toThrow(
      "is not the same Studio draft generation stream",
    );

    const wrongSourcePlan = structuredClone(CANONICAL_PLAN);
    canonicalAction(wrongSourcePlan, "add-map-parcels-layer").captures[0].pointers = [
      "/structuredContent/notGeneration",
    ];
    expect(() => indexCompletedReceipts(wrongSourcePlan, CANONICAL_CHECKPOINT)).toThrow(
      "is not the same Studio draft generation stream",
    );

    const aliasMismatch = structuredClone(CANONICAL_CHECKPOINT);
    canonicalActionReceipt(aliasMismatch, "propose-map-publication").captures.mapProposalGeneration = 99;
    expect(() => indexCompletedReceipts(CANONICAL_PLAN, aliasMismatch)).toThrow(
      "captured different values from the same response source",
    );

    const missingCapture = structuredClone(CANONICAL_CHECKPOINT);
    const missingCaptureReceipt = canonicalActionReceipt(missingCapture, "add-map-parcels-layer");
    const { mapGeneration: _omitted, ...remainingCaptures } = missingCaptureReceipt.captures;
    missingCaptureReceipt.captures = remainingCaptures;
    expect(() => indexCompletedReceipts(CANONICAL_PLAN, missingCapture)).toThrow("must have the exact fields");

    const hostileReceipt = structuredClone(CANONICAL_CHECKPOINT);
    canonicalActionReceipt(hostileReceipt, "add-map-parcels-layer").message =
      "passed receipts cannot carry diagnostics";
    expect(() => indexCompletedReceipts(CANONICAL_PLAN, hostileReceipt)).toThrow("must have the exact fields");

    const hostileTimeline = structuredClone(CANONICAL_CHECKPOINT);
    canonicalActionReceipt(hostileTimeline, "add-map-parcels-layer").startedAt = CANONICAL_CHECKPOINT.resume.startedAt;
    expect(() => indexCompletedReceipts(CANONICAL_PLAN, hostileTimeline)).toThrow(
      "outside the completed receipt timeline",
    );
  });

  it("binds source claims to actual git HEAD rather than a caller override", () => {
    expect(verifySourceRevision(CURRENT_HEAD, { components: COMPONENTS })).toBe(CURRENT_HEAD);
    expect(() => verifySourceRevision("f".repeat(40), { components: COMPONENTS })).toThrow(
      "producer is not running from the manifest-pinned honua-studio SHA",
    );
  });

  it("forces every canonical action and multiplicity through the model", async () => {
    const { handoff, selectTool } = await preparedFixture();
    expect(selectTool).toHaveBeenCalledTimes(MODEL_ACTION_SPECS.length);
    expect(handoff.lanes.admin.calls).toContainEqual(
      expect.objectContaining({ actionId: "create-scoped-key", name: "honua_admin_api_key_create" }),
    );
    expect(handoff.lanes.studioPublication.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actionId: "set-map-buffer-visibility", role: "set-layer-visibility" }),
        expect.objectContaining({ actionId: "bind-app-chart-interaction", role: "bind-interaction" }),
        expect.objectContaining({ actionId: "add-map-parcels-layer" }),
        expect.objectContaining({ actionId: "add-map-buffer-layer" }),
      ]),
    );
    for (const call of Object.values(handoff.lanes).flatMap((lane) => lane.calls)) {
      expect(call.actionReceiptSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("fails closed on an omitted or substituted canonical action", () => {
    const { context, tools } = fixture();
    const studio = context.plan.stages.find((stage) => stage.id === "studio");
    const completed = context.checkpoint.resume.completedStages.find((stage) => stage.id === "studio");
    const index = studio.actions.findIndex((action) => action.id === "set-map-buffer-visibility");
    studio.actions.splice(index, 1);
    completed.actions.splice(index, 1);
    expect(() => buildOperations(context.plan, context.checkpoint, tools)).toThrow(
      "SDK plan is missing exact model action set-map-buffer-visibility",
    );

    const next = fixture();
    const action = next.context.plan.stages
      .find((stage) => stage.id === "proposal")
      .actions.find((item) => item.id === "propose-map-publication");
    action.tool = "honua_studio_save_version";
    expect(() => buildOperations(next.context.plan, next.context.checkpoint, next.tools)).toThrow(
      "does not match its canonical kind/tool/family contract",
    );
  });

  it("strictly revalidates the immutable handoff call roster and joins", async () => {
    const { context, handoff } = await preparedFixture();
    expect(verifyHandoff(handoff, context)).toBe(handoff);
    const forged = structuredClone(handoff);
    forged.lanes.admin.calls[0].actionId = "forged";
    const { integrity: _old, ...payload } = forged;
    forged.integrity = { algorithm: "sha256", digest: sha256(canonicalJson(payload)) };
    expect(() => verifyHandoff(forged, context)).toThrow("real-model call admin-status");

    const weakened = structuredClone(context);
    weakened.checkpoint.consoleReceiptRequest.matches = {};
    expect(() => verifyHandoff(handoff, weakened)).toThrow("canonical plan-resolved receipt contract");
  });

  it("requires the distinct digest-bound Console sidecar and credential-free public runtime rereads", async () => {
    const prepared = await preparedFixture();
    const { context, handoff } = prepared;
    const console = consoleReceipt(context);
    const result = await finalizeFixture(context, prepared, console);
    expect(result.receipt.status).toBe("passed");
    expect(result.evidence.consoleAggregateSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.evidence.consoleEvidenceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.evidence.transcriptArtifactSha256).toBe(sha256(prepared.transcriptBytes));

    const tamperedTranscript = structuredClone(prepared.transcriptArtifact);
    tamperedTranscript.lanes.admin[0].response = canonicalJson({
      modelId: handoff.model.modelId,
      toolName: "forged",
      arguments: {},
    });
    const tamperedBytes = `${JSON.stringify(tamperedTranscript, null, 2)}\n`;
    const tamperedHandoff = { ...handoff, transcriptArtifactSha256: sha256(tamperedBytes) };
    expect(() => verifyTranscriptArtifact(tamperedTranscript, tamperedBytes, tamperedHandoff, context)).toThrow(
      "does not prove its selected response",
    );

    await expect(
      finalizeFixture(context, prepared, console, publicFetch(context, { serverRevision: "f".repeat(40) })),
    ).rejects.toThrow("public server capabilities do not prove");
  });

  it("emits the strict Release-certified local Docker receipt and detailed evidence", async () => {
    const prepared = await preparedFixture("local-docker");
    const { context, handoff } = prepared;
    const console = consoleReceipt(context);
    const result = await finalizeFixture(context, prepared, console);

    expect(Object.keys(result.receipt).sort()).toEqual(
      [
        "schemaVersion",
        "id",
        "status",
        "target",
        "candidateId",
        "releaseId",
        "endpointSha256",
        "source",
        "components",
        "model",
        "promptVersion",
        "evalVersion",
        "transcriptSha256",
        "transcriptArtifactSha256",
        "deterministic",
        "lanes",
        "joins",
        "checks",
        "evidence",
      ].sort(),
    );
    expect(result.receipt).toEqual(
      expect.objectContaining({
        schemaVersion: "honua.local-docker.real-model-ai-arc/v1",
        id: "local-docker-real-model-ai-arc",
        status: "passed",
        target: "local-docker",
        candidateId: context.candidateId,
        releaseId: context.releaseId,
        endpointSha256: context.endpointSha256,
        source: context.source,
        components: context.components,
        promptVersion: LOCAL_PROMPT_VERSION,
        evalVersion: LOCAL_EVAL_VERSION,
        transcriptSha256: handoff.transcriptSha256,
        transcriptArtifactSha256: handoff.transcriptArtifactSha256,
        lanes: result.evidence.lanes,
        joins: result.evidence.joins,
      }),
    );
    expect(result.receipt.deterministic).toEqual({
      target: "local-docker",
      checkpointDigest: context.checkpoint.integrity.digest,
      consoleAggregateSha256: result.evidence.consoleAggregateSha256,
      consoleEvidenceSha256: result.evidence.consoleEvidenceSha256,
    });
    expect(result.receipt.checks).toEqual({
      "natural-language-admin-setup-config-publish": "passed",
      "natural-language-esri-gp": "passed",
      "natural-language-native-analysis": "passed",
      "natural-language-map-app-dashboard-composition-publication": "passed",
      "deterministic-id-join": "passed",
      "same-endpoint-candidate": "passed",
      "no-secret-serialization": "passed",
    });
    expect(result.evidence).toEqual({
      schemaVersion: "honua.local-docker.real-model-ai-arc-evidence/v1",
      candidateId: context.candidateId,
      releaseId: context.releaseId,
      endpointSha256: context.endpointSha256,
      source: context.source,
      model: handoff.model,
      promptVersion: LOCAL_PROMPT_VERSION,
      evalVersion: LOCAL_EVAL_VERSION,
      transcriptSha256: handoff.transcriptSha256,
      transcriptArtifactSha256: handoff.transcriptArtifactSha256,
      target: "local-docker",
      checkpointDigest: context.checkpoint.integrity.digest,
      consoleAggregateSha256: result.receipt.deterministic.consoleAggregateSha256,
      consoleEvidenceSha256: result.receipt.deterministic.consoleEvidenceSha256,
      lanes: result.receipt.lanes,
      joins: result.receipt.joins,
    });
    expect(result.receipt.evidence).toEqual({
      url: "https://evidence.example.test/arc.json",
      sha256: sha256(result.evidenceBytes),
    });
    expect(Object.keys(result.receipt.joins).length).toBeGreaterThanOrEqual(40);
    expect(result.receipt).not.toHaveProperty("claims");
    expect(result.receipt.deterministic).not.toHaveProperty("provisionReceiptSha256");
  });

  it("rejects an SDK projection, tampered sidecar, or insecure public URL", async () => {
    const prepared = await preparedFixture();
    const { context, handoff } = prepared;
    const console = consoleReceipt(context);
    await expect(
      finalizeArc(
        context,
        handoff,
        { ...console, proposals: undefined, proposal: console.proposals.app },
        "https://evidence.example.test/a",
        { transcriptArtifact: prepared.transcriptArtifact, transcriptBytes: prepared.transcriptBytes },
      ),
    ).rejects.toThrow("Console aggregate receipt");

    const aggregateBytes = Buffer.from(`${JSON.stringify(console, null, 2)}\n`);
    const consoleEvidence = sidecar(context, handoff, console, aggregateBytes);
    consoleEvidence.aggregateSha256 = "f".repeat(64);
    const sidecarBytes = Buffer.from(`${JSON.stringify(consoleEvidence, null, 2)}\n`);
    await expect(
      finalizeArc(context, handoff, console, "https://evidence.example.test/a", {
        transcriptArtifact: prepared.transcriptArtifact,
        transcriptBytes: prepared.transcriptBytes,
        consoleEvidence,
        aggregateBytes,
        sidecarBytes,
        consoleOrigin: "https://console.example.test",
        fetchImpl: publicFetch(context),
      }),
    ).rejects.toThrow("not digest-bound");

    const insecure = consoleReceipt(context);
    insecure.publications.app.publicUrl = "http://example.test/app";
    insecure.shareUrl = insecure.publications.app.publicUrl;
    await expect(finalizeFixture(context, prepared, insecure)).rejects.toThrow(
      "Console app publicUrl must be credential-free HTTPS",
    );
  });
});
