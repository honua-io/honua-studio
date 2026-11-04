import type { HonuaAgentToolDefinitionLike, HonuaAgentToolResult, HonuaAiMapKit } from "@honua/sdk-js/agent-tools";
import type { StudioAgentSession } from "@honua/sdk-js/studio-agent";
import type { AuthSession } from "../auth/index.js";
import {
  fetchShareProposalStatus,
  loadShareProposal,
  projectPublicationReceipt,
  projectShareConversation,
  sessionShareStorage,
} from "../chat/share-preview.js";
import { buildStudioSystemPrompt } from "../chat/system-prompt.js";
import type { CompositionController } from "../composition/controller.js";
import type { HonuaStudioChatElement, StudioAgentCertificationOptions } from "../elements/studio-chat-element.js";
import type { HonuaStudioCompositionModeChangeDetail } from "../elements/types.js";
import { createStudioAiMapKit } from "../map/agent-map-kit.js";
import { McpClient } from "../mcp/client.js";
import { StudioAuthoringMcpClient } from "../mcp/composition-authoring-contract.js";
import { ToolCallOrchestrator } from "../mcp/orchestrator.js";
import type { StudioMcpDraft, StudioPackageFamilyWire } from "../mcp/studio-tools.js";
import { runtimeMcpBaseUrl, runtimeServerBaseUrl } from "../runtime-config.js";
import type { AuthoritativeStyleDefinition } from "../styles/authoritative-style-provider.js";
import type { WorkspaceAgentSessionAdapter } from "../workspace-agent.js";
import { sourceStyleProvider } from "./runtime-clients.js";
import type { ShellChrome } from "./shell-chrome.js";
import type { SourceCatalog } from "./source-catalog.js";
import { type EpochToken, StalenessEpoch } from "./staleness-epoch.js";
import type { StudioAppChildren } from "./studio-app-children.js";

type AgentToolDefinitions = (kit: HonuaAiMapKit) => ReadonlyArray<HonuaAgentToolDefinitionLike>;
type AgentSessionOptions = Parameters<HonuaStudioChatElement["attachAgentSession"]>[0];
type ForwardedToolCall = { readonly name: string; readonly args?: Readonly<Record<string, unknown>> };

export interface LiveCompositionOptions {
  readonly baseUrl?: string;
  readonly packageKey: string;
  readonly family?: StudioPackageFamilyWire;
  readonly schemaVersion?: string;
}

type ResolvedLiveOptions = LiveCompositionOptions & { readonly baseUrl: string };

/** The public `<honua-studio-app>` surface live composition reads; hosts and tests may replace these. */
export interface LiveCompositionHost extends EventTarget {
  readonly isConnected: boolean;
  readonly auth: AuthSession;
  readonly composition: CompositionController;
  readonly agentSessionAdapter: WorkspaceAgentSessionAdapter | undefined;
  readonly toolCallOrchestrator: ToolCallOrchestrator;
  readonly aiMapKit: HonuaAiMapKit;
  readonly agentToolDefinitions: AgentToolDefinitions;
  disableLiveComposition(): void;
}

export interface LiveCompositionControllerOptions {
  readonly host: LiveCompositionHost;
  readonly catalog: SourceCatalog;
  readonly chrome: ShellChrome;
  readonly children: StudioAppChildren;
}

/** One attached agent session; its callbacks go quiet once a newer setup supersedes it. */
interface AgentSetup {
  readonly chat: HonuaStudioChatElement;
  readonly generation: EpochToken;
  readonly kit: HonuaAiMapKit;
  readonly styles: readonly AuthoritativeStyleDefinition[];
  readonly session: { current?: StudioAgentSession };
}

const DEFAULT_TOOL_DEFINITIONS: AgentToolDefinitions = (kit) =>
  kit.tools.filter((tool) => tool.mode === "read" || tool.name === "selectFeature");

