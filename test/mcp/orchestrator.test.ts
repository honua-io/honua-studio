import { beforeEach, describe, expect, it, vi } from "vitest";

import { createActivityLog } from "../../src/chat/activity-log.js";
import { CompositionController } from "../../src/composition/controller.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import { McpClient } from "../../src/mcp/client.js";
import { ToolCallOrchestrator } from "../../src/mcp/orchestrator.js";

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("mcp/orchestrator ToolCallOrchestrator (fixture/local mode)", () => {
  it("applies a recognized composition-vocabulary tool call through the local reducer and logs success", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const log = createActivityLog({ clock: () => "t" });
    const orchestrator = new ToolCallOrchestrator({ controller, activityLog: log });

    const result = await orchestrator.handleToolCall({
      toolName: "addLayer",
      arguments: { layer: { id: "roads", sourceId: "s" } },
    });

    expect(result).toMatchObject({ ok: true, mode: "local" });
    expect(controller.state.layers).toHaveLength(1);
    expect(log.entries().map((e) => e.type)).toEqual(["composition_command_applied"]);
  });

  it("applies a chat-fixture-vocabulary tool call (add_layer/add_chart) the same way", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const orchestrator = new ToolCallOrchestrator({ controller });

    await orchestrator.handleToolCall({
      toolName: "add_layer",
      arguments: { datasetId: "hi-parcels", styleBy: "district" },
    });
    await orchestrator.handleToolCall({
      toolName: "add_chart",
      arguments: { datasetId: "hi-parcels", groupBy: "zoning_code", chartType: "bar" },
    });

    expect(controller.state.layers.map((l) => l.id)).toEqual(["hi-parcels"]);
    expect(controller.state.widgets.map((w) => w.id)).toEqual(["chart-hi-parcels-zoning_code"]);
  });

  it("an unknown tool is rejected with a typed, stated reason and never throws", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const log = createActivityLog();
    const orchestrator = new ToolCallOrchestrator({ controller, activityLog: log });

    const result = await orchestrator.handleToolCall({ toolName: "reticulate_splines", arguments: {} });

    expect(result).toEqual({
      ok: false,
      toolName: "reticulate_splines",
      code: "unknown-tool",
      reason: expect.stringContaining("reticulate_splines"),
    });
    expect(log.entries()[0]?.type).toBe("composition_command_rejected");
    expect(controller.state.layers).toHaveLength(0);
  });

  it("a reducer rejection (e.g. duplicate layer id) is surfaced as reducer-rejected, not thrown", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    controller.apply({ name: "addLayer", layer: { id: "roads", sourceId: "s" } });
    const orchestrator = new ToolCallOrchestrator({ controller });

    const result = await orchestrator.handleToolCall({
      toolName: "addLayer",
      arguments: { layer: { id: "roads", sourceId: "s2" } },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("reducer-rejected");
  });

  it("pin/unpin always apply locally even with a live session attached (no server counterpart)", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    controller.apply({ name: "addLayer", layer: { id: "roads", sourceId: "s" } });
    const client = new McpClient({ fetchImpl: vi.fn() as unknown as typeof fetch });
    const orchestrator = new ToolCallOrchestrator({
      controller,
      live: { client, packageKey: "pkg-1" },
    });

    const result = await orchestrator.handleToolCall({
      toolName: "pin",
      arguments: { target: { kind: "layer", id: "roads" } },
    });

    expect(result).toMatchObject({ ok: true, mode: "local" });
    expect(controller.state.pins).toEqual([{ kind: "layer", id: "roads" }]);
  });
});

