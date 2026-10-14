import { describe, expect, it } from "vitest";
import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { CompositionController } from "../../src/composition/controller.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import { McpClient } from "../../src/mcp/client.js";
import { ToolCallOrchestrator } from "../../src/mcp/orchestrator.js";
import { StudioMcpToolClient } from "../../src/mcp/studio-tools.js";
import { applyStudioDraft } from "../../src/mcp/tool-bridge.js";

describe("authoritative history synchronization", () => {
  it("coalesces initial and repeated server snapshots without creating phantom undo or clearing redo", async () => {
    const server = await startMockServer();
    try {
      const client = new McpClient({
        baseUrl: server.url,
        auth: { getAccessToken: async () => mintFixtureAccessToken() },
      });
      const controller = new CompositionController(createEmptyCompositionState());
      const orchestrator = new ToolCallOrchestrator({ controller, live: { client, packageKey: "no-phantom-history" } });
      const binding = await orchestrator.ensureLiveDraft();
      expect(controller.canUndo()).toBe(false);
      expect(await orchestrator.applyHistoryAction("undo")).toBe(false);
      await orchestrator.handleToolCall({
        toolName: "addWidget",
        arguments: { widget: { id: "chart", kind: "chart" } },
      });
      const tools = new StudioMcpToolClient(client);
      orchestrator.acceptServerDraft(await tools.getDraft(binding.draftId));
      expect(await orchestrator.applyHistoryAction("undo")).toBe(true);
      expect(controller.state.widgets).toHaveLength(0);
      expect(controller.canUndo()).toBe(false);
      expect(await orchestrator.applyHistoryAction("undo")).toBe(false);
      orchestrator.acceptServerDraft(await tools.getDraft(binding.draftId));
      expect(controller.canRedo()).toBe(true);
      expect(await orchestrator.applyHistoryAction("redo")).toBe(true);
      expect(applyStudioDraft(await tools.getDraft(binding.draftId)).widgets.map((widget) => widget.id)).toEqual([
        "chart",
      ]);
    } finally {
      await server.close();
    }
  });

  for (const mode of ["roundtrip", "external-edit", "session-replaced"] as const) {
    it(mode, async () => {
      const server = await startMockServer();
      try {
        let pause = false;
        let observed: (() => void) | undefined;
        let resume: (() => void) | undefined;
        const reached = new Promise<void>((resolve) => {
          observed = resolve;
        });
        const resumed = new Promise<void>((resolve) => {
          resume = resolve;
        });
        let inverseCalls = 0;
        const client = new McpClient({
          baseUrl: server.url,
          auth: { getAccessToken: async () => mintFixtureAccessToken() },
          fetchImpl: async (input, init) => {
            const request = JSON.parse(String(init?.body));
            if (request.params?.name === "honua_studio_remove_widget") inverseCalls += 1;
            const response = await fetch(input, init);
            if (pause && request.params?.name === "honua_studio_get_draft") {
              pause = false;
              observed?.();
              await resumed;
            }
            return response;
          },
        });
        const tools = new StudioMcpToolClient(client);
        const draft = await tools.createDraft({
          packageKey: mode,
          family: "map",
          schemaVersion: "1.0",
          body: { layers: [], widgets: [], view: {} },
        });
        const controller = new CompositionController(applyStudioDraft(draft));
        const orchestrator = new ToolCallOrchestrator({
          controller,
          live: { client, packageKey: mode, draftId: draft.draftId, generation: draft.generation },
        });
        await orchestrator.handleToolCall({
          toolName: "addWidget",
          arguments: { widget: { id: "chart", kind: "chart" } },
        });
        if (mode === "external-edit") {
          const current = await tools.getDraft(draft.draftId);
          await client.callTool("honua_studio_add_widget", {
            draftId: draft.draftId,
            generation: current.generation,
            widget: { id: "external", kind: "toc" },
          });
        }
        pause = mode === "session-replaced";
        const undo = orchestrator.applyHistoryAction("undo");
        if (mode === "session-replaced") {
          await reached;
          orchestrator.attachLiveSession({ client, packageKey: "replacement", draftId: "replacement", generation: 1 });
          controller.replaceState(createEmptyCompositionState());
          resume?.();
        }
        expect(await undo).toBe(mode === "roundtrip");
        expect(inverseCalls).toBe(mode === "roundtrip" ? 1 : 0);
        if (mode === "roundtrip") {
          expect(applyStudioDraft(await tools.getDraft(draft.draftId)).widgets).toHaveLength(0);
          expect(await orchestrator.applyHistoryAction("redo")).toBe(true);
          expect(applyStudioDraft(await tools.getDraft(draft.draftId)).widgets.map((entry) => entry.id)).toEqual([
            "chart",
          ]);
        } else {
          expect(
            applyStudioDraft(await tools.getDraft(draft.draftId)).widgets.some((entry) => entry.id === "chart"),
          ).toBe(true);
        }
      } finally {
        await server.close();
      }
    });
  }
});
