/**
 * Drives a `<honua-studio-chat>`-shaped target through a whole
 * {@link FixtureConversation} using only the element's public API
 * (`addAnnotation` / `sendMessage`) — the same surface a real host or a
 * canvas would use, so this is a "player", not a backdoor. Used by
 * `test/chat/fixture-replay.test.ts` (byte-stability) and the standalone
 * shell's fixture-mode Playwright journey.
 */
import type { AnnotationRef, CreateAnnotationInput } from "./annotation.js";
import type { FixtureConversation } from "./fixture-conversation.js";

export interface FixtureChatTarget {
  addAnnotation(input: CreateAnnotationInput): AnnotationRef;
  sendMessage(text: string): Promise<void>;
}

/** Plays every turn of `conversation` against `target`, in order, awaiting each assistant turn's completion before sending the next user turn. */
export async function playFixtureConversation(
  target: FixtureChatTarget,
  conversation: FixtureConversation,
): Promise<void> {
  for (const turn of conversation.turns) {
    for (const seed of turn.user.annotations ?? []) {
      target.addAnnotation({
        id: seed.id,
        kind: seed.kind,
        payload: seed.payload,
        label: seed.label,
        createdAt: seed.createdAt,
      });
    }
    await target.sendMessage(turn.user.text);
  }
}
