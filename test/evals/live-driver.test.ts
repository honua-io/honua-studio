import {
  InMemoryStudioAiReplayStore,
  type StudioAiChatEvent,
  StudioAiTranscriptVerifier,
} from "@honua/sdk-js/studio-agent";
import { describe, expect, it } from "vitest";
import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { createFixtureTranscriptSigner } from "../../scripts/lib/fixture-transcript-signer.mjs";
import { LiveTurnDriver } from "../../src/evals/live-driver.js";
import { runEvalTask } from "../../src/evals/runner.js";
import { scoreEvalRun } from "../../src/evals/scorer.js";
import type { EvalTask } from "../../src/evals/types.js";
import { McpClient } from "../../src/mcp/client.js";
import { StudioMcpToolClient } from "../../src/mcp/studio-tools.js";

const task: EvalTask = {
  id: "verified-layer",
  title: "Add a layer",
  capabilities: ["layer"],
  turns: [{ kind: "instruction", instruction: "Add the parcels layer." }],
  expected: { state: { layers: { ids: ["hi-parcels"] } } },
  knownBad: [],
};

describe("live driver dispatch boundary", () => {
  for (const scenario of ["valid", "tampered-mutation", "owned-read", "tampered-read"]) {
    const tampered = scenario.startsWith("tampered");
    const readFirst = scenario.endsWith("read");
    it(`routes verified calls through the owned draft boundary: ${scenario}`, async () => {
      const server = await startMockServer();
      try {
        const auth = { getAccessToken: async () => mintFixtureAccessToken() };
        const client = new McpClient({ baseUrl: server.url, auth });
        const tools = new StudioMcpToolClient(client);
        const draft = await tools.createDraft({
          packageKey: task.id,
          family: "map",
          schemaVersion: "1.0",
          body: { layers: [], widgets: [], view: {} },
        });
        const signer = createFixtureTranscriptSigner();
        let round = 0;
        const driver = new LiveTurnDriver({
          baseUrl: server.url,
          auth,
          draft,
          certification: {
            candidateId: "fixture",
            releaseId: "fixture",
            endpointIdentity: server.url,
            actionId: task.id,
            runNonce: crypto.randomUUID(),
          },
          transcriptVerifier: new StudioAiTranscriptVerifier({
            manifest: signer.manifest,
            replayStore: new InMemoryStudioAiReplayStore(),
          }),
          transport: {
            async *streamChat(request) {
              expect(JSON.stringify(request.system)).toContain(draft.draftId);
              const currentRound = round++;
              const events: StudioAiChatEvent[] =
                readFirst && currentRound === 0
                  ? [
                      { type: "toolCallStart", toolCallId: "read-call", toolName: "honua_studio_get_draft" },
                      {
                        type: "toolCallStop",
                        toolCallId: "read-call",
                        toolName: "honua_studio_get_draft",
                        toolArguments: { draftId: "must-not-read-another-draft" },
                      },
                      { type: "messageStop", stopReason: "toolCall" },
                    ]
                  : currentRound === (readFirst ? 1 : 0)
                    ? [
                        { type: "toolCallStart", toolCallId: "model-call", toolName: "honua_studio_add_layer" },
                        {
                          type: "toolCallStop",
                          toolCallId: "model-call",
                          toolName: "honua_studio_add_layer",
                          toolArguments: { layer: { id: "hi-parcels", sourceId: "hi-parcels" } },
                        },
                        { type: "messageStop", stopReason: "toolCall" },
                      ]
                    : [
                        { type: "textDelta", text: "Added." },
                        { type: "messageStop", stopReason: "endTurn" },
                      ];
              for (const event of events) yield event;
              const envelope = signer.sign(request, events);
              yield tampered ? { ...envelope, provenance: { ...envelope.provenance, signature: "AAAA" } } : envelope;
            },
          },
        });
        const run = await runEvalTask(task, {
          driver,
          live: { client, packageKey: task.id, draftId: draft.draftId, generation: draft.generation },
        });
        expect(scoreEvalRun(run).passed).toBe(!tampered);
        const stored = await tools.getDraft(draft.draftId);
        expect(run.toolCalls).toHaveLength(tampered ? 0 : 1);
        expect(stored.generation).toBe(draft.generation + (tampered ? 0 : 1));
        expect(driver.session.messages.filter((message) => message.role === "tool")).toHaveLength(
          tampered ? 0 : readFirst ? 2 : 1,
        );
      } finally {
        await server.close();
      }
    });
  }
});
