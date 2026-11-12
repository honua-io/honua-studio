import {
  type StudioAgentSession,
  type StudioAgentSessionEvent,
  type StudioAgentSessionOptions,
  createStudioAgentSession,
} from "@honua/sdk-js/studio-agent";

export const editorAgentFeatures = Object.freeze({ toolApproval: true, visualStyleScopes: true });

/** Creates the one host-owned model/tool loop with a separately authenticated agent transport. */
export function createEditorAgentSession(options: {
  readonly fetchImpl: typeof fetch;
  readonly system: StudioAgentSessionOptions["system"];
  readonly toolFamilies: readonly string[];
  readonly toolApproval?: NonNullable<StudioAgentSessionOptions["studioTools"]>["approve"];
  readonly onEvent?: StudioAgentSessionOptions["onEvent"];
  readonly certification?: StudioAgentSessionOptions["certification"];
  readonly transcriptVerifier?: StudioAgentSessionOptions["transcriptVerifier"];
}) {
  return createStudioAgentSession({
    baseUrl: "/api",
    mcpWorkflowView: "workspace",
    workflowKnowledge: true,
    certification: options.certification,
    transcriptVerifier: options.transcriptVerifier,
    fetchImpl: options.fetchImpl,
    system: options.system,
    studioTools: { families: options.toolFamilies, required: [], approve: options.toolApproval },
    onEvent: options.onEvent,
  });
}

export const editorAgent = { createSession: createEditorAgentSession };

export interface EditorAgentSessionAdapter {
  submitTurn(
    prompt: string,
    options: {
      readonly signal: AbortSignal;
      readonly onEvent: (event: StudioAgentSessionEvent) => void;
    },
  ): ReturnType<StudioAgentSession["chat"]>;
}

export interface EditorConversationMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
}