describe("mcp/orchestrator ToolCallOrchestrator (live/authoritative mode)", () => {
  function fetchRouter(handlers: Record<string, (id: unknown, args: Record<string, unknown>) => unknown>) {
    return vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "initialize") {
        return jsonResponse(
          { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } },
          { "mcp-session-id": "s1" },
        );
      }
      if (body.method === "tools/call") {
        const handler = handlers[body.params.name];
        if (!handler) throw new Error(`no handler for tool ${body.params.name}`);
        const outcome = handler(body.id, body.params.arguments ?? {});
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: outcome });
      }
      throw new Error(`unexpected method ${body.method}`);
    });
  }

  let draftStore: { draftId: string; generation: number; body: Record<string, unknown> };

  beforeEach(() => {
    draftStore = { draftId: "draft-1", generation: 1, body: { layers: [], view: {}, widgets: [] } };
  });

  it("calls the granular honua_studio_* tool, then refreshes local state from the RETURNED draft", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const log = createActivityLog();
    const fetchImpl = fetchRouter({
      honua_studio_create_draft: () => ({
        structuredContent: {
          draftId: draftStore.draftId,
          packageKey: "pkg-1",
          generation: draftStore.generation,
          envelope: { family: "map", schemaVersion: "1", body: draftStore.body },
        },
      }),
      honua_studio_add_layer: (_id, args) => {
        draftStore.generation += 1;
        draftStore.body = {
          ...draftStore.body,
          layers: [
            {
              id: (args.layer as Record<string, unknown>).id,
              sourceId: (args.layer as Record<string, unknown>).sourceId,
            },
          ],
        };
        return {
          structuredContent: {
            draftId: draftStore.draftId,
            packageKey: "pkg-1",
            generation: draftStore.generation,
            envelope: { family: "map", schemaVersion: "1", body: draftStore.body },
          },
        };
      },
    });
    const client = new McpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const orchestrator = new ToolCallOrchestrator({
      controller,
      activityLog: log,
      live: { client, packageKey: "pkg-1" },
    });

    const result = await orchestrator.handleToolCall({
      toolName: "addLayer",
      arguments: { layer: { id: "roads", sourceId: "s" } },
    });

    expect(result).toMatchObject({ ok: true, mode: "server" });
    expect(controller.state.layers).toEqual([{ id: "roads", sourceId: "s", visible: true }]);
    expect(orchestrator.draftId).toBe("draft-1");
    expect(orchestrator.generation).toBe(2);
    expect(log.entries().map((e) => e.type)).toEqual(["composition_command_applied"]);
  });

  it("routes TOC visibility through honua_studio_set_layer_visibility and accepts the returned draft", async () => {
    const controller = new CompositionController({
      ...createEmptyCompositionState(),
      layers: [{ id: "roads", sourceId: "s", visible: true }],
    });
    draftStore.body = { layers: [{ id: "roads", sourceId: "s", visible: true }], view: {}, widgets: [] };
    const seen = vi.fn();
    const fetchImpl = fetchRouter({
      honua_studio_create_draft: () => ({
        structuredContent: {
          draftId: draftStore.draftId,
          packageKey: "pkg-1",
          generation: draftStore.generation,
          envelope: { family: "map", schemaVersion: "1", body: draftStore.body },
        },
      }),
      honua_studio_set_layer_visibility: (_id, args) => {
        seen(args);
        draftStore.generation += 1;
        draftStore.body = { ...draftStore.body, layers: [{ id: "roads", sourceId: "s", visible: false }] };
        return {
          structuredContent: {
            draftId: draftStore.draftId,
            packageKey: "pkg-1",
            generation: draftStore.generation,
            envelope: { family: "map", schemaVersion: "1", body: draftStore.body },
          },
        };
      },
    });
    const orchestrator = new ToolCallOrchestrator({
      controller,
      live: { client: new McpClient({ fetchImpl: fetchImpl as never }), packageKey: "pkg-1" },
    });

    const result = await orchestrator.handleToolCall({
      toolName: "setVisibility",
      arguments: { target: { kind: "layer", id: "roads" }, visible: false },
    });

    expect(result).toMatchObject({ ok: true, mode: "server" });
    expect(seen).toHaveBeenCalledWith({ draftId: "draft-1", generation: 1, layerId: "roads", visible: false });
    expect(controller.state.layers[0]?.visible).toBe(false);
  });

  it("a failed_precondition (stale generation) triggers exactly one reload + retry, then succeeds", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    let addLayerAttempts = 0;
    const fetchImpl = fetchRouter({
      honua_studio_create_draft: () => ({
        structuredContent: {
          draftId: draftStore.draftId,
          packageKey: "pkg-1",
          generation: draftStore.generation,
          envelope: { family: "map", schemaVersion: "1", body: draftStore.body },
        },
      }),
      honua_studio_add_layer: (_id, args) => {
        addLayerAttempts += 1;
        if (addLayerAttempts === 1) {
          // Simulate a concurrent external write bumping the generation before this call lands.
          draftStore.generation = 5;
          return {
            isError: true,
            structuredContent: { code: "failed_precondition", message: "Stale draft generation; refresh and retry." },
          };
        }
        expect(args.generation).toBe(5); // retried against the freshly-reloaded generation
        draftStore.generation += 1;
        draftStore.body = { ...draftStore.body, layers: [{ id: "roads", sourceId: "s" }] };
        return {
          structuredContent: {
            draftId: draftStore.draftId,
            packageKey: "pkg-1",
            generation: draftStore.generation,
            envelope: { family: "map", schemaVersion: "1", body: draftStore.body },
          },
        };
      },
      honua_studio_get_draft: () => ({
        structuredContent: {
          draftId: draftStore.draftId,
          packageKey: "pkg-1",
          generation: draftStore.generation,
          envelope: { family: "map", schemaVersion: "1", body: draftStore.body },
        },
      }),
    });
    const client = new McpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const orchestrator = new ToolCallOrchestrator({ controller, live: { client, packageKey: "pkg-1" } });

    const result = await orchestrator.handleToolCall({
      toolName: "addLayer",
      arguments: { layer: { id: "roads", sourceId: "s" } },
    });

    expect(result.ok).toBe(true);
    expect(addLayerAttempts).toBe(2);
    expect(orchestrator.generation).toBe(6);
    expect(controller.state.layers.map((l) => l.id)).toEqual(["roads"]);
  });

  it("a SECOND failed_precondition after the one retry is surfaced as a failure, not retried again", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    let addLayerAttempts = 0;
    const fetchImpl = fetchRouter({
      honua_studio_create_draft: () => ({
        structuredContent: {
          draftId: draftStore.draftId,
          packageKey: "pkg-1",
          generation: draftStore.generation,
          envelope: { family: "map", schemaVersion: "1", body: draftStore.body },
        },
      }),
      honua_studio_add_layer: () => {
        addLayerAttempts += 1;
        return { isError: true, structuredContent: { code: "failed_precondition", message: "still stale" } };
      },
      honua_studio_get_draft: () => ({
        structuredContent: {
          draftId: draftStore.draftId,
          packageKey: "pkg-1",
          generation: draftStore.generation,
          envelope: { family: "map", schemaVersion: "1", body: draftStore.body },
        },
      }),
    });
    const client = new McpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const orchestrator = new ToolCallOrchestrator({ controller, live: { client, packageKey: "pkg-1" } });

    const result = await orchestrator.handleToolCall({
      toolName: "addLayer",
      arguments: { layer: { id: "roads", sourceId: "s" } },
    });

    expect(result).toMatchObject({ ok: false, code: "server-error" });
    expect(addLayerAttempts).toBe(2); // one original + exactly one retry
  });

  it("server-bound calls are queued in order (no two in flight racing the same draft generation)", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    const seenGenerations: number[] = [];
    const fetchImpl = fetchRouter({
      honua_studio_create_draft: () => ({
        structuredContent: {
          draftId: draftStore.draftId,
          packageKey: "pkg-1",
          generation: draftStore.generation,
          envelope: { family: "map", schemaVersion: "1", body: draftStore.body },
        },
      }),
      honua_studio_add_layer: (_id, args) => {
        seenGenerations.push(args.generation as number);
        draftStore.generation += 1;
        const layers = (draftStore.body.layers as unknown[]) ?? [];
        draftStore.body = { ...draftStore.body, layers: [...layers, args.layer] };
        return {
          structuredContent: {
            draftId: draftStore.draftId,
            packageKey: "pkg-1",
            generation: draftStore.generation,
            envelope: { family: "map", schemaVersion: "1", body: draftStore.body },
          },
        };
      },
    });
    const client = new McpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const orchestrator = new ToolCallOrchestrator({ controller, live: { client, packageKey: "pkg-1" } });

    const [a, b] = await Promise.all([
      orchestrator.handleToolCall({ toolName: "addLayer", arguments: { layer: { id: "a", sourceId: "s" } } }),
      orchestrator.handleToolCall({ toolName: "addLayer", arguments: { layer: { id: "b", sourceId: "s" } } }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(seenGenerations).toEqual([1, 2]); // strictly sequential, never both at generation 1
    expect(controller.state.layers.map((l) => l.id)).toEqual(["a", "b"]);
  });
});