function orchestrationAgentResult(
  call: ForwardedToolCall,
  result: Awaited<ReturnType<ToolCallOrchestrator["handleToolCall"]>>,
): HonuaAgentToolResult {
  const status = result.ok ? "ok" : "error";
  const message = result.ok ? undefined : result.reason;
  return {
    tool: call.name,
    status,
    ...(result.ok && result.draft ? { data: result.draft } : {}),
    ...(message ? { deniedReason: message } : {}),
    audit: {
      tool: call.name,
      status,
      dryRun: false,
      action: true,
      outcome: result.ok ? "allowed" : "error",
      parameters: call.args ?? {},
      ...(message ? { message } : {}),
      timestamp: new Date().toISOString(),
    },
  } as unknown as HonuaAgentToolResult;
}

/**
 * Fixture or live composition: the tool-call orchestrator, its optional live MCP session and the chat's
 * agent session built on it. `agentSetup` advances whenever a session is replaced or detached.
 */
export class LiveCompositionController {
  readonly #agentSetup = new StalenessEpoch();
  readonly #publicationNote = new StalenessEpoch();
  #orchestrator: ToolCallOrchestrator | undefined;
  #mapKit: HonuaAiMapKit | undefined;
  #liveOptions: ResolvedLiveOptions | undefined;
  #liveAgentBaseUrl = "/api";
  #toolDefinitions: AgentToolDefinitions | undefined;
  #certification: StudioAgentCertificationOptions | undefined;

  constructor(private readonly options: LiveCompositionControllerOptions) {}

