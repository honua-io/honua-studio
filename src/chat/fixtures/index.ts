/**
 * The two required (honua-studio#6) scripted conversations, loaded and
 * runtime-validated once. `mock-server.mjs`'s `/v1/studio/ai/chat` fixture
 * route reads the same `*.json` files directly via `node:fs` — this module
 * is the TypeScript-side (bundled) way to reach them.
 */
import { type FixtureConversation, parseFixtureConversation } from "../fixture-conversation.js";
import composeDistrictsMapJson from "./compose-districts-map.json";
import annotateParcelFeatureJson from "./annotate-parcel-feature.json";

export const composeDistrictsMapConversation: FixtureConversation = parseFixtureConversation(composeDistrictsMapJson);
export const annotateParcelFeatureConversation: FixtureConversation = parseFixtureConversation(annotateParcelFeatureJson);

export const FIXTURE_CONVERSATIONS: readonly FixtureConversation[] = [
  composeDistrictsMapConversation,
  annotateParcelFeatureConversation,
];
