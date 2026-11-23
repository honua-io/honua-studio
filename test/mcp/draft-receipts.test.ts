import { afterEach, describe, expect, it } from "vitest";
import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { CompositionController } from "../../src/composition/controller.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import { McpClient } from "../../src/mcp/client.js";
import { ToolCallOrchestrator } from "../../src/mcp/orchestrator.js";
import { StudioMcpToolClient, parseStudioDraftResult } from "../../src/mcp/studio-tools.js";

const draft = {
  draftId: "draft-1",
  packageKey: "map-1",
  generation: 1,
  envelope: { family: "map", schemaVersion: "1", body: { layers: [], view: {}, widgets: [] } },
};
const operation = { status: "RequiresApproval", operationInstanceId: "op-1", proposalId: "proposal-1" };
const receipt = { operation, draftId: null, generation: null, envelope: null };

describe("MCP draft operation receipts", () => {
  it.each(["RequiresApproval", "requiresApproval", 4])("preserves approval details for status %s", (status) => {
    expect(() =>
      parseStudioDraftResult({ structuredContent: { ...receipt, operation: { ...operation, status } } }),
    ).toThrow(
      expect.objectContaining({
        code: "approval-pending",
        pending: expect.objectContaining({ proposalId: "proposal-1" }),
      }),
    );
  });

  it.each(["Completed", "completed", 1])("accepts completed status %s and plain get-draft responses", (status) => {
    expect(parseStudioDraftResult({ structuredContent: { ...draft, operation: { status } } })).toMatchObject(draft);
    expect(parseStudioDraftResult({ content: [{ type: "text", text: JSON.stringify(draft) }] })).toEqual(draft);
  });

  it.each(["Accepted", "Running", "Denied", "Failed", 0, 3, 6, null])(
    "does not apply nonterminal or failed status %s",
    (status) => {
      expect(() => parseStudioDraftResult({ structuredContent: { ...draft, operation: { status } } })).toThrow();
    },
  );

  it.each([null, {}, { ...draft, envelope: null }, { ...draft, generation: null }])(
    "rejects missing draft data",
    (value) => {
      expect(() => parseStudioDraftResult({ content: [{ type: "text", text: JSON.stringify(value) }] })).toThrow();
    },
  );
});

