import {
  InMemoryStudioAiReplayStore,
  type StudioAiChatEvent,
  type StudioAiChatRequest,
  StudioAiTranscriptVerifier,
} from "@honua/sdk-js/studio-agent";
import { describe, expect, it, vi } from "vitest";
import { createFixtureTranscriptSigner } from "../../scripts/lib/fixture-transcript-signer.mjs";
import { VerifiedRoundTransport } from "../../src/evals/verified-round-transport.js";

const request: StudioAiChatRequest = {
  provider: "fixture",
  messages: [{ role: "user", content: "Publish this map." }],
  certification: {
    candidateId: "fixture",
    releaseId: "fixture",
    endpointIdentity: "http://localhost",
    actionId: "human-gate",
    runNonce: "fixture-nonce",
  },
};

async function collect(transport: VerifiedRoundTransport) {
  const events: StudioAiChatEvent[] = [];
  for await (const event of transport.streamChat(request, new AbortController().signal)) events.push(event);
  return events;
}

describe("diagnostic terminal text verification", () => {
  for (const mode of [
    "valid",
    "tampered",
    "unsigned",
    "truncated",
    "incomplete-tool",
    "orphan-stop",
    "duplicate-stop",
    "events-after-stop",
    "max-tokens",
    "missing-start",
    "stop-only",
    "late-start",
    "duplicate-start",
    "empty-text",
  ] as const) {
    it(mode, async () => {
      const signer = createFixtureTranscriptSigner();
      const events: StudioAiChatEvent[] = [
        { type: "messageStart", model: "fixture" },
        { type: "textDelta", text: "Publication needs human confirmation." },
        { type: "messageStop", stopReason: "endTurn" },
      ];
      if (mode === "truncated") events.pop();
      if (mode === "max-tokens") events[2] = { type: "messageStop", stopReason: "maxTokens" };
      if (mode === "incomplete-tool")
        events.splice(1, 0, { type: "toolCallStart", toolCallId: "call", toolName: "honua_studio_add_layer" });
      if (mode === "orphan-stop")
        events.splice(1, 0, {
          type: "toolCallStop",
          toolCallId: "call",
          toolName: "honua_studio_add_layer",
          toolArguments: {},
        });
      if (mode === "duplicate-stop") events.push({ type: "messageStop", stopReason: "endTurn" });
      if (mode === "events-after-stop")
        events.push({ type: "textDelta", text: "More text after the terminal marker." });
      if (mode === "missing-start") events.shift();
      if (mode === "stop-only") events.splice(0, 2);
      if (mode === "late-start") events.reverse();
      if (mode === "duplicate-start") events.splice(1, 0, { type: "messageStart", model: "fixture" });
      if (mode === "empty-text") events[1] = { type: "textDelta", text: " " };
      const envelope = signer.sign(request, events);
      if (mode === "tampered") events[1] = { type: "textDelta", text: "Published without approval." };
      const transport = new VerifiedRoundTransport(
        {
          async *streamChat() {
            yield* events;
            if (mode !== "unsigned") yield envelope;
          },
        },
        new StudioAiTranscriptVerifier({ manifest: signer.manifest, replayStore: new InMemoryStudioAiReplayStore() }),
      );
      if (mode === "valid") expect(await collect(transport)).toEqual([...events, envelope]);
      else await expect(collect(transport)).rejects.toThrow();
    });
  }

  it("rejects replay of the exact previously verified text request and transcript", async () => {
    const signer = createFixtureTranscriptSigner();
    const events: StudioAiChatEvent[] = [
      { type: "messageStart", model: "fixture" },
      { type: "textDelta", text: "Needs approval." },
      { type: "messageStop", stopReason: "endTurn" },
    ];
    const envelope = signer.sign(request, events);
    const transport = new VerifiedRoundTransport(
      {
        async *streamChat() {
          yield* events;
          yield envelope;
        },
      },
      new StudioAiTranscriptVerifier({ manifest: signer.manifest, replayStore: new InMemoryStudioAiReplayStore() }),
    );
    await collect(transport);
    await expect(collect(transport)).rejects.toThrow(/replay/i);
  });

  it("leaves tool-round nonce consumption to the SDK verifier", async () => {
    const signer = createFixtureTranscriptSigner();
    const events: StudioAiChatEvent[] = [
      { type: "messageStart", model: "fixture" },
      { type: "toolCallStart", toolCallId: "call", toolName: "honua_studio_add_layer" },
      {
        type: "toolCallStop",
        toolCallId: "call",
        toolName: "honua_studio_add_layer",
        toolArguments: { layer: { id: "parcels" } },
      },
      { type: "messageStop", stopReason: "toolCall" },
    ];
    const envelope = signer.sign(request, events);
    const verifier = new StudioAiTranscriptVerifier({
      manifest: signer.manifest,
      replayStore: new InMemoryStudioAiReplayStore(),
    });
    const verify = vi.spyOn(verifier, "verify");
    const transport = new VerifiedRoundTransport(
      {
        async *streamChat() {
          yield* events;
          yield envelope;
        },
      },
      verifier,
    );
    await collect(transport);
    expect(verify).not.toHaveBeenCalled();
    expect((await verifier.verify(envelope.provenance, request, events)).ok).toBe(true);
    expect((await verifier.verify(envelope.provenance, request, events)).ok).toBe(false);
  });
});
