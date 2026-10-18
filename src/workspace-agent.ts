import {
  type StudioAgentSession,
  type StudioAgentSessionEvent,
  type StudioAgentSessionOptions,
  createStudioAgentSession,
} from "@honua/sdk-js/studio-agent";

export const workspaceAgentFeatures = Object.freeze({ toolApproval: true, visualStyleScopes: true });

/** Creates the one host-owned model/tool loop with a separately authenticated agent transport. */
export function createWorkspaceAgentSession(options: {
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
    mcpWorkflowView: "full",
    certification: options.certification,
    transcriptVerifier: options.transcriptVerifier,
    fetchImpl: options.fetchImpl,
    system: options.system,
    studioTools: { families: options.toolFamilies, required: [], approve: options.toolApproval },
    onEvent: options.onEvent,
  });
}

export const workspaceAgent = { createSession: createWorkspaceAgentSession };

export interface WorkspaceAgentSessionAdapter {
  submitTurn(
    prompt: string,
    options: {
      readonly signal: AbortSignal;
      readonly onEvent: (event: StudioAgentSessionEvent) => void;
    },
  ): ReturnType<StudioAgentSession["chat"]>;
}

export interface WorkspaceConversationMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
}
