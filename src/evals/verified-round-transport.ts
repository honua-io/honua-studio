import type {
  ChatTransport,
  StudioAiChatEvent,
  StudioAiChatRequest,
  StudioAiTranscriptVerifierLike,
} from "@honua/sdk-js/studio-agent";

/** The diagnostic requires signed terminal text too; SDK 0.2.2 verifies action rounds itself. */
export class VerifiedRoundTransport implements ChatTransport {
  public constructor(
    private readonly transport: ChatTransport,
    private readonly verifier: StudioAiTranscriptVerifierLike | undefined,
  ) {}

  public async *streamChat(request: StudioAiChatRequest, signal: AbortSignal): AsyncGenerator<StudioAiChatEvent> {
    const events: StudioAiChatEvent[] = [];
    for await (const event of this.transport.streamChat(request, signal)) events.push(event);
    if (signal.aborted) throw new Error("Diagnostic model round was cancelled.");
    // Preserve actual provider errors. The session refuses dispatch when an
    // error is present, and both scorers independently fail turn completion.
    if (events.some((event) => event.type === "error")) {
      yield* events;
      return;
    }
    if (events[0]?.type !== "messageStart" || events.filter((event) => event.type === "messageStart").length !== 1) {
      throw new Error("Diagnostic model rounds require exactly one initial messageStart.");
    }
    const stops = events.filter((event) => event.type === "messageStop");
    const provenanceEvents = events.filter((event) => event.type === "transcriptProvenance");
    if (stops.length !== 1 || provenanceEvents.length !== 1 || events.at(-1)?.type !== "transcriptProvenance") {
      throw new Error(
        "Diagnostic model rounds require one completed message and one terminal signed provenance event.",
      );
    }
    const stopIndex = events.findIndex((event) => event.type === "messageStop");
    if (events.slice(stopIndex + 1).some((event) => event.type !== "transcriptProvenance")) {
      throw new Error("Diagnostic model round continued after messageStop.");
    }
    const hasToolEvent = events.some((event) =>
      ["toolCallStart", "toolCallDelta", "toolCallStop"].includes(event.type),
    );
    if (hasToolEvent) {
      assertCompleteToolCalls(events);
      // Do not consume the replay nonce here. The SDK verifies this exact
      // transcript once, immediately before entering the dispatch boundary.
      if (!isCompletedReason(stops[0]?.stopReason, true)) {
        throw new Error(`Diagnostic tool round did not complete (stopReason=${reasonDetail(stops[0]?.stopReason)}).`);
      }
    } else {
      if (!isCompletedReason(stops[0]?.stopReason, false))
        throw new Error(`Diagnostic text round did not complete (stopReason=${reasonDetail(stops[0]?.stopReason)}).`);
      if (!events.some((event) => event.type === "textDelta" && event.text?.trim())) {
        throw new Error("Diagnostic text round completed without an answer.");
      }
      const provenance = provenanceEvents[0]?.provenance;
      if (!this.verifier || !provenance) throw new Error("Diagnostic text round has no trusted transcript verifier.");
      const verification = await this.verifier.verify(
        provenance,
        request,
        events.filter((event) => event.type !== "transcriptProvenance"),
      );
      if (!verification.ok) throw new Error(`Diagnostic text provenance rejected: ${verification.reason}.`);
    }
    yield* events;
  }
}

// Established server enums are PascalCase; fixture/client spellings are camelCase.
// This predicate interprets completion only. Never rewrite the signed events:
// the SDK verifier must compare their original stopReason values exactly.
function isCompletedReason(reason: unknown, hasTools: boolean): boolean {
  return reason === "EndTurn" || reason === "endTurn" || (hasTools && (reason === "ToolCall" || reason === "toolCall"));
}

function reasonDetail(reason: unknown): string {
  return typeof reason === "string" ? JSON.stringify(reason.slice(0, 64)) : `<${typeof reason}>`;
}

function assertCompleteToolCalls(events: readonly StudioAiChatEvent[]): void {
  const calls = new Map<string, { stopped: boolean; name: string }>();
  let latest: string | undefined;
  for (const event of events) {
    if (event.type === "toolCallStart") {
      const id = event.toolCallId ?? `tool-${calls.size + 1}`;
      if (calls.has(id)) throw new Error("Diagnostic tool round repeated a call identifier.");
      calls.set(id, { stopped: false, name: event.toolName ?? "" });
      latest = id;
    } else if (event.type === "toolCallDelta" || event.type === "toolCallStop") {
      const id = event.toolCallId ?? latest;
      const call = id === undefined ? undefined : calls.get(id);
      if (!call || call.stopped) throw new Error("Diagnostic tool event has no active call.");
      if (event.type === "toolCallStop") {
        call.stopped = true;
        if (event.toolName) call.name = event.toolName;
      }
    }
  }
  if (calls.size === 0 || [...calls.values()].some((call) => !call.stopped || !call.name)) {
    throw new Error("Diagnostic tool round is incomplete.");
  }
}