describe("approval handoff over MCP", () => {
  let server: Awaited<ReturnType<typeof startMockServer>>;
  afterEach(async () => {
    await server?.close();
  });
  async function setup(approvalTools = ["honua_studio_create_draft"]) {
    server = await startMockServer({ approvalTools });
    const calls: string[] = [];
    const client = new McpClient({
      baseUrl: server.url,
      auth: { getAccessToken: async () => mintFixtureAccessToken() },
      fetchImpl: async (input, init) => {
        const request = JSON.parse(String(init?.body));
        if (request.method === "tools/call") calls.push(request.params.name);
        return fetch(input, init);
      },
    });
    const controller = new CompositionController(createEmptyCompositionState());
    const orchestrator = new ToolCallOrchestrator({ controller, live: { client, packageKey: "map-1" } });
    return { client, controller, orchestrator, calls, tools: new StudioMcpToolClient(client) };
  }
  const intent = { toolName: "add_layer", arguments: { datasetId: "hi-parcels" } };

  it("uses receipt parsing in typed create calls too", async () => {
    const { tools } = await setup();
    await expect(tools.createDraft({ packageKey: "map-1", family: "map", schemaVersion: "1" })).rejects.toMatchObject({
      code: "approval-pending",
    });
  });

  it("holds repeated edits without duplicate proposals and reloads an authorized completed draft", async () => {
    const { controller, orchestrator, calls } = await setup();
    const before = controller.state;
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await orchestrator.handleToolCall(intent)).toMatchObject({ ok: false, code: "approval-pending" });
    }
    expect(controller.state).toBe(before);
    expect(orchestrator.draftId).toBeUndefined();
    expect(calls).toEqual(["honua_studio_create_draft"]);
    const pending = orchestrator.pendingApproval;
    await expect(orchestrator.resumeLiveDraft("missing")).rejects.toThrow();
    expect(orchestrator.pendingApproval).toBe(pending);
    const approved = parseStudioDraftResult(
      server.resolveDraftOperation(pending!.proposalId, "approve") as Parameters<typeof parseStudioDraftResult>[0],
    );
    await orchestrator.resumeLiveDraft(approved.draftId);
    expect(calls.at(-1)).toBe("honua_studio_get_draft");
    expect(orchestrator.pendingApproval).toBeUndefined();
    expect(orchestrator.draftId).toBe(approved.draftId);
    expect(controller.state.layers).toEqual([]);
    expect(calls.filter((name) => name === "honua_studio_create_draft")).toHaveLength(1);
  });

  it("holds eager draft setup and never duplicates its proposal", async () => {
    const { orchestrator, calls } = await setup();
    await expect(orchestrator.ensureLiveDraft()).rejects.toMatchObject({ code: "approval-pending" });
    await expect(orchestrator.ensureLiveDraft()).rejects.toMatchObject({ code: "approval-pending" });
    expect(calls).toEqual(["honua_studio_create_draft"]);
  });

  it("keeps an existing draft held until a newer server generation is available", async () => {
    const { orchestrator, controller, calls } = await setup(["honua_studio_add_layer"]);
    const binding = await orchestrator.ensureLiveDraft();
    const before = controller.state;
    expect(await orchestrator.handleToolCall(intent)).toMatchObject({ ok: false, code: "approval-pending" });
    await expect(orchestrator.resumeLiveDraft(binding.draftId)).rejects.toThrow("has not completed");
    expect(controller.state).toBe(before);
    server.resolveDraftOperation(orchestrator.pendingApproval!.proposalId, "approve");
    await orchestrator.resumeLiveDraft(binding.draftId);
    expect(orchestrator.pendingApproval).toBeUndefined();
    expect(controller.state.layers.map((layer) => layer.sourceId)).toEqual(["hi-parcels"]);
    expect(calls.filter((name) => name === "honua_studio_add_layer")).toHaveLength(1);
  });

  it("holds the server's approval refusal for an edit and never repeats the edit", async () => {
    const { orchestrator, controller, calls } = await setup(["honua_studio_add_layer"]);
    await orchestrator.ensureLiveDraft();
    const before = controller.state;
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await orchestrator.handleToolCall(intent)).toMatchObject({ ok: false, code: "approval-pending" });
    }
    expect(orchestrator.pendingApproval).toMatchObject({
      status: "awaiting-approval",
      proposalId: expect.any(String),
      operationInstanceId: expect.any(String),
    });
    expect(controller.state).toBe(before);
    expect(calls.filter((name) => name === "honua_studio_add_layer")).toHaveLength(1);
  });

  it("keeps the original refusal when the held proposal cannot be read", async () => {
    server = await startMockServer({ approvalTools: ["honua_studio_add_layer"] });
    const client = new McpClient({
      baseUrl: server.url,
      auth: { getAccessToken: async () => mintFixtureAccessToken() },
      fetchImpl: async (input, init) =>
        JSON.parse(String(init?.body)).method === "resources/read"
          ? new Response("unavailable", { status: 503 })
          : fetch(input, init),
    });
    const orchestrator = new ToolCallOrchestrator({
      controller: new CompositionController(createEmptyCompositionState()),
      live: { client, packageKey: "map-1" },
    });
    await orchestrator.ensureLiveDraft();
    expect(await orchestrator.handleToolCall(intent)).toMatchObject({ ok: false, code: "server-error" });
    expect(orchestrator.pendingApproval).toBeUndefined();
  });

  it("discards a rejected live approval and reloads the unchanged draft before the next edit", async () => {
    const { orchestrator, calls } = await setup(["honua_studio_add_layer"]);
    const binding = await orchestrator.ensureLiveDraft();
    await orchestrator.handleToolCall(intent);
    server.resolveDraftOperation(orchestrator.pendingApproval!.proposalId, "reject");
    orchestrator.discardApprovalHold();
    expect(orchestrator.pendingApproval).toBeUndefined();
    await orchestrator.resumeLiveDraft(binding.draftId);
    expect(orchestrator.generation).toBe(binding.generation);
    expect(await orchestrator.handleToolCall(intent)).toMatchObject({ ok: false, code: "approval-pending" });
    expect(calls.filter((name) => name === "honua_studio_add_layer")).toHaveLength(2);
  });

  it("rejects a queued reload before it reads through a replacement session", async () => {
    const { orchestrator, client, calls } = await setup();
    const reload = orchestrator.resumeLiveDraft("missing");
    orchestrator.attachLiveSession({ client, packageKey: "map-2" });
    await expect(reload).rejects.toThrow("session changed");
    expect(calls).toEqual([]);
    expect(orchestrator.draftId).toBeUndefined();
  });

  it.each(["reload", "pending edit"])("does not transfer an in-flight %s to a replacement session", async (mode) => {
    server = await startMockServer({ approvalTools: ["honua_studio_create_draft"] });
    let reached!: () => void;
    let release!: () => void;
    const observed = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new McpClient({
      baseUrl: server.url,
      auth: { getAccessToken: async () => mintFixtureAccessToken() },
      fetchImpl: async (input, init) => {
        const response = await fetch(input, init);
        if (JSON.parse(String(init?.body)).method === "tools/call") {
          reached();
          await resumed;
        }
        return response;
      },
    });
    const controller = new CompositionController(createEmptyCompositionState());
    const before = controller.state;
    const orchestrator = new ToolCallOrchestrator({ controller, live: { client, packageKey: "map-1" } });
    const request = mode === "reload" ? orchestrator.resumeLiveDraft("missing") : orchestrator.handleToolCall(intent);
    await observed;
    orchestrator.detachLiveSession();
    release();
    if (mode === "reload") await expect(request).rejects.toThrow();
    else expect(await request).toMatchObject({ ok: false, code: "server-error" });
    expect(controller.state).toBe(before);
    expect(orchestrator.pendingApproval).toBeUndefined();
    expect(orchestrator.draftId).toBeUndefined();
  });
});