  get orchestrator(): ToolCallOrchestrator {
    this.#orchestrator ??= new ToolCallOrchestrator({
      controller: this.options.host.composition,
      activityLog: this.options.children.chat()?.activityLog,
    });
    return this.#orchestrator;
  }

  get isLive(): boolean {
    return this.#orchestrator?.isLive === true;
  }

  get packageKey(): string | undefined {
    return this.#liveOptions?.packageKey;
  }

  get mapKit(): HonuaAiMapKit {
    const { catalog } = this.options.catalog;
    this.#mapKit ??= createStudioAiMapKit({
      controller: this.options.host.composition,
      ...(catalog !== undefined ? { catalog } : {}),
    });
    return this.#mapKit;
  }

  /** The kit advertises the catalog, so it is rebuilt around a new one. */
  forgetMapKit(): void {
    this.#mapKit = undefined;
  }

  get toolDefinitions(): AgentToolDefinitions {
    return this.#toolDefinitions ?? DEFAULT_TOOL_DEFINITIONS;
  }

  set toolDefinitions(provider: AgentToolDefinitions) {
    this.#toolDefinitions = provider;
    if (this.isLive) this.scheduleAgentSession();
  }

  get certification(): StudioAgentCertificationOptions | undefined {
    return this.#certification;
  }

  set certification(options: StudioAgentCertificationOptions | undefined) {
    this.#certification = options;
    if (this.isLive) this.scheduleAgentSession();
  }

  enable(options: LiveCompositionOptions): void {
    const liveOptions: ResolvedLiveOptions = {
      baseUrl: options.baseUrl ?? runtimeMcpBaseUrl(),
      packageKey: options.packageKey,
      ...(options.family !== undefined ? { family: options.family } : {}),
      ...(options.schemaVersion !== undefined ? { schemaVersion: options.schemaVersion } : {}),
    };
    this.#liveOptions = liveOptions;
    this.#replaceSession(liveOptions);
    this.#announceMode({
      mode: "live",
      packageKey: options.packageKey,
      ...(options.family !== undefined ? { family: options.family } : {}),
    });
  }

  disable(): void {
    const orchestrator = this.options.host.toolCallOrchestrator;
    if (!orchestrator.isLive) return;
    orchestrator.detachLiveSession();
    this.#agentSetup.next();
    this.options.children.chat()?.detachAgentSession();
    const chat = this.options.children.chat();
    if (chat) chat.agentSessionPending = false;
    this.#liveOptions = undefined;
    this.#announceMode({ mode: "fixture" });
  }

  /** Live clients capture their AuthSession at construction, so new credentials need a new session. */
  renewCredentials(): void {
    if (this.isLive && this.#liveOptions) this.#replaceSession(this.#liveOptions);
  }

  scheduleAgentSession(): void {
    const setup = this.#attachAgentSession(this.#liveAgentBaseUrl);
    const generation = this.#agentSetup.current;
    void setup.catch((error) => {
      if (!this.#agentSetup.isCurrent(generation)) return;
      this.options.host.disableLiveComposition();
      this.options.children.chat()?.activityLog.append("assistant_turn_error", {
        errorMessage: error instanceof Error ? error.message : String(error),
        phase: "agent-session-setup",
      });
    });
  }

  /** Supersedes any agent session setup still in flight. */
  cancelAgentSetup(): void {
    this.#agentSetup.next();
  }

  /** Restores a retained preview proposal into the conversation. Never publishes. */
  async resumeSharePreview(): Promise<void> {
    const noteGeneration = this.#publicationNote.current;
    try {
      const handle = loadShareProposal(sessionShareStorage());
      if (!handle) return;
      const chat = this.options.children.chat();
      if (!chat) return;
      chat.shareNote = projectShareConversation(handle, {
        proposalId: handle.proposalId,
        status: "AwaitingApproval",
      }).text;
      const token = await this.options.host.auth?.getAccessToken();
      if (!token) return;
      const status = await fetchShareProposalStatus(runtimeServerBaseUrl(), handle.proposalId, token);
      if (!status || !this.#publicationNote.isCurrent(noteGeneration) || !this.options.host.isConnected) return;
      chat.shareNote = projectShareConversation(handle, status).text;
    } catch {
      // A retained handle must not block the shell when the preview server is unreachable.
    }
  }

  #replaceSession(options: ResolvedLiveOptions): void {
    this.#agentSetup.next();
    this.options.children.chat()?.detachAgentSession();
    this.#liveAgentBaseUrl = options.baseUrl;
    this.options.host.toolCallOrchestrator.attachLiveSession({
      client: new McpClient({ baseUrl: options.baseUrl, auth: this.options.host.auth }),
      packageKey: options.packageKey,
      ...(options.family !== undefined ? { family: options.family } : {}),
      ...(options.schemaVersion !== undefined ? { schemaVersion: options.schemaVersion } : {}),
    });
    this.scheduleAgentSession();
  }

  #announceMode(detail: HonuaStudioCompositionModeChangeDetail): void {
    this.options.chrome.paintLiveComposition();
    this.options.children.chat()?.activityLog.append("composition_mode_changed", { ...detail });
    this.options.host.dispatchEvent(
      new CustomEvent<HonuaStudioCompositionModeChangeDetail>("honua-studio-composition-mode-change", {
        bubbles: true,
        composed: true,
        detail,
      }),
    );
  }

  async #attachAgentSession(baseUrl: string): Promise<void> {
    const { host } = this.options;
    const chat = this.options.children.chat();
    if (chat && host.agentSessionAdapter) chat.agentSessionAdapter = host.agentSessionAdapter;
    if (!chat || chat.agentSessionAdapter || chat.hasCustomTransport || host.auth.fetchRequest) return;
    if (!host.toolCallOrchestrator.isLive) return;
    const generation = this.#agentSetup.next();
    const isSuperseded = () => !this.#agentSetup.isCurrent(generation) || !host.toolCallOrchestrator.isLive;
    chat.agentSessionPending = true;
    const draft = await host.toolCallOrchestrator.ensureLiveDraft();
    if (isSuperseded()) return;
    chat.agentSessionPending = false;
    const kit = host.aiMapKit;
    const styleAuth = host.auth;
    const styles = await this.#readAdvertisedStyles();
    if (isSuperseded() || host.auth !== styleAuth) return;
    const setup: AgentSetup = { chat, generation, kit, styles, session: {} };
    setup.session.current = chat.attachAgentSession({ ...this.#agentSessionOptions(setup, baseUrl), draft });
  }

  /** Up to ten style definitions the agent may apply; names never substitute for readable definitions. */
  async #readAdvertisedStyles(): Promise<AuthoritativeStyleDefinition[]> {
    const styleProvider = sourceStyleProvider({
      baseUrl: runtimeMcpBaseUrl(),
      getAuth: () => this.options.host.auth,
      signal: AbortSignal.timeout(8000),
    });
    const styles: AuthoritativeStyleDefinition[] = [];
    try {
      for (const entry of (await styleProvider.list()).slice(0, 10)) {
        try {
          styles.push(await styleProvider.read(entry.styleId));
        } catch {
          /* Unsupported definitions are not advertised as usable. */
        }
      }
    } catch {
      /* The prompt explicitly reports unavailable styles. */
    }
    return styles;
  }

  #agentSessionOptions(setup: AgentSetup, baseUrl: string): Omit<AgentSessionOptions, "draft"> {
    const { host } = this.options;
    const certification = this.#certification;
    return {
      ...(certification?.certification ? { certification: certification.certification } : {}),
      ...(certification?.transcriptVerifier ? { transcriptVerifier: certification.transcriptVerifier } : {}),
      baseUrl,
      auth: host.auth,
      mcpClient: new StudioAuthoringMcpClient({ baseUrl, auth: host.auth, workflowView: "setup" }),
      workflowKnowledge: true,
      tools: [...host.agentToolDefinitions(setup.kit)],
      execute: (call) => this.#executeAgentTool(setup, call),
      system: () => this.#systemPrompt(setup.styles),
      onEvent: (event) => {
        if (event.type === "toolResult") this.#acceptAgentToolResult(setup, event.result);
      },
    };
  }

  /** A host may supply the visibility mutation through the runtime-tool seam; it runs through the orchestrator. */
  async #executeAgentTool(setup: AgentSetup, call: Parameters<HonuaAiMapKit["execute"]>[0]) {
    const forwardedCall = call as unknown as ForwardedToolCall;
    if (forwardedCall.name !== "honua_studio_set_layer_visibility") return setup.kit.execute(call);
    const orchestrator = this.options.host.toolCallOrchestrator;
    const result = await orchestrator.handleToolCall({
      toolName: forwardedCall.name,
      arguments: forwardedCall.args ?? {},
    });
    if (result.ok && orchestrator.draftId && orchestrator.generation !== undefined) {
      setup.session.current?.attachDraft({ draftId: orchestrator.draftId, generation: orchestrator.generation });
    }
    return orchestrationAgentResult(forwardedCall, result);
  }

  #systemPrompt(styles: readonly AuthoritativeStyleDefinition[]): string {
    const { host } = this.options;
    return buildStudioSystemPrompt({
      draftId: host.toolCallOrchestrator.draftId,
      generation: host.toolCallOrchestrator.generation,
      catalog: this.options.catalog.catalog,
      styles: styles.map(({ styleId, title, description, styleVersion, sha256 }) => ({
        styleId,
        title,
        description,
        styleVersion,
        sha256,
      })),
      composition: host.composition.state,
    });
  }

  #acceptAgentToolResult(
    setup: AgentSetup,
    result: { readonly ok: boolean; readonly toolName: string; readonly content: string; readonly draft?: unknown },
  ): void {
    const orchestrator = this.options.host.toolCallOrchestrator;
    if (!this.#agentSetup.isCurrent(setup.generation) || setup.session.current !== setup.chat.agentSession) return;
    if (!orchestrator.isLive) return;
    if (result.draft) orchestrator.acceptServerDraft(result.draft as StudioMcpDraft);
    if (result.ok && result.toolName === "honua_studio_propose_publication") this.#showPublicationNote(setup, result);
  }

  #showPublicationNote(setup: AgentSetup, result: { readonly content: string }): void {
    try {
      const payload = JSON.parse(result.content) as { status?: string; result?: unknown };
      if (payload.status !== "ok") return;
      const note = projectPublicationReceipt(payload.result, new URL(runtimeServerBaseUrl(), document.baseURI).href);
      if (note) {
        this.#publicationNote.next();
        setup.chat.shareNote = note.text;
      }
    } catch {
      // A malformed receipt must not turn assistant text into a publication link.
    }
  }
}
