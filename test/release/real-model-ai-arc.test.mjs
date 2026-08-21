import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ArcRefusal,
  buildOperations,
  canonicalJson,
  finalizeArc,
  loadArcContext,
  parsePlatformManifest,
  prepareArc,
  sha256,
} from "../../scripts/lib/real-model-ai-arc.mjs";

const FAMILIES = ["map", "app", "dashboard"];
const CANDIDATE = `manifest-sha256:${"a".repeat(64)}`;
const COMPONENTS = Object.fromEntries(
  ["honua-server", "honua-sdk-js", "honua-console", "honua-studio", "honua-devops", "honua-iac"].map((name, index) => [
    name,
    String(index + 1).repeat(40),
  ]),
);

function action(id, tool, captures = {}, argumentsValue = {}) {
  return {
    id,
    title: id.replaceAll("-", " "),
    kind: "mcp",
    tool,
    arguments: argumentsValue,
    captures: Object.keys(captures).map((variable) => ({ variable, pointers: ["/structuredContent/value"] })),
    _captures: captures,
  };
}

function resource(id, uri, captures = {}) {
  return {
    id,
    title: id.replaceAll("-", " "),
    kind: "mcp-resource",
    uri,
    captures: Object.keys(captures).map((variable) => ({ variable, pointers: ["/contents/0/text"] })),
    _captures: captures,
  };
}

