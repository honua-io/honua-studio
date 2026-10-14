import type {
  StudioAiChatEvent,
  StudioAiChatRequest,
  StudioAiSignedTranscript,
  StudioAiTranscriptSigningManifest,
} from "@honua/sdk-js/studio-agent";
export declare function createFixtureTranscriptSigner(): {
  manifest: StudioAiTranscriptSigningManifest;
  sign(
    request: StudioAiChatRequest,
    events: readonly StudioAiChatEvent[],
  ): { type: "transcriptProvenance"; provenance: StudioAiSignedTranscript };
};
