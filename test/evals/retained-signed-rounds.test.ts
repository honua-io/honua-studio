import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  InMemoryStudioAiReplayStore,
  SseChatTransport,
  type StudioAiChatEvent,
  type StudioAiChatRequest,
  type StudioAiTranscriptSigningManifest,
  StudioAiTranscriptVerifier,
} from "@honua/sdk-js/studio-agent";
import { describe, expect, it } from "vitest";
import { VerifiedRoundTransport } from "../../src/evals/verified-round-transport.js";

interface RetainedRound {
  request: StudioAiChatRequest;
  manifest: StudioAiTranscriptSigningManifest;
  sse: string;
  sseSha256: string;
  historicalReplayOnly: true;
}

async function retained(kind: string) {
  const raw = await readFile(new URL(`../fixtures/signed-server-rounds/${kind}.json.raw`, import.meta.url), "utf8");
  const fixture = JSON.parse(raw) as RetainedRound;
  expect(fixture.historicalReplayOnly).toBe(true);
  expect(createHash("sha256").update(fixture.sse).digest("hex")).toBe(fixture.sseSha256);
  const transport = new SseChatTransport({
    fetchImpl: async () => new Response(fixture.sse, { headers: { "content-type": "text/event-stream" } }),
  });
  const events: StudioAiChatEvent[] = [];
  for await (const event of transport.streamChat(fixture.request, new AbortController().signal)) events.push(event);
  const provenance = events.at(-1)?.provenance;
  if (!provenance) throw new Error("Retained real round has no signed provenance.");
  const signed = JSON.parse(Buffer.from(provenance.canonicalTranscript, "base64").toString("utf8")) as {
    issuedAt: string;
    expiresAt: string;
  };
  // Explicit historical replay only: no wall-clock freshness or new live model claim.
  const now = () => new Date(Date.parse(signed.issuedAt) + 1000);
  const verifier = () =>
    new StudioAiTranscriptVerifier({ manifest: fixture.manifest, replayStore: new InMemoryStudioAiReplayStore(), now });
  return { fixture, events, provenance, signed, verifier };
}

describe("retained real signed PascalCase server rounds", () => {
  it.each(["text", "tool"])(
    "verifies original %s SSE/request with the real SDK at the retained historical clock",
    async (kind) => {
      const { fixture, events, provenance, verifier } = await retained(kind);
      const payload = events.filter((event) => event.type !== "transcriptProvenance");
      expect(payload.at(-1)?.stopReason).toBe(kind === "text" ? "EndTurn" : "ToolCall");
      const sdk = verifier();
      expect(await sdk.verify(provenance, fixture.request, payload)).toMatchObject({ ok: true });
      expect(await sdk.verify(provenance, fixture.request, payload)).toMatchObject({ ok: false, reason: "replay" });
      const checked = new VerifiedRoundTransport(
        {
          async *streamChat() {
            yield* events;
          },
        },
        verifier(),
      );
      const actual: StudioAiChatEvent[] = [];
      for await (const event of checked.streamChat(fixture.request, new AbortController().signal)) actual.push(event);
      expect(actual).toEqual(events);
      expect(actual.every((event, index) => event === events[index])).toBe(true);
    },
  );
  it.each(["text", "tool"])("rejects semantic-equivalent stopReason tampering in signed %s events", async (kind) => {
    const { fixture, events, provenance, verifier } = await retained(kind);
    const changed = events
      .filter((event) => event.type !== "transcriptProvenance")
      .map((event) =>
        event.type === "messageStop"
          ? { ...event, stopReason: kind === "text" ? ("endTurn" as const) : ("toolCall" as const) }
          : event,
      );
    expect(await verifier().verify(provenance, fixture.request, changed)).toMatchObject({
      ok: false,
      reason: "terminal-events-mismatch",
    });
    if (kind === "text") {
      const checked = new VerifiedRoundTransport(
        {
          async *streamChat() {
            yield* changed;
            yield { type: "transcriptProvenance", provenance };
          },
        },
        verifier(),
      );
      await expect(async () => {
        for await (const _event of checked.streamChat(fixture.request, new AbortController().signal)) {
          /* drain */
        }
      }).rejects.toThrow("terminal-events-mismatch");
    }
  });
  it("rejects changed signed request fields", async () => {
    const { fixture, events, provenance, verifier } = await retained("tool");
    expect(
      await verifier().verify(
        provenance,
        { ...fixture.request, maxTokens: 1 },
        events.filter((event) => event.type !== "transcriptProvenance"),
      ),
    ).toMatchObject({ ok: false, reason: "request-mismatch" });
  });
  it("does not turn historical verification into a freshness bypass", async () => {
    const { fixture, events, provenance, signed } = await retained("text");
    const expired = new StudioAiTranscriptVerifier({
      manifest: fixture.manifest,
      replayStore: new InMemoryStudioAiReplayStore(),
      now: () => new Date(Date.parse(signed.expiresAt) + 1000),
    });
    expect(
      (
        await expired.verify(
          provenance,
          fixture.request,
          events.filter((event) => event.type !== "transcriptProvenance"),
        )
      ).ok,
    ).toBe(false);
  });
});