function fixture() {
  const admin = [
    action("admin-status", "honua_admin_server_status"),
    action("create-connection", "honua_admin_connection_create", { connectionId: "connection-1" }),
    action("test-connection", "honua_admin_connection_test", {}, { id: "${connectionId}" }),
    action("import-parcels", "honua_admin_import_upload_url"),
    action("import-zoning", "honua_admin_import_upload_url"),
    action("publish-parcels", "honua_admin_layer_publish", { parcelsLayerId: 7 }),
    action("publish-zoning", "honua_admin_layer_publish", { zoningLayerId: 8 }),
    action("set-public-access", "honua_admin_service_set_access_policy", {}, { serviceName: "${serviceName}" }),
  ];
  const gp = [
    action("list-esri-gp-tasks", "honua_esri_gp_list_tasks"),
    action("describe-esri-buffer", "honua_esri_gp_describe_task"),
    action("buffer-esri-mcp", "honua_esri_gp_execute_task", { esriMcpJobId: "esri-job" }),
    resource("wait-esri-mcp-buffer", "honua://jobs/${esriMcpJobId}"),
    resource("read-esri-mcp-buffer-results", "honua://jobs/${esriMcpJobId}/results"),
    {
      id: "buffer-esri-gpserver",
      title: "buffer through the direct GPServer alias",
      kind: "gpserver",
      serviceId: "analysis",
      taskName: "Buffer",
      processId: "geometry.buffer",
      parameters: { distance: 25 },
      resultNames: ["result"],
      captures: [{ variable: "gpServerJobId", pointers: ["/jobId"] }],
      _captures: { gpServerJobId: "gpserver-job" },
    },
    action("buffer-parcels", "honua_buffer_features", { directAnalysisJobId: "native-job" }),
    resource("wait-direct-buffer", "honua://jobs/${directAnalysisJobId}"),
    resource("read-direct-buffer-results", "honua://jobs/${directAnalysisJobId}/results"),
  ];
  const studio = [];
  const proposal = [];
  for (const family of FAMILIES) {
    studio.push(
      action(
        `create-${family}-draft`,
        "honua_studio_create_draft",
        { [`${family}DraftId`]: `${family}-draft` },
        { family },
      ),
      action(`add-${family}-layer`, "honua_studio_add_layer", {}, { draftId: `\${${family}DraftId}` }),
      action(`style-${family}-layer`, "honua_studio_set_layer_style", {}, { draftId: `\${${family}DraftId}` }),
      action(`set-${family}-view`, "honua_studio_set_view", {}, { draftId: `\${${family}DraftId}` }),
      action(`add-${family}-widget`, "honua_studio_add_widget", {}, { draftId: `\${${family}DraftId}` }),
      action(`add-${family}-control`, "honua_studio_add_control", {}, { draftId: `\${${family}DraftId}` }),
      action(`validate-${family}-draft`, "honua_studio_validate_draft", {}, { draftId: `\${${family}DraftId}` }),
      action(
        `save-${family}-version`,
        "honua_studio_save_version",
        {
          [`${family}VersionId`]: `${family}-version`,
          [`${family}ContentHash`]: `${family}-hash`,
        },
        { draftId: `\${${family}DraftId}` },
      ),
      action(`get-${family}-version`, "honua_studio_get_version", {}, { versionId: `\${${family}VersionId}` }),
      action(
        `reopen-${family}-version`,
        "honua_studio_reopen_version",
        { [`${family}ReopenedDraftId`]: `${family}-reopened` },
        { versionId: `\${${family}VersionId}` },
      ),
    );
    proposal.push(
      action(
        `propose-${family}-publication`,
        "honua_studio_propose_publication",
        { [`${family}HumanConfirmationRequired`]: true },
        { draftId: `\${${family}ReopenedDraftId}` },
      ),
      action(
        `save-${family}-publication-version`,
        "honua_studio_save_version",
        {
          [`${family}PublicationVersionId`]: `${family}-publication-version`,
          [`${family}PublicationContentHash`]: `${family}-publication-hash`,
        },
        { draftId: `\${${family}ReopenedDraftId}` },
      ),
    );
  }
  const stages = [
    { number: 1, id: "admin", title: "admin", actions: admin },
    { number: 2, id: "geoprocessing", title: "geoprocessing", actions: gp },
    { number: 3, id: "studio", title: "studio", actions: studio },
    { number: 4, id: "proposal", title: "proposal", actions: proposal },
    { number: 5, id: "console", title: "console", actions: [] },
  ];
  const capturedVariables = { serviceName: "zero-to-map" };
  const completedStages = stages.slice(0, 4).map((stage) => ({
    number: stage.number,
    id: stage.id,
    title: stage.title,
    status: "passed",
    actions: stage.actions.map(({ _captures, ...planned }) => {
      Object.assign(capturedVariables, _captures);
      return {
        id: planned.id,
        kind: planned.kind,
        status: "passed",
        startedAt: "2026-08-20T00:00:00.000Z",
        finishedAt: "2026-08-20T00:00:01.000Z",
        ...(Object.keys(_captures).length ? { captures: _captures } : {}),
      };
    }),
  }));
  const cleanStages = stages.map((stage) => ({
    ...stage,
    actions: stage.actions.map(({ _captures, ...planned }) => planned),
  }));
  const plan = {
    schemaVersion: "honua.zero-to-map.plan/v1",
    journeyId: "2026.1-zero-to-map",
    releaseContract: "honua-release#123/D9.3",
    variables: { serviceName: "zero-to-map" },
    stages: cleanStages,
  };
  const checkpoint = {
    schemaVersion: "honua.zero-to-map.checkpoint/v1",
    state: "paused",
    journeyId: plan.journeyId,
    releaseContract: plan.releaseContract,
    target: "aws-ecs",
    resume: {
      capturedVariables,
      completedStages,
      resumeAt: { stageId: "console", actionId: "console-approval" },
    },
    consoleReceiptRequest: {
      schemaVersion: "honua.zero-to-map.console-receipt-request/v1",
      actionId: "console-approval",
      receiptSchema: "honua.zero-to-map.console-receipt/v1",
      matches: {},
      requiredPointers: ["/proposals/map/proposalId"],
      equalPointers: [["/proposals/map/proposalId", "/publications/map/requestId"]],
    },
    integrity: { algorithm: "sha256", digest: "b".repeat(64) },
  };
  const context = {
    target: "aws-ecs",
    candidateId: CANDIDATE,
    releaseId: "2026.1-rc.2",
    endpointSha256: "c".repeat(64),
    source: { repository: "honua-io/honua-studio", sha: COMPONENTS["honua-studio"] },
    components: COMPONENTS,
    provider: "bedrock",
    requestedModel: "claude-sonnet",
    provisionReceiptSha256: "d".repeat(64),
    checkpoint,
    plan,
  };
  const tools = [
    ...new Set(cleanStages.flatMap((stage) => stage.actions.map((item) => item.tool).filter(Boolean))),
  ].map((name) => ({ name, description: name, inputSchema: { type: "object" } }));
  return { context, tools };
}

