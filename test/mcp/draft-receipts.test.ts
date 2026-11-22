import { describe, expect, it, vi } from "vitest";
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

  it("uses receipt parsing in typed create calls too", async () => {
    const client = new McpClient({ fetchImpl: vi.fn() });
    vi.spyOn(client, "callTool").mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(receipt) }] });
    await expect(
      new StudioMcpToolClient(client).createDraft({ packageKey: "map-1", family: "map", schemaVersion: "1" }),
    ).rejects.toMatchObject({ code: "approval-pending" });
  });

  it("holds repeated edits without duplicate proposals and reloads an authorized completed draft", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const before = controller.state;
    const client = new McpClient({ fetchImpl: vi.fn() });
    const call = vi.spyOn(client, "callTool").mockResolvedValue({ structuredContent: receipt });
    const orchestrator = new ToolCallOrchestrator({ controller, live: { client, packageKey: "map-1" } });
    const intent = { toolName: "add_layer", arguments: { datasetId: "roads" } };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await orchestrator.handleToolCall(intent)).toMatchObject({
        ok: false,
        code: "approval-pending",
        pending: { proposalId: "proposal-1" },
      });
    }
    expect(controller.state).toBe(before);
    expect(orchestrator.draftId).toBeUndefined();
    expect(call).toHaveBeenCalledTimes(1);
    call.mockRejectedValueOnce(new Error("not found"));
    await expect(orchestrator.resumeLiveDraft("draft-1")).rejects.toThrow("not found");
    expect(orchestrator.pendingApproval?.proposalId).toBe("proposal-1");
    call.mockResolvedValueOnce({ structuredContent: draft });
    await orchestrator.resumeLiveDraft("draft-1");
    expect(call).toHaveBeenLastCalledWith("honua_studio_get_draft", { draftId: "draft-1" });
    expect(orchestrator.pendingApproval).toBeUndefined();
    expect(orchestrator.draftId).toBe("draft-1");
    expect(controller.state.layers).toEqual([]);
  });
  it("holds eager draft setup and never duplicates its proposal", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const client = new McpClient({ fetchImpl: vi.fn() });
    const call = vi.spyOn(client, "callTool").mockResolvedValue({ structuredContent: receipt });
    const orchestrator = new ToolCallOrchestrator({ controller, live: { client, packageKey: "map-1" } });
    await expect(orchestrator.ensureLiveDraft()).rejects.toMatchObject({ code: "approval-pending" });
    await expect(orchestrator.ensureLiveDraft()).rejects.toMatchObject({ code: "approval-pending" });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing draft held until a newer server generation is available", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const before = controller.state;
    const client = new McpClient({ fetchImpl: vi.fn() });
    const call = vi.spyOn(client, "callTool").mockResolvedValue({ structuredContent: receipt });
    const orchestrator = new ToolCallOrchestrator({
      controller,
      live: { client, packageKey: "map-1", draftId: "draft-1", generation: 1 },
    });
    expect(
      await orchestrator.handleToolCall({ toolName: "add_layer", arguments: { datasetId: "roads" } }),
    ).toMatchObject({ ok: false, code: "approval-pending" });
    call.mockResolvedValue({ structuredContent: draft });
    await expect(orchestrator.resumeLiveDraft("draft-1")).rejects.toThrow("has not completed");
    expect(controller.state).toBe(before);
    expect(orchestrator.pendingApproval).toBeDefined();
    call.mockResolvedValue({
      structuredContent: {
        ...draft,
        generation: 2,
        envelope: { ...draft.envelope, body: { ...draft.envelope.body, layers: [{ id: "roads", sourceId: "roads" }] } },
      },
    });
    await orchestrator.resumeLiveDraft("draft-1");
    expect(orchestrator.pendingApproval).toBeUndefined();
    expect(controller.state.layers.map((layer) => layer.id)).toEqual(["roads"]);
    expect(call.mock.calls.map(([name]) => name)).toEqual([
      "honua_studio_add_layer",
      "honua_studio_get_draft",
      "honua_studio_get_draft",
    ]);
  });

  it("does not install a reloaded draft into a replaced session", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const before = controller.state;
    const client = new McpClient({ fetchImpl: vi.fn() });
    let complete!: (value: { structuredContent: typeof draft }) => void;
    vi.spyOn(client, "callTool").mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const orchestrator = new ToolCallOrchestrator({ controller, live: { client, packageKey: "map-1" } });
    const reload = orchestrator.resumeLiveDraft("draft-1");
    await Promise.resolve();
    orchestrator.detachLiveSession();
    complete({ structuredContent: draft });
    await expect(reload).rejects.toThrow("session changed");
    expect(controller.state).toBe(before);
    expect(orchestrator.draftId).toBeUndefined();
  });
  it("does not transfer an old session's pending approval to a replacement", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const client = new McpClient({ fetchImpl: vi.fn() });
    let complete!: (value: { structuredContent: typeof receipt }) => void;
    vi.spyOn(client, "callTool").mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const orchestrator = new ToolCallOrchestrator({ controller, live: { client, packageKey: "map-1" } });
    const edit = orchestrator.handleToolCall({ toolName: "add_layer", arguments: { datasetId: "roads" } });
    await Promise.resolve();
    await Promise.resolve();
    orchestrator.detachLiveSession();
    complete({ structuredContent: receipt });
    expect(await edit).toMatchObject({ ok: false, code: "server-error" });
    expect(orchestrator.pendingApproval).toBeUndefined();
  });
});
