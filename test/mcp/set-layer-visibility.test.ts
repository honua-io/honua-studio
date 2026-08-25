/**
 * honua-studio#31 — the TOC visibility toggle delegates to
 * `honua_studio_set_layer_visibility` instead of holding local state.
 *
 * Driven against the REAL `mock-server.mjs` `/mcp` dispatcher over the REAL
 * `McpClient`, the same way `external-client-parity.test.ts` is, because the
 * bug this closes is not one a stubbed tool plane can reproduce: `visible`
 * **is** part of the server's `StudioCompositionLayer` wire shape, so a
 * client-local toggle was silently reverted by the next draft read. Only a
 * real store can show the difference between "the client believes it is
 * hidden" and "it is hidden".
 */
import { afterEach, describe, expect, it } from "vitest";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { createActivityLog } from "../../src/chat/activity-log.js";
import { CompositionController } from "../../src/composition/controller.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import { McpClient } from "../../src/mcp/client.js";
import { ToolCallOrchestrator } from "../../src/mcp/orchestrator.js";
import { StudioMcpToolClient } from "../../src/mcp/studio-tools.js";
import { applyStudioDraft } from "../../src/mcp/tool-bridge.js";

let server: Awaited<ReturnType<typeof startMockServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function auth() {
  const token = mintFixtureAccessToken();
  return { getAccessToken: async () => token };
}

async function liveSession() {
  const controller = new CompositionController(createEmptyCompositionState());
  const activityLog = createActivityLog();
  const client = new McpClient({ baseUrl: server?.url, auth: auth() });
  const orchestrator = new ToolCallOrchestrator({
    controller,
    activityLog,
    live: { client, packageKey: "pkg-visibility", family: "map", schemaVersion: "1" },
  });
  await orchestrator.handleToolCall({
    toolName: "addLayer",
    arguments: { layer: { id: "parcels", sourceId: "src-parcels" } },
  });
  return { controller, activityLog, orchestrator };
}

describe("honua_studio_set_layer_visibility delegation (honua-studio#31)", () => {
  it("a visibility toggle advances the server draft, and the client re-reads the returned generation", async () => {
    server = await startMockServer();
    const { controller, orchestrator } = await liveSession();
    const generationBefore = orchestrator.generation as number;

    const result = await orchestrator.handleToolCall({
      toolName: "setVisibility",
      arguments: { target: { kind: "layer", id: "parcels" }, visible: false },
    });

    expect(result).toMatchObject({ ok: true, mode: "server" });
    expect(orchestrator.generation).toBe(generationBefore + 1);
    expect(controller.state.layers).toEqual([{ id: "parcels", sourceId: "src-parcels", visible: false }]);
  });

  it("the toggle survives a draft sync — the whole point of delegating it", async () => {
    server = await startMockServer();
    const { controller, orchestrator } = await liveSession();
    await orchestrator.handleToolCall({
      toolName: "setVisibility",
      arguments: { target: { kind: "layer", id: "parcels" }, visible: false },
    });

    // An unrelated composition mutation, then a fresh read of the draft —
    // the sequence that used to clobber a client-side toggle.
    await orchestrator.handleToolCall({ toolName: "setView", arguments: { view: { zoom: 9 } } });
    const tools = new StudioMcpToolClient(new McpClient({ baseUrl: server.url, auth: auth() }));
    const stored = await tools.getDraft(orchestrator.draftId as string);

    expect(stored.envelope.body).toMatchObject({ layers: [{ id: "parcels", visible: false }] });
    // …and a client that projects that draft onto its own state agrees.
    expect(applyStudioDraft(stored, controller.state).layers[0]?.visible).toBe(false);
    expect(controller.state.layers[0]?.visible).toBe(false);
  });

  it("a stale generation comes back failed_precondition and is recovered by one reload + retry", async () => {
    server = await startMockServer();
    const { controller, orchestrator } = await liveSession();

    // A second client writes the same draft, so the orchestrator's cached
    // generation goes stale — exactly what a concurrent editor produces.
    const otherTools = new StudioMcpToolClient(new McpClient({ baseUrl: server.url, auth: auth() }));
    const draftId = orchestrator.draftId as string;
    const current = await otherTools.getDraft(draftId);
    await otherTools.addLayer({
      draftId,
      generation: current.generation,
      layer: { id: "roads", sourceId: "src-roads" },
    });

    const result = await orchestrator.handleToolCall({
      toolName: "setVisibility",
      arguments: { target: { kind: "layer", id: "parcels" }, visible: false },
    });

    expect(result.ok).toBe(true);
    // The retry ran against the reloaded generation, so both the concurrent
    // layer and this toggle are in the draft — neither clobbered the other.
    expect(controller.state.layers.map((layer) => [layer.id, layer.visible])).toEqual([
      ["parcels", false],
      ["roads", true],
    ]);
  });

  it("an unknown layer id comes back not_found rather than a silent no-op", async () => {
    server = await startMockServer();
    const { orchestrator } = await liveSession();
    const tools = new StudioMcpToolClient(new McpClient({ baseUrl: server.url, auth: auth() }));
    const draftId = orchestrator.draftId as string;
    const stored = await tools.getDraft(draftId);

    const error = await tools
      .setLayerVisibility({ draftId, generation: stored.generation, layerId: "nope", visible: false })
      .catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: "not_found" });
  });

  it("logs the toggle on the shared activity log like any other composition command", async () => {
    server = await startMockServer();
    const { activityLog, orchestrator } = await liveSession();
    await orchestrator.handleToolCall({
      toolName: "setVisibility",
      arguments: { target: { kind: "layer", id: "parcels" }, visible: false },
    });

    expect(activityLog.entries().map((entry) => entry.type)).toEqual([
      "composition_command_applied",
      "composition_command_applied",
    ]);
  });

  it("still applies through the reducer in fixture mode — no live session, no server call", async () => {
    const controller = new CompositionController(createEmptyCompositionState());
    controller.apply({ name: "addLayer", layer: { id: "parcels", sourceId: "src-parcels" } });
    const orchestrator = new ToolCallOrchestrator({ controller });

    const result = await orchestrator.handleToolCall({
      toolName: "setVisibility",
      arguments: { target: { kind: "layer", id: "parcels" }, visible: false },
    });

    expect(result).toMatchObject({ ok: true, mode: "local" });
    expect(controller.state.layers[0]?.visible).toBe(false);
  });
});