function consoleReceipt(context) {
  const proposals = {};
  const publications = {};
  const audit = {};
  for (const family of FAMILIES) {
    proposals[family] = {
      draftId: `${family}-reopened`,
      generation: 3,
      route: `${family}-route`,
      proposalId: `${family}-proposal`,
      executionOperationId: `${family}-operation`,
    };
    publications[family] = {
      requestId: `${family}-proposal`,
      itemId: `${family}-item`,
      versionId: `${family}-publication-version`,
      status: "published",
      publicationId: `${family}-publication`,
      publicUrl: `https://example.test/${family}`,
    };
    audit[family] = { correlationId: `${family}-audit`, operationId: `${family}-operation` };
  }
  return {
    schemaVersion: "honua.zero-to-map.console-receipt/v1",
    journeyId: "2026.1-zero-to-map",
    releaseContract: "honua-release#123/D9.3",
    status: "passed",
    proposals,
    publications,
    audit,
    resources: {},
    candidate: { candidateId: context.candidateId, releaseId: context.releaseId },
    checks: { health: "passed", audit: "passed", recovery: "passed" },
    shareUrl: "https://example.test/app",
  };
}

describe("candidate-bound real-model AI arc", () => {
  it("parses only exact release/component identities from the platform manifest", () => {
    const yaml = [
      'platformRelease: "2026.1-rc.2" # candidate',
      "components:",
      ...Object.entries(COMPONENTS).flatMap(([name, revision]) => [`  ${name}:`, `    sha: "${revision}"`]),
    ].join("\n");
    expect(parsePlatformManifest(yaml)).toEqual({ releaseId: "2026.1-rc.2", components: COMPONENTS });
  });

  it("loads only an integrity-sealed SDK checkpoint bound to exact plan, endpoint, manifest, and Studio SHA", async () => {
    const { context } = fixture();
    const directory = await mkdtemp(join(tmpdir(), "honua-studio-ai-arc-"));
    try {
      const manifestBytes = Buffer.from(
        [
          'platformRelease: "2026.1-rc.2"',
          "components:",
          ...Object.entries(COMPONENTS).flatMap(([name, revision]) => [`  ${name}:`, `    sha: "${revision}"`]),
        ].join("\n"),
      );
      const planBytes = Buffer.from(JSON.stringify(context.plan));
      const {
        integrity: _fixtureIntegrity,
        provisionReceiptSha256: _fixtureProvisionReceiptSha256,
        ...checkpointBase
      } = context.checkpoint;
      const checkpointPayload = {
        ...checkpointBase,
        createdAt: "2026-08-20T00:00:00.000Z",
        sourceRevision: COMPONENTS["honua-sdk-js"],
        planSha256: sha256(planBytes),
        mcpEndpointSha256: sha256("https://local.example.test/mcp"),
        candidateId: `manifest-sha256:${sha256(manifestBytes)}`,
        releaseId: "2026.1-rc.2",
        target: "local-docker",
        resume: { ...context.checkpoint.resume, startedAt: "2026-08-20T00:00:00.000Z" },
      };
      const checkpoint = {
        ...checkpointPayload,
        integrity: { algorithm: "sha256", digest: sha256(canonicalJson(checkpointPayload)) },
      };
      const paths = {
        manifest: join(directory, "platform-manifest.yaml"),
        plan: join(directory, "journey.v1.json"),
        checkpoint: join(directory, "checkpoint.json"),
      };
      await Promise.all([
        writeFile(paths.manifest, manifestBytes),
        writeFile(paths.plan, planBytes),
        writeFile(paths.checkpoint, JSON.stringify(checkpoint)),
      ]);
      const loaded = await loadArcContext(paths, {
        endpoint: "https://local.example.test",
        provider: "bedrock",
        model: "claude-sonnet",
        sourceSha: COMPONENTS["honua-studio"],
        now: new Date("2026-08-20T12:00:00.000Z"),
      });
      expect(loaded.candidateId).toBe(checkpoint.candidateId);
      expect(loaded.endpointSha256).toBe(sha256("https://local.example.test"));
      await writeFile(paths.plan, `${planBytes.toString("utf8")}\n`);
      await expect(
        loadArcContext(paths, {
          endpoint: "https://local.example.test",
          provider: "bedrock",
          model: "claude-sonnet",
          sourceSha: COMPONENTS["honua-studio"],
          now: new Date("2026-08-20T12:00:00.000Z"),
        }),
      ).rejects.toThrow("SDK plan bytes do not match checkpoint.planSha256");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("forces every full-family operation through the model and seals a Console-paused handoff", async () => {
    const { context, tools } = fixture();
    const selectTool = vi.fn(async ({ model, tool, expectedArguments }) => ({
      modelId: model,
      toolName: tool.name,
      arguments: expectedArguments,
      transcriptSha256: sha256(canonicalJson({ tool: tool.name, expectedArguments })),
    }));
    const handoff = await prepareArc(context, { mcp: { listTools: async () => tools }, model: { selectTool } });
    expect(handoff.status).toBe("paused");
    expect(handoff.schemaVersion).toBe("honua.studio.real-model-ai-arc-handoff/v1");
    expect(handoff.joins).not.toHaveProperty("mapHumanConfirmationRequired");
    expect(handoff.lanes.studioPublication.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ family: "map", role: "add-widget", name: "honua_studio_add_widget" }),
        expect.objectContaining({ family: "app", role: "set-view", name: "honua_studio_set_view" }),
        expect.objectContaining({ family: "dashboard", role: "add-control", name: "honua_studio_add_control" }),
      ]),
    );
    expect(handoff.lanes.nativeAnalysis.calls).toContainEqual(
      expect.objectContaining({ role: "execute-buffer-gpserver", name: "GPServer/analysis/Buffer" }),
    );
    expect(selectTool).toHaveBeenCalledTimes(buildOperations(context.plan, context.checkpoint, tools).length);
  });

  it("adds only Console-owned approval joins before emitting DevOps-compatible AWS evidence", async () => {
    const { context, tools } = fixture();
    const handoff = await prepareArc(context, {
      mcp: { listTools: async () => tools },
      model: {
        selectTool: async ({ model, tool, expectedArguments }) => ({
          modelId: model,
          toolName: tool.name,
          arguments: expectedArguments,
          transcriptSha256: sha256(canonicalJson({ tool: tool.name, expectedArguments })),
        }),
      },
    });
    const result = finalizeArc(context, handoff, consoleReceipt(context), "https://evidence.example.test/arc.json");
    expect(result.evidence.schemaVersion).toBe("honua.aws-ecs.real-model-ai-arc-evidence/v1");
    expect(result.receipt.schemaVersion).toBe("honua.aws-ecs.real-model-ai-arc/v1");
    expect(result.receipt.status).toBe("passed");
    expect(result.receipt.joins.mapProposalId).toBe("map-proposal");
    expect(result.receipt.lanes.studioPublication.calls).toContainEqual(
      expect.objectContaining({
        family: "map",
        role: "propose-publication",
        result: expect.objectContaining({ identities: expect.objectContaining({ mapProposalId: "map-proposal" }) }),
      }),
    );
    expect(result.receipt.evidence.sha256).toBe(sha256(result.evidenceBytes));
  });

  it("fails closed when the deterministic SDK plan lacks one family operation", () => {
    const { context, tools } = fixture();
    const widget = context.plan.stages[2].actions.findIndex((item) => item.id === "add-dashboard-widget");
    context.plan.stages[2].actions.splice(widget, 1);
    context.checkpoint.resume.completedStages[2].actions.splice(widget, 1);
    expect(() => buildOperations(context.plan, context.checkpoint, tools)).toThrowError(
      new ArcRefusal("manifest-pinned SDK plan lacks dashboard real-model actions: add-widget"),
    );
  });

  it("never treats an unapproved or HTTP Console link as passed", async () => {
    const { context, tools } = fixture();
    const handoff = await prepareArc(context, {
      mcp: { listTools: async () => tools },
      model: {
        selectTool: async ({ model, tool, expectedArguments }) => ({
          modelId: model,
          toolName: tool.name,
          arguments: expectedArguments,
          transcriptSha256: "e".repeat(64),
        }),
      },
    });
    const console = consoleReceipt(context);
    console.publications.app.publicUrl = "http://example.test/app";
    expect(() => finalizeArc(context, handoff, console, "https://evidence.example.test/arc.json")).toThrow(
      "Console app publicUrl must be credential-free HTTPS",
    );
  });
});
