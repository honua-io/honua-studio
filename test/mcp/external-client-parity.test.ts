/**
 * External-client parity proof (honua-studio#7 build item 5; spec
 * acceptance REQ-003: "External MCP client parity: the same tools drive a
 * composition from outside the app").
 *
 * Drives `mock-server.mjs`'s real `/mcp` JSON-RPC endpoint two ways against
 * the SAME running server:
 *
 *  1. A "bare" external MCP client — `McpClient` + `StudioMcpToolClient`
 *     used directly, exactly as an out-of-process agent (Claude Desktop, a
 *     script) would: no `CompositionController`, no orchestrator, no
 *     browser — this file runs under plain Node/vitest.
 *  2. The in-app path — `ToolCallOrchestrator` wired to a
 *     `CompositionController`, driven by the SAME tool-call intents a chat
 *     console would emit (`addLayer`/`setView`), with a live session
 *     pointed at the identical mock server.
 *
 * Both drive create-draft, add-layer, set-view; the assertion is that the
 * resulting draft body (layers/view) is identical either way — proving the
 * server-side tool contract, not just this app's own reducer, is what
 * determines the outcome (AD-5: "External MCP clients ... get identical
 * semantics because they hit the same server-side tools").
 */
import { afterEach, describe, expect, it } from "vitest";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { createActivityLog } from "../../src/chat/activity-log.js";
import { CompositionController } from "../../src/composition/controller.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import { McpClient } from "../../src/mcp/client.js";
import { ToolCallOrchestrator } from "../../src/mcp/orchestrator.js";
import { StudioMcpToolClient } from "../../src/mcp/studio-tools.js";
import { toStudioCompositionBody } from "../../src/mcp/tool-bridge.js";

let server: Awaited<ReturnType<typeof startMockServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("mcp external-client parity (honua-studio#7 REQ-003)", () => {
  it("a bare external MCP client reproduces the same draft body the in-app orchestrator produces for the same commands", async () => {
    server = await startMockServer();
    const token = mintFixtureAccessToken();
    const auth = { getAccessToken: async () => token };

    // ---- 1. Bare external client: no app code beyond McpClient/StudioMcpToolClient ----
    const externalClient = new McpClient({ baseUrl: server.url, auth });
    const externalTools = new StudioMcpToolClient(externalClient);

    let draft = await externalTools.createDraft({ packageKey: "pkg-external", family: "map", schemaVersion: "1" });
    draft = await externalTools.addLayer({
      draftId: draft.draftId,
      generation: draft.generation,
      layer: { id: "roads", sourceId: "src-roads", title: "Roads", styleRef: "roads-style-v1" },
    });
    draft = await externalTools.setView({
      draftId: draft.draftId,
      generation: draft.generation,
      view: { center: [-157.86, 21.3], zoom: 9 },
    });

    // ---- 2. In-app path: ToolCallOrchestrator, driven by chat-shaped tool-call intents ----
    const controller = new CompositionController(createEmptyCompositionState());
    const activityLog = createActivityLog();
    const inAppClient = new McpClient({ baseUrl: server.url, auth });
    const orchestrator = new ToolCallOrchestrator({
      controller,
      activityLog,
      live: { client: inAppClient, packageKey: "pkg-in-app", family: "map", schemaVersion: "1" },
    });

    const addLayerResult = await orchestrator.handleToolCall({
      toolName: "addLayer",
      arguments: {
        layer: {
          id: "roads",
          sourceId: "src-roads",
          title: "Roads",
          styleRef: { kind: "style-ref", styleId: "roads-style-v1" },
        },
      },
    });
    const setViewResult = await orchestrator.handleToolCall({
      toolName: "setView",
      arguments: { view: { center: [-157.86, 21.3], zoom: 9 } },
    });

    expect(addLayerResult.ok).toBe(true);
    expect(setViewResult.ok).toBe(true);

    // ---- 3. Parity assertion: same layers/view body either way ----
    const externalBody = draft.envelope.body as { layers: unknown[]; view: unknown; widgets: unknown[] };
    const inAppBody = toStudioCompositionBody(controller.state);

    expect(inAppBody.layers).toEqual(externalBody.layers);
    expect(inAppBody.view).toEqual(externalBody.view);
    expect(inAppBody.widgets).toEqual(externalBody.widgets);

    // Both journeys actually mutated a real server-side draft, not just local state.
    expect(orchestrator.draftId).toBeDefined();
    expect(orchestrator.generation).toBeGreaterThan(1);
  });

  it("an external client hitting a generation conflict gets the same failed_precondition contract the in-app orchestrator recovers from", async () => {
    server = await startMockServer();
    const token = mintFixtureAccessToken();
    const auth = { getAccessToken: async () => token };
    const client = new McpClient({ baseUrl: server.url, auth });
    const tools = new StudioMcpToolClient(client);

    const draft = await tools.createDraft({ packageKey: "pkg-1", family: "map", schemaVersion: "1" });
    await tools.addLayer({
      draftId: draft.draftId,
      generation: draft.generation,
      layer: { id: "roads", sourceId: "s" },
    });

    // Replays the STALE generation — the same optimistic-concurrency
    // contract FixtureDraftStore documents (composition/history.ts).
    await expect(
      tools.addLayer({ draftId: draft.draftId, generation: draft.generation, layer: { id: "parks", sourceId: "s2" } }),
    ).rejects.toMatchObject({ code: "failed_precondition" });
  });
});
