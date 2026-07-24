import type { StudioAiChatEvent } from "./ai-contract.js";
/**
 * The scripted-conversation JSON format (honua-studio#6, AD-4 "a no-model
 * fixture-conversation mode exists for CI and staged demos"; NFR-001
 * "deterministic CI: all agent journeys run model-free via fixture
 * conversations"). A `FixtureConversation` is a fixed sequence of
 * user-turn/assistant-turn pairs; `FixtureChatTransport` (./fixture-transport.js)
 * replays one assistant turn's `StudioAiChatEvent`s per `streamChat()` call,
 * in fixed chunking, with no wall-clock-dependent timers — byte-stable
 * across runs (see `test/chat/fixture-replay.test.ts`).
 *
 * The same JSON files under `./fixtures/*.json` back BOTH this client-side
 * transport AND `mock-server.mjs`'s `/v1/studio/ai/chat` fixture route (read
 * directly via `node:fs`, not through this TS module) — one source of truth
 * for "what the canned conversation says" in every dev/test surface.
 */
import type { AnnotationKind, AnnotationPayloadOf } from "./annotation.js";

/** A scripted annotation the fixture attaches to a user turn before sending — always carries an explicit `id`/`createdAt` (never generated) so replay is deterministic. */
export interface FixtureAnnotationSeed<K extends AnnotationKind = AnnotationKind> {
  readonly id: string;
  readonly kind: K;
  readonly payload: AnnotationPayloadOf<K>;
  readonly label?: string;
  readonly createdAt: string;
}

export interface FixtureUserTurn {
  readonly text: string;
  readonly annotations?: readonly FixtureAnnotationSeed[];
}

export interface FixtureAssistantTurn {
  readonly events: readonly StudioAiChatEvent[];
}

export interface FixtureConversationTurn {
  readonly user: FixtureUserTurn;
  readonly assistant: FixtureAssistantTurn;
}

export interface FixtureConversation {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly turns: readonly FixtureConversationTurn[];
}

/** Thrown by {@link parseFixtureConversation} for a structurally invalid fixture file. */
export class InvalidFixtureConversationError extends Error {
  constructor(reason: string) {
    super(`Invalid fixture conversation: ${reason}`);
    this.name = "InvalidFixtureConversationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Runtime-validates parsed JSON as a {@link FixtureConversation} — the boundary between "arbitrary JSON on disk" and the typed shape the transport/player trust. */
export function parseFixtureConversation(value: unknown): FixtureConversation {
  if (!isRecord(value)) throw new InvalidFixtureConversationError("expected a JSON object.");
  const { id, title, turns } = value as Record<string, unknown>;
  if (typeof id !== "string" || id.length === 0)
    throw new InvalidFixtureConversationError('"id" must be a non-empty string.');
  if (typeof title !== "string" || title.length === 0) {
    throw new InvalidFixtureConversationError('"title" must be a non-empty string.');
  }
  if (!Array.isArray(turns) || turns.length === 0) {
    throw new InvalidFixtureConversationError('"turns" must be a non-empty array.');
  }
  for (const [index, turn] of turns.entries()) {
    if (!isRecord(turn) || !isRecord(turn.user) || !isRecord(turn.assistant)) {
      throw new InvalidFixtureConversationError(`turns[${index}] must have "user" and "assistant" objects.`);
    }
    if (typeof turn.user.text !== "string") {
      throw new InvalidFixtureConversationError(`turns[${index}].user.text must be a string.`);
    }
    if (!Array.isArray(turn.assistant.events)) {
      throw new InvalidFixtureConversationError(`turns[${index}].assistant.events must be an array.`);
    }
  }
  return value as unknown as FixtureConversation;
}
