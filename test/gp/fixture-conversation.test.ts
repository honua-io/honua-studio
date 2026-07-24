/**
 * The full scripted GP journey (honua-studio#10 NFR-001):
 * author -> validate -> preview -> confirm -> execute -> complete ->
 * add-output-layer, driven against the REAL `mock-server.mjs` end to end.
 *
 * Deterministic, no timers: every step is `await`ed in order, no
 * `setTimeout`/polling loop anywhere in this file — status polling is two
 * explicit, caller-driven calls (mirrors `GpJobClient.status()`'s own "no
 * internal timers" contract).
 *
 * The agent half (author -> validate -> preview) runs through
 * `GpAuthoringSession` over the REAL MCP client — the exact path a chat
 * tool-call intent takes. The human half (confirm -> execute -> complete ->
 * add-output-layer) deliberately does NOT go through the agent path at all
 * — it drives `GpJobClient` and the composition `addLayer` command directly,
 * the same way `<honua-studio-gp-panel>`'s confirm dialog and "Add to
 * composition" button do — see `test/gp/human-gate.test.ts` for the proof
 * that these two halves are structurally separate.
 */
import { afterEach, describe, expect, it } from "vitest";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { CompositionController } from "../../src/composition/controller.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import { BUFFER_INTERSECT_PACKAGE_KEY, runGpFixtureAuthoring } from "../../src/gp/fixtures/index.js";
import { GpAuthoringSession } from "../../src/gp/gp-authoring-session.js";
import { StudioGpJobClient } from "../../src/gp/job-client.js";
import { McpClient } from "../../src/mcp/client.js";
import { ToolCallOrchestrator } from "../../src/mcp/orchestrator.js";
import { StudioMcpToolClient } from "../../src/mcp/studio-tools.js";

let server: Awaited<ReturnType<typeof startMockServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("GP fixture journey: author -> validate -> preview -> confirm -> execute -> complete -> add-output-layer (NFR-001)", () => {
  it("runs the full scripted journey deterministically against the real mock server", async () => {
    server = await startMockServer();
    const token = mintFixtureAccessToken();
    const auth = { getAccessToken: async () => token };

    // ---- AGENT HALF: author -> validate -> preview -------------------------
    const mcpClient = new McpClient({ baseUrl: server.url, auth });
    const tools = new StudioMcpToolClient(mcpClient);
    const session = new GpAuthoringSession({ tools, packageKey: BUFFER_INTERSECT_PACKAGE_KEY });

    const authored = await runGpFixtureAuthoring(session);
    expect(authored.draft.envelope.family).toBe("gp");
    expect(authored.draft.envelope.body).toMatchObject({
      inputs: expect.arrayContaining([expect.objectContaining({ id: "flood-zones" })]),
      parameters: expect.arrayContaining([expect.objectContaining({ id: "buffer-distance-m", value: 500 })]),
      outputs: expect.arrayContaining([expect.objectContaining({ id: "affected-parcels" })]),
    });
    expect(authored.validation).toBeDefined();
    // REQ-002: the preview plan is job-backed for the gp family.
    expect(authored.preview).toMatchObject({ requiresJob: true });

    // ---- HUMAN HALF: confirm -> execute -----------------------------------
    // "Confirm" = the human has seen the requiresJob preview plan above and
    // types the package key into the panel's confirm dialog — modeled here
    // as simply proceeding to submit, since the dialog discipline itself is
    // proven by test/elements/studio-gp-panel-element.test.ts and
    // test/gp/human-gate.test.ts; this test's job is the end-to-end DATA
    // flow, not the dialog's DOM mechanics.
    const jobs = new StudioGpJobClient({ baseUrl: server.url, auth });
    const submitted = await jobs.submit({ draftId: authored.draft.draftId });
    expect(submitted.status).toBe("accepted");

    // ---- Monitor: two caller-driven status polls, no timer -----------------
    const running = await jobs.status(submitted.jobId);
    expect(running.status).toBe("running");
    const completed = await jobs.status(submitted.jobId);
    expect(completed.status).toBe("successful");
    const [output] = completed.result?.outputs ?? [];
    expect(output?.outputId).toBe("affected-parcels");
    expect(output?.datasetId).toBeTruthy();

    // ---- REQ-004: the output registered as a catalog dataset --------------
    const catalogResponse = await fetch(`${server.url}/v1/studio/catalog`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const catalog = await catalogResponse.json();
    expect(catalog.datasets.map((dataset: { id: string }) => dataset.id)).toContain(output?.datasetId);

    // ---- add-output-layer: the SAME composition path a chat tool-call intent uses ----
    const controller = new CompositionController(createEmptyCompositionState());
    const orchestrator = new ToolCallOrchestrator({
      controller,
      live: { client: mcpClient, packageKey: "gp-journey-map", family: "map", schemaVersion: "1" },
    });
    const result = await orchestrator.handleToolCall({
      toolName: "addLayer",
      arguments: { layer: { id: output?.datasetId, sourceId: output?.datasetId, title: output?.title } },
    });
    expect(result.ok).toBe(true);
    expect(controller.state.layers.map((layer) => layer.id)).toEqual([output?.datasetId]);
    if (result.ok) {
      expect(result.mode).toBe("server");
      expect(result.draft?.envelope.family).toBe("map");
    }
  });
});
