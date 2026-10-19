/**
 * `<honua-studio-app>` — the full Studio shell (honua-studio#5 REQ-001/002).
 *
 * The standalone shell (src/main.ts) is now exactly this element mounted by
 * a thin bootstrap: header chrome (brand, nav, session/auth controls,
 * optional theme switcher) plus a routed `#view` outlet, plus a persistent
 * composition area slotting in `<honua-studio-chat>` and
 * `<honua-studio-canvas>`. See docs/element-contract.md for the full
 * attribute/property/event contract and docs/embed-session.md for the
 * session contract this element drives; this file is the implementation,
 * not a second copy of either doc.
 *
 * Session/auth (honua-studio#4 REQ-001/003, reconciled here after #4 merged
 * ahead of this branch): `.session` is the embed injection surface — an
 * optional host-provided `SessionAdapter` (`../auth/types.js`), the SAME
 * type `window.__HONUA_STUDIO_HOST_SESSION__` already used, just promoted
 * to the primary path (see docs/embed-session.md). Internally this element
 * always resolves a full `AuthSession` via `createAuthSession()` — standalone
 * OIDC when no adapter is present (property or window global), a
 * `HostAdapterAuthSession` wrapping the adapter otherwise — and that's what
 * drives the auth-status label, the standalone sign-in/out controls (never
 * rendered in host-adapter mode — REQ-003), and gates the catalog/packages
 * fetch in `../pages/home.js`.
 *
 * Composition + MCP tool-call orchestration (honua-studio#7, AD-8): this
 * element owns the one `CompositionController` its auto-composed
 * `<honua-studio-canvas>` renders, and the one `ToolCallOrchestrator`
 * (`../mcp/orchestrator.js`) that turns the auto-composed
 * `<honua-studio-chat>`'s `honua-studio-chat-tool-call-result` events into
 * composition mutations — fixture/offline mode (the reducer only) by
 * default, or the AD-8 authoritative server-draft path once a host calls
 * `.enableLiveComposition()`. A host that supplies its own chat/canvas
 * children (skipping the auto-compose block below) is responsible for its
 * own wiring — this element never reaches into a host-supplied child beyond
 * the same public properties/events any embedder could use.
 */
import type { HonuaAgentToolDefinitionLike, HonuaAgentToolResult, HonuaAiMapKit } from "@honua/sdk-js/agent-tools";
import {
  InMemoryStudioAiReplayStore,
  type StudioAgentSession,
  type StudioAiTranscriptCertification,
  type StudioAiTranscriptSigningManifest,
  StudioAiTranscriptVerifier,
} from "@honua/sdk-js/studio-agent";
import { verifiedSourcePathBase } from "../auth/host-session.js";
import {
  type AuthoritativeStyleDefinition,
  AuthoritativeStyleProvider,
} from "../styles/authoritative-style-provider.js";
import type { MapStyleDocument } from "../styles/map-style-edit.js";
import { MapStyleEditor } from "../styles/map-style-editor.js";
import type { WorkspaceAgentSessionAdapter, WorkspaceConversationMessage } from "../workspace-agent.js";

import { type AuthSession, type SessionAdapter, createAuthSession } from "../auth/index.js";
import {
  fetchShareProposalStatus,
  loadShareProposal,
  projectPublicationReceipt,
  projectShareConversation,
  sessionShareStorage,
} from "../chat/share-preview.js";
import { buildStudioSystemPrompt } from "../chat/system-prompt.js";
import { type CatalogDataset, StudioClient } from "../client/studio-client.js";
import type { CompositionCommand } from "../composition/commands.js";
import { CompositionController } from "../composition/controller.js";
import { createEmptyCompositionState } from "../composition/model.js";
import { applyCompositionCommands } from "../composition/reducer.js";
import { StudioLifecycleClient } from "../lifecycle/lifecycle-client.js";
import type { StudioContentVersion, StudioPublishRequestInput } from "../lifecycle/lifecycle-types.js";
import { WorkspaceDraftBinding } from "../lifecycle/workspace-draft.js";
import { createStudioAiMapKit } from "../map/agent-map-kit.js";
import { McpClient } from "../mcp/client.js";
import { StudioAuthoringMcpClient } from "../mcp/composition-authoring-contract.js";
import { MAP_COMPOSITION_ENVELOPE, toCompositionDraftBody } from "../mcp/composition-envelope.js";
import { ToolCallOrchestrator } from "../mcp/orchestrator.js";
import type { StudioMcpDraft, StudioPackageFamilyWire } from "../mcp/studio-tools.js";
import { renderAbout } from "../pages/about.js";
import { renderContent } from "../pages/content.js";
import { renderHome } from "../pages/home.js";
import { Router } from "../router/router.js";
import { runtimeMcpBaseUrl, runtimeServerBaseUrl } from "../runtime-config.js";
import { ThemeLoader } from "../theme/theme-loader.js";
import type { ThemeMode, ThemeSet } from "../theme/theme-loader.js";
import { AUTH_STATUS_LABELS } from "./auth-status.js";
import { HonuaStudioElementBase } from "./base-element.js";
import type { HonuaStudioCanvasElement } from "./studio-canvas-element.js";
import type { HonuaStudioChatElement, StudioAgentCertificationOptions } from "./studio-chat-element.js";
import { appShellStyles, baseElementStyles } from "./styles.js";
import type {
  HonuaStudioChatToolCallResultDetail,
  HonuaStudioCommandOutcome,
  HonuaStudioCompositionModeChangeDetail,
  HonuaStudioGpActivityDetail,
  HonuaStudioGpAddOutputDetail,
  HonuaStudioLifecycleActivityDetail,
  HonuaStudioNavigateDetail,
  HonuaStudioRoutingMode,
  HonuaStudioThemeChangeDetail,
  HonuaStudioThemeSwitcherVisibility,
} from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function orchestrationAgentResult(
  call: { readonly name: string; readonly args?: Readonly<Record<string, unknown>> },
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

interface StudioRoute {
  path: string;
  navTestId: string;
  label: string;
  render: (
    root: HTMLElement,
    client: StudioClient,
    auth: AuthSession,
    onAddSource: (dataset: CatalogDataset) => Promise<void>,
  ) => void;
}

interface LiveCompositionOptions {
  readonly baseUrl: string;
  readonly packageKey: string;
  readonly family?: StudioPackageFamilyWire;
  readonly schemaVersion?: string;
}

const ROUTES: readonly StudioRoute[] = [
  {
    path: "/",
    navTestId: "nav-home",
    label: "Home",
    render: (root, client, auth, onAddSource) => renderHome(root, client, auth, onAddSource),
  },
  {
    path: "/content",
    navTestId: "nav-content",
    label: "Content",
    render: (root, _client, auth) => renderContent(root, auth),
  },
  { path: "/about", navTestId: "nav-about", label: "About", render: (root) => renderAbout(root) },
];

/** Package families whose drafts carry a composition body — mirrors `mock-server.mjs`'s `COMPOSITION_ELIGIBLE_FAMILIES` and honua-server#3002's own gate. */
const LIVE_COMPOSITION_FAMILIES: readonly StudioPackageFamilyWire[] = ["map", "app"];

/** Shown when composition applies through the local reducer only — the default (REQ-005). */
const FIXTURE_MODE_LABEL = "Fixture mode";

const THEME_SETS: readonly ThemeSet[] = ["standalone", "console"];
const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "auto"];
const THEME_SET_LABELS: Record<ThemeSet, string> = { standalone: "Standalone", console: "Console" };
const THEME_MODE_LABELS: Record<ThemeMode, string> = { light: "Light", dark: "Dark", auto: "Auto" };

function normalizePath(path: string): string {
  if (!path || path === "") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function stripBasePath(path: string, basePath: string | null): string {
  if (!basePath) return path;
  const trimmedBase = basePath.replace(/\/$/, "");
  if (trimmedBase && path.startsWith(trimmedBase)) {
    const rest = path.slice(trimmedBase.length);
    return normalizePath(rest === "" ? "/" : rest);
  }
  return path;
}

function withBasePath(path: string, basePath: string | null): string {
  if (!basePath) return path;
  const trimmedBase = basePath.replace(/\/$/, "");
  return path === "/" ? trimmedBase || "/" : `${trimmedBase}${path}`;
}

/** `AuthSession` implementations that own an external subscription (`HostAdapterAuthSession`) expose `dispose()`; `OidcAuthSession` doesn't need one. Duck-typed so this element never imports the concrete classes. */
function disposeAuthSession(auth: AuthSession | undefined): void {
  (auth as (AuthSession & { dispose?: () => void }) | undefined)?.dispose?.();
}

export class HonuaStudioAppElement extends HonuaStudioElementBase {
  static get observedAttributes(): string[] {
    return ["data-theme-set", "data-theme", "routing-mode", "current-path", "base-path", "theme-switcher"];
  }

  #session: SessionAdapter | undefined;
  #workspaceAgentAdapter: WorkspaceAgentSessionAdapter | undefined;
  #workspaceConversation: readonly WorkspaceConversationMessage[] = [];
  public setWorkspaceConversation(messages: readonly WorkspaceConversationMessage[]): boolean {
    this.#workspaceConversation = messages.map((message) => ({ ...message }));
    return (
      this.querySelector<HonuaStudioChatElement>("honua-studio-chat")?.setWorkspaceConversation(
        this.#workspaceConversation,
      ) ?? true
    );
  }

  public get agentSessionAdapter(): WorkspaceAgentSessionAdapter | undefined {
    return this.#workspaceAgentAdapter;
  }
  public set agentSessionAdapter(adapter: WorkspaceAgentSessionAdapter | undefined) {
    const previous = this.#workspaceAgentAdapter;
    this.#workspaceAgentAdapter = adapter;
    this.#syncWorkspaceChrome();
    const chat = this.querySelector<HonuaStudioChatElement>("honua-studio-chat");
    if (chat && (previous !== adapter || chat.agentSessionAdapter !== adapter)) {
      chat.detachAgentSession();
      chat.agentSessionAdapter = adapter;
    }
    this.shadowRoot?.querySelector('slot[name="chat"]')?.toggleAttribute("hidden", Boolean(adapter));
  }

  #isWorkspaceHost(): boolean {
    return Boolean(
      this.#workspaceAgentAdapter || (this.#session && "kind" in this.#session && this.#session.kind === "cookie"),
    );
  }
  #syncWorkspaceChrome(): void {
    const host = this.#isWorkspaceHost();
    this.toggleAttribute("data-workspace-host", host);
    if (host) {
      this.#hashRouter?.stop();
      this.#hashRouter = undefined;
    }
    if (this.isConnected) this.renderView();
  }

  #auth: AuthSession | undefined;
  #authUnsubscribe: (() => void) | undefined;
  #redirectCallbackHandled = false;
  #studioClient: StudioClient | undefined;
  #studioClientOverridden = false;
  #themeLoader: ThemeLoader | undefined;
  #hashRouter: Router | undefined;
  #currentPath = "/";
  #chromeBuilt = false;
  #composition: CompositionController | undefined;
  #styleEditor: MapStyleEditor | undefined;
  #styleEditorPanel: HTMLElement | undefined;
  #styleEditorUnsubscribe: (() => void) | undefined;
  public styleEditorAssetsUrl = "/maputnik/index.html";
  public get hasUnsavedStyleChanges(): boolean {
    return this.#styleEditor?.dirty ?? false;
  }
  public async openStyleEditor(_options: { layerId?: string } = {}): Promise<void> {
    if (this.#styleEditor) return;
    await this.prepareWorkspaceTurn();
    if (!this.#workspaceDraft) throw new Error("Attach an authorized map draft before editing its style.");
    if (!this.composition.state.mapSpec) {
      const binding = this.#workspaceDraft;
      const epoch = this.#workspaceAuthGeneration;
      const pending = this.#workspaceDraftQueue.then(async () => {
        const observed = await binding.initializeStyle();
        if (epoch !== this.#workspaceAuthGeneration || this.#workspaceDraft !== binding)
          throw new Error("The workspace authority changed.");
        this.composition.resetBaseline({
          ...observed,
          pins: this.composition.state.pins,
          annotations: this.composition.state.annotations,
        });
        this.#announceWorkspaceDraft();
      });
      this.#workspaceDraftQueue = pending.catch(() => undefined);
      await pending;
    }
    const canvas = this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas");
    if (!canvas) throw new Error("Open the map canvas before its style editor.");
    const generation = this.#workspaceAuthGeneration;
    const identity = this.#workspaceDraft?.identity;
    if (!identity) throw new Error("The workspace draft is unavailable.");
    const document = await canvas.editableMapStyle();
    if (generation !== this.#workspaceAuthGeneration || identity.draftId !== this.#workspaceDraft?.identity?.draftId)
      throw new Error("The workspace draft changed while opening the style editor.");
    const panel = window.document.createElement("section");
    panel.setAttribute("aria-label", "Map style editor");
    this.shadowRoot?.querySelector(".app-slots")?.prepend(panel);
    this.#styleEditorPanel = panel;
    this.shadowRoot?.querySelector(".app-slots")?.setAttribute("data-style-mode", "");
    this.#styleEditor = new MapStyleEditor({
      container: panel,
      document,
      assetsUrl: this.styleEditorAssetsUrl,
      scope: {
        kind: "map-local",
        detachesSharedStyles: this.composition.state.layers.some(
          (layer) =>
            layer.styleRef &&
            this.composition.state.styleRefs?.find((ref) => ref.styleId === layer.styleRef?.styleId)?.body ===
              undefined,
        ),
      },
      layers: this.composition.state.layers.map((layer) => ({
        id: layer.id,
        sourceId: layer.sourceId,
        title: layer.title,
      })),
      selectedLayerId: _options?.layerId,
      getFields: async (sourceId) => {
        const source = this.#sourceCatalog?.find((entry) => entry.id === sourceId);
        if (!source) throw new Error("Refresh the authorized source catalog before selecting thematic fields.");
        const provider = new AuthoritativeStyleProvider({
          baseUrl: canvas.sourceAuthBaseUrl,
          ...(canvas.sourceAuthBaseUrl !== runtimeMcpBaseUrl() ? { catalogAliasBaseUrl: runtimeMcpBaseUrl() } : {}),
          documentUrl: window.document.baseURI,
          getAuth: () => this.auth,
          signal: AbortSignal.timeout(8000),
        });
        const fields = await provider.describeSource(source);
        if (generation !== this.#workspaceAuthGeneration) throw new Error("The workspace authority changed.");
        return fields;
      },
      onPreview: (style) => {
        canvas.stylePreview = style;
      },
      onDirty: (dirty) => {
        this.paintHistoryControls();
        this.dispatchEvent(
          new CustomEvent("honua-studio-style-dirty-change", { detail: { dirty }, bubbles: true, composed: true }),
        );
      },
      onSave: async (style) => {
        if (
          generation !== this.#workspaceAuthGeneration ||
          identity.draftId !== this.#workspaceDraft?.identity?.draftId
        )
          throw new Error("The workspace authority changed. Reopen the visual editor.");
        const result = await this.#dispatchCommands([{ name: "setMapStyle", mapSpec: style }]);
        if (!result.ok) throw new Error(result.reason);
        if (generation !== this.#workspaceAuthGeneration) throw new Error("The workspace authority changed.");
        return canvas.editableMapStyle();
      },
      onDiscard: async () => {
        // Explicit discard permits authoritative refresh; no stale buffer is written.
        canvas.stylePreview = undefined;
        const id = this.#workspaceDraft?.identity?.draftId;
        if (!id || generation !== this.#workspaceAuthGeneration) throw new Error("The workspace authority changed.");
        const editor = this.#styleEditor;
        this.#styleEditor = undefined;
        try {
          await this.attachWorkspaceDraft(id);
        } finally {
          if (generation === this.#workspaceAuthGeneration) this.#styleEditor = editor;
          else editor?.dispose();
        }
        if (generation !== this.#workspaceAuthGeneration) throw new Error("The workspace authority changed.");
        return canvas.editableMapStyle();
      },
    });
    const editor = this.#styleEditor;
    this.#styleEditorUnsubscribe = this.composition.subscribe(() => {
      if (editor.dirty) return;
      void canvas
        .editableMapStyle()
        .then((style) => {
          if (this.#styleEditor === editor && generation === this.#workspaceAuthGeneration)
            editor.observeSavedDocument(style);
        })
        .catch(() => {});
    });
  }
  public async closeStyleEditor(): Promise<void> {
    if (this.hasUnsavedStyleChanges) throw new Error("Save or discard visual style edits before leaving.");
    this.#disposeStyleEditor();
  }
  public async discardStyleChanges(): Promise<void> {
    await this.#styleEditor?.discard();
  }
  #disposeStyleEditor(): void {
    this.#styleEditorUnsubscribe?.();
    this.#styleEditorUnsubscribe = undefined;
    this.#styleEditor?.dispose();
    this.#styleEditor = undefined;
    this.#styleEditorPanel?.remove();
    this.#styleEditorPanel = undefined;
    this.shadowRoot?.querySelector(".app-slots")?.removeAttribute("data-style-mode");
    this.paintHistoryControls();
    const canvas = this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas");
    if (canvas) canvas.stylePreview = undefined;
    this.dispatchEvent(
      new CustomEvent("honua-studio-style-dirty-change", { detail: { dirty: false }, bubbles: true, composed: true }),
    );
  }

  #workspaceDraft: WorkspaceDraftBinding | undefined;
  #workspacePublicationReviews = new WeakMap<
    StudioContentVersion,
    {
      binding: WorkspaceDraftBinding;
      generation: number;
      itemId: string;
      versionId: string;
      contentHash: string;
      submission?: {
        commandId: string;
        requestJson: string;
        pending?: ReturnType<StudioLifecycleClient["requestPublish"]>;
      };
    }
  >();
  #workspaceAuthGeneration = 0;
  #workspaceDraftConflict = false;
  #workspaceDraftQueue: Promise<unknown> = Promise.resolve();
  #historyUnsubscribe: (() => void) | undefined;
  #historyBusy = false;
  #orchestrator: ToolCallOrchestrator | undefined;
  #liveCompositionPackageKey: string | undefined;
  #aiMapKit: HonuaAiMapKit | undefined;
  #sourceCatalog: readonly CatalogDataset[] | undefined;
  #processSourceCatalogGeneration: number | undefined;
  #catalogRequested = false;
  #catalogFromHost = false;
  #lastAuthStatus: string | undefined;
  #agentToolDefinitions: ((kit: HonuaAiMapKit) => ReadonlyArray<HonuaAgentToolDefinitionLike>) | undefined;
  #agentCertification: StudioAgentCertificationOptions | undefined;
  #agentSetupGeneration = 0;
  #publicationNoteGeneration = 0;
  #liveAgentBaseUrl = "/api";
  #liveCompositionOptions: LiveCompositionOptions | undefined;

  /** Runtime-tool seam. Server-backed composition tools are discovered from
   * the authenticated MCP endpoint by sdk-js 0.1.9; hosts/tests may replace
   * the local provider without changing chat or composition wiring. */
  public get agentToolDefinitions(): (kit: HonuaAiMapKit) => ReadonlyArray<HonuaAgentToolDefinitionLike> {
    return (
      this.#agentToolDefinitions ??
      ((kit) => kit.tools.filter((tool) => tool.mode === "read" || tool.name === "selectFeature"))
    );
  }

  public set agentToolDefinitions(provider: (kit: HonuaAiMapKit) => ReadonlyArray<HonuaAgentToolDefinitionLike>) {
    this.#agentToolDefinitions = provider;
    if (this.#orchestrator?.isLive) this.#scheduleLiveAgentSession();
  }

  /**
   * Certified-dispatch options for the live agent session: a certification
   * binding and a transcript verifier (for example the SDK's
   * `StudioAiTranscriptVerifier` over the proxy's published
   * `transcriptSigning` keys). The SDK dispatches a model-selected tool only
   * after it verifies that round's signed `transcriptProvenance`
   * (honua-io/honua-sdk-js#1748); without these options the turn ends with
   * the SDK's refusal as a turn error. Assigning rebuilds a live session, so
   * a new binding (and run nonce) takes effect on the next turn.
   */
  public get agentCertification(): StudioAgentCertificationOptions | undefined {
    return this.#agentCertification;
  }

  public set agentCertification(options: StudioAgentCertificationOptions | undefined) {
    this.#agentCertification = options;
    if (this.#orchestrator?.isLive) this.#scheduleLiveAgentSession();
  }

  /** Explicit human create action; never creates a draft as a side effect of viewing or chatting. */
  public async createWorkspaceDraft(
    packageKey: string,
  ): Promise<{ draftId: string; generation: number; packageKey: string }> {
    const key = packageKey.trim();
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(key))
      throw new Error("Use 1–200 letters, numbers, dots, dashes or underscores for the package key.");
    const generation = this.#workspaceAuthGeneration;
    await this.prepareWorkspaceTurn();
    if (generation !== this.#workspaceAuthGeneration) throw new Error("The workspace session changed.");
    const client = new StudioLifecycleClient({ baseUrl: runtimeServerBaseUrl(), auth: this.auth });
    const created = await client.createDraft({
      packageKey: key,
      envelope: {
        ...MAP_COMPOSITION_ENVELOPE,
        body: toCompositionDraftBody(createEmptyCompositionState(), key),
      },
    });
    if (generation !== this.#workspaceAuthGeneration) throw new Error("The workspace session changed.");
    await this.attachWorkspaceDraft(created.draftId);
    const identity = this.#workspaceDraft?.identity;
    if (!identity || identity.draftId !== created.draftId) throw new Error("The created draft was not attached.");
    return identity;
  }

  /** Read the authorized durable draft after a native turn. Does not execute tools. */
  public attachWorkspaceDraft(draftId: string): Promise<void> {
    const generation = this.#workspaceAuthGeneration;
    const run = this.#workspaceDraftQueue.then(() => this.#observeWorkspaceDraft(draftId, generation));
    this.#workspaceDraftQueue = run.catch(() => undefined);
    return run;
  }

  /** Save the active server draft as an immutable version; never publish it. */
  public saveWorkspaceVersion(): Promise<StudioContentVersion> {
    return this.#withWorkspaceLifecycle(async (client, identity, current) => {
      const version = await client.saveAsVersion(identity.draftId);
      current();
      return version;
    });
  }

  /** List versions belonging to the active draft's server-owned content item. */
  public listWorkspaceVersions(): Promise<readonly StudioContentVersion[]> {
    return this.#withWorkspaceLifecycle(async (client, identity, current) => {
      const draft = await client.getDraft(identity.draftId);
      current();
      const result = await client.listVersions(draft.itemId);
      current();
      return result.versions;
    });
  }

  /** Read the exact saved version for the host's human publication review. Never submits. */
  public reviewWorkspacePublication(versionId: string): Promise<StudioContentVersion> {
    return this.#withWorkspaceLifecycle(async (client, identity, current, generation) => {
      const draft = await client.getDraft(identity.draftId);
      current();
      const version = await client.getVersion(draft.itemId, versionId);
      current();
      if (
        version.itemId !== draft.itemId ||
        version.versionId !== versionId ||
        version.packageKey !== identity.packageKey ||
        !version.contentHash
      )
        throw new Error("The publication version does not belong to the active map.");
      const review = Object.freeze(structuredClone(version));
      this.#workspacePublicationReviews.set(review, {
        binding: this.#workspaceDraft!,
        generation,
        itemId: version.itemId,
        versionId: version.versionId,
        contentHash: version.contentHash,
      });
      return review;
    });
  }

  /**
   * Human host action only. The host must persist commandId before submission and
   * retain it and the exact input after a lost response. Replays use server policy
   * and fresh authorization; a receipt awaiting approval is never completion.
   */
  public async publishWorkspaceVersion(
    review: StudioContentVersion,
    request: StudioPublishRequestInput,
    commandId: string,
  ): ReturnType<StudioLifecycleClient["requestPublish"]> {
    const state = this.#workspacePublicationReviews.get(review);
    if (!state) throw new Error("Review the saved version in the current workspace before publishing.");
    const requireReview = () => {
      if (state.binding !== this.#workspaceDraft || state.generation !== this.#workspaceAuthGeneration)
        throw new Error("Review the saved version again in the original workspace session before publishing.");
    };
    requireReview();
    if (typeof commandId !== "string" || commandId.trim() !== commandId || !/^[A-Za-z0-9_-]{1,128}$/.test(commandId))
      throw new Error("A stable publication command ID is required.");
    // Keep only canonical publication inputs; browser callers cannot add approval fields.
    const requestJson = JSON.stringify({
      intent: request.intent,
      warningAcknowledgement: request.warningAcknowledgement,
    });
    if (state.submission && (state.submission.commandId !== commandId || state.submission.requestJson !== requestJson))
      throw new Error("Check the original publication before changing its command or publication settings.");
    state.submission ??= { commandId, requestJson };
    const submission = state.submission;
    if (submission.pending) return submission.pending;
    const pending = this.#withWorkspaceLifecycle(async (client, _identity, current) => {
      requireReview();
      const version = await client.getVersion(state.itemId, state.versionId);
      current();
      requireReview();
      if (
        version.itemId !== state.itemId ||
        version.versionId !== state.versionId ||
        version.contentHash !== state.contentHash
      )
        throw new Error("The saved version changed after publication review.");
      const receipt = await client.requestPublish(
        state.itemId,
        state.versionId,
        JSON.parse(submission.requestJson) as StudioPublishRequestInput,
        submission.commandId,
      );
      current();
      requireReview();
      return receipt;
    });
    submission.pending = pending;
    try {
      return await pending;
    } finally {
      submission.pending = undefined;
    }
  }

  /** Reopen a version of the active map as a new draft, preserving the saved version. */
  public reopenWorkspaceVersion(versionId: string): Promise<void> {
    return this.#withWorkspaceLifecycle(async (client, identity, current, generation) => {
      const draft = await client.getDraft(identity.draftId);
      current();
      const reopened = await client.reopenVersion(draft.itemId, versionId);
      current();
      if (reopened.itemId !== draft.itemId || reopened.packageKey !== identity.packageKey)
        throw new Error("The reopened version does not belong to the active map.");
      await this.#observeWorkspaceDraft(reopened.draftId, generation);
    });
  }

  async #withWorkspaceLifecycle<T>(
    action: (
      client: StudioLifecycleClient,
      identity: { draftId: string; generation: number; packageKey: string },
      current: () => void,
      generation: number,
    ) => Promise<T>,
  ): Promise<T> {
    const binding = this.#workspaceDraft;
    const generation = this.#workspaceAuthGeneration;
    const identity = binding?.identity;
    if (!binding || !identity) throw new Error("Open a map draft before using saved versions.");
    await this.prepareWorkspaceTurn();
    const current = () => {
      if (generation !== this.#workspaceAuthGeneration || binding !== this.#workspaceDraft)
        throw new Error("The workspace session or map changed.");
      if (this.#historyBusy || this.#workspaceDraftConflict || this.#hasDirtyWorkspaceForm())
        throw new Error("Save or explicitly reload pending Studio edits before using saved versions.");
    };
    const run = this.#workspaceDraftQueue.then(async () => {
      current();
      return action(
        new StudioLifecycleClient({ baseUrl: runtimeServerBaseUrl(), auth: this.auth }),
        identity,
        current,
        generation,
      );
    });
    this.#workspaceDraftQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #observeWorkspaceDraft(draftId: string, generation: number): Promise<void> {
    if (generation !== this.#workspaceAuthGeneration) throw new Error("The workspace session changed.");
    if (this.#hasDirtyWorkspaceForm()) throw new Error("Save pending Studio edits before attaching a draft.");
    const previous = this.#workspaceDraft?.identity;
    // Observe prospectively: a refused read must not advance the active binding's generation.
    const binding = new WorkspaceDraftBinding(
      new StudioLifecycleClient({ baseUrl: runtimeServerBaseUrl(), auth: this.auth }),
    );
    const state = await binding.observe(draftId);
    if (generation !== this.#workspaceAuthGeneration) throw new Error("The workspace session changed.");
    if (this.#hasDirtyWorkspaceForm()) throw new Error("Save pending Studio edits before attaching a draft.");
    // A same-principal lease can renew while the prospective GET is in flight.
    // Adopt its observed state with the current transport, not the expired lease.
    binding.rebind(new StudioLifecycleClient({ baseUrl: runtimeServerBaseUrl(), auth: this.auth }));
    this.#workspaceDraft = binding;
    this.#workspaceDraftConflict = false;
    const reset = previous?.draftId !== draftId || previous?.generation !== binding.identity?.generation;
    const attach = reset
      ? this.composition.resetBaseline.bind(this.composition)
      : this.composition.replaceState.bind(this.composition);
    attach({
      ...state,
      pins: this.composition.state.pins,
      annotations: this.composition.state.annotations,
    });
    this.#announceWorkspaceDraft();
  }

  /** Idle observation for external draft changes; never discard an unsaved form value. */
  public async refreshWorkspaceDraft(): Promise<boolean> {
    const binding = this.#workspaceDraft;
    const generation = this.#workspaceAuthGeneration;
    await this.#workspaceDraftQueue;
    const identity = binding?.identity;
    if (!identity || binding !== this.#workspaceDraft || this.#historyBusy || this.#workspaceDraftConflict)
      return false;
    if (this.#hasDirtyWorkspaceForm()) return false;
    try {
      await this.attachWorkspaceDraft(identity.draftId);
    } catch (error) {
      if (
        generation !== this.#workspaceAuthGeneration ||
        this.#historyBusy ||
        this.#workspaceDraftConflict ||
        this.#hasDirtyWorkspaceForm()
      )
        return false;
      throw error;
    }
    return generation === this.#workspaceAuthGeneration && !this.#hasDirtyWorkspaceForm();
  }

  /** Flush accepted human edits before the host captures a durable native turn. */
  public async prepareWorkspaceTurn(): Promise<
    { draftId: string; generation: number; packageKey: string } | undefined
  > {
    await this.#styleEditor?.settled();
    await this.#workspaceDraftQueue;
    if (this.#historyBusy || this.#workspaceDraftConflict || this.#hasDirtyWorkspaceForm()) {
      throw new Error("Save or explicitly reload the pending Studio edits before sending a workspace turn.");
    }
    return this.#workspaceDraft?.identity;
  }

  #hasDirtyWorkspaceForm(): boolean {
    if (this.hasUnsavedStyleChanges) return true;
    const dirty = (root: ParentNode): boolean => {
      for (const element of root.querySelectorAll("*")) {
        if (element.tagName === "HONUA-STUDIO-CHAT" || this.#styleEditorPanel?.contains(element)) continue;
        if (
          (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
          (element.value !== element.defaultValue ||
            (element instanceof HTMLInputElement && element.checked !== element.defaultChecked))
        )
          return true;
        if (element instanceof HTMLSelectElement) {
          const explicitDefault = [...element.options].some((option) => option.defaultSelected);
          if (
            [...element.options].some(
              (option, index) =>
                option.selected !== (option.defaultSelected || (!explicitDefault && !element.multiple && index === 0)),
            )
          )
            return true;
        }
        if (element instanceof HTMLElement && element.isContentEditable) return true;
        if (element.shadowRoot && dirty(element.shadowRoot)) return true;
      }
      return false;
    };
    return dirty(this) || Boolean(this.shadowRoot && dirty(this.shadowRoot));
  }

  #announceWorkspaceDraft(): void {
    this.dispatchEvent(
      new CustomEvent("honua-workspace-draft-change", {
        bubbles: true,
        composed: true,
        detail: this.#workspaceDraft?.identity,
      }),
    );
  }

  /** Undo/redo in the authoritative draft before advancing the visible history. */
  public async applyHistoryAction(action: "undo" | "redo"): Promise<boolean> {
    if (this.#historyBusy || this.hasUnsavedStyleChanges) return false;
    const authGeneration = this.#workspaceAuthGeneration;
    this.#historyBusy = true;
    this.paintHistoryControls();
    try {
      let applied: boolean;
      if (this.#workspaceDraft) {
        const target = action === "undo" ? this.composition.history.peekUndo() : this.composition.history.peekRedo();
        if (!target) return false;
        const binding = this.#workspaceDraft;
        const generation = this.#workspaceAuthGeneration;
        const run = this.#workspaceDraftQueue.then(async () => {
          if (generation !== this.#workspaceAuthGeneration) throw new Error("The workspace session changed.");
          const observed = await binding.replace(target);
          if (generation !== this.#workspaceAuthGeneration) throw new Error("The workspace session changed.");
          const changed = action === "undo" ? this.composition.undo() : this.composition.redo();
          this.composition.replaceState(observed);
          this.#announceWorkspaceDraft();
          return changed;
        });
        this.#workspaceDraftQueue = run.catch(() => undefined);
        applied = await run;
      } else applied = await this.toolCallOrchestrator.applyHistoryAction(action);
      const { draftId, generation } = this.toolCallOrchestrator;
      if (applied && draftId && generation !== undefined) {
        this.querySelector<HonuaStudioChatElement>("honua-studio-chat")?.agentSession?.attachDraft({
          draftId,
          generation,
        });
      }
      const status = this.shadowRoot?.querySelector('[data-testid="history-status"]');
      if (status)
        status.textContent = applied
          ? action === "undo"
            ? "Undone"
            : "Redone"
          : `Unable to ${action}. Review the activity log.`;
      return applied;
    } catch (error) {
      if (this.#workspaceDraft && authGeneration === this.#workspaceAuthGeneration) this.#workspaceDraftConflict = true;
      const status = this.shadowRoot?.querySelector('[data-testid="history-status"]');
      if (status) status.textContent = error instanceof Error ? error.message : `Unable to ${action}.`;
      return false;
    } finally {
      this.#historyBusy = false;
      this.paintHistoryControls();
    }
  }

  /** Configure the SDK verifier with verification keys explicitly trusted by the host. */
  public configureAgentTranscriptVerification(
    certification: StudioAiTranscriptCertification,
    manifest: StudioAiTranscriptSigningManifest,
  ): void {
    this.agentCertification = {
      certification,
      transcriptVerifier: new StudioAiTranscriptVerifier({ manifest, replayStore: new InMemoryStudioAiReplayStore() }),
    };
  }

  /**
   * Host-injected session adapter — the primary embed injection path
   * (docs/embed-session.md). `getToken()`/`onExpired()`, matching
   * `window.__HONUA_STUDIO_HOST_SESSION__`'s documented fallback shape
   * exactly (honua-studio#4 REQ-003) — a host may use either, never both.
   * Unset means: use the window global if present, else run standalone
   * OIDC. Assigning this after the element is already connected tears down
   * and rebuilds `.auth` (and disposes the previous session cleanly).
   */
  public get session(): SessionAdapter | undefined {
    return this.#session;
  }

  public set session(session: SessionAdapter | undefined) {
    if (this.#session === session) return;
    if (session && "kind" in session && session.kind === "cookie") verifiedSourcePathBase(session.sourcePathBase);
    const previous = this.#session;
    const hadAuthority = Boolean(previous || this.#auth || this.#workspaceDraft);
    const samePrincipal =
      previous &&
      session &&
      "kind" in previous &&
      previous.kind === "cookie" &&
      "kind" in session &&
      session.kind === "cookie" &&
      previous.principalId &&
      previous.principalId === session.principalId &&
      previous.environmentId === session.environmentId &&
      verifiedSourcePathBase(previous.sourcePathBase) === verifiedSourcePathBase(session.sourcePathBase);
    if (!samePrincipal) {
      this.#disposeStyleEditor();
      this.#workspaceAuthGeneration++;
      if (hadAuthority) {
        // Cached human descriptor metadata belongs to the former authority too.
        this.#sourceCatalog = undefined;
        this.#processSourceCatalogGeneration = undefined;
        this.#catalogRequested = false;
        this.#aiMapKit = undefined;
        const previousCanvas = this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas");
        if (previousCanvas) previousCanvas.sourceCatalog = undefined;
      }
      this.#workspaceDraft = undefined;
      this.#workspaceDraftConflict = false;
      this.composition.resetBaseline(createEmptyCompositionState());
      if (hadAuthority) this.#announceWorkspaceDraft();
    }
    this.#session = session;
    this.#syncWorkspaceChrome();
    const sourceCanvas = this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas");
    if (sourceCanvas)
      sourceCanvas.sourceAuthBaseUrl =
        session && "kind" in session && session.kind === "cookie"
          ? verifiedSourcePathBase(session.sourcePathBase)
          : runtimeMcpBaseUrl();
    if (!this.isConnected) {
      this.#authUnsubscribe?.();
      this.#authUnsubscribe = undefined;
      disposeAuthSession(this.#auth);
      this.#auth = undefined;
      if (!this.#studioClientOverridden) this.#studioClient = undefined;
      return;
    }
    this.resetAuth();
    // A host-owned catalog does not reload on session replacement. Invalidate
    // its widget rows explicitly rather than leaving another session's data visible.
    for (const canvas of this.querySelectorAll<HonuaStudioCanvasElement>("honua-studio-canvas")) {
      canvas.widgetDeck?.refreshSession();
    }
    // Both live clients capture the AuthSession supplied at construction.
    // Replace them explicitly when an embedding host swaps credentials;
    // a host-owned catalog intentionally does not refresh and therefore
    // cannot be relied on to incidentally rebuild the agent session.
    if (this.#orchestrator?.isLive && this.#liveCompositionOptions) {
      this.#replaceLiveCompositionSession(this.#liveCompositionOptions);
    }
    // auth.mode may have just changed (standalone <-> host-adapter), and
    // the chrome's sign-in/out button markup depends on that — a
    // paintAuthControls()-only refresh (what auth.subscribe's listener
    // already triggers on every dispatch) only toggles [hidden] on existing
    // buttons, it can't add/remove them. Force a full chrome rebuild so a
    // `.session` reassignment after connection — a capability #4's original
    // app.ts never needed, since it built one fixed AuthSession per app
    // lifetime — is actually correct, not just "usually fine because nobody
    // does this". Also re-render the route content ONCE so it picks up the
    // new `.auth` (route render functions receive `auth` as a fresh
    // argument, not a live binding) — deliberately NOT done from inside
    // auth.subscribe's own listener below; see that listener's comment.
    // A cookie lease changes credentials, not the editor's DOM or authority.
    // Retain the iframe so uncommitted field text survives renewal.
    if (!samePrincipal) this.#chromeBuilt = false;
    this.renderChrome();
    // renderChrome() just replaced the shadow DOM wholesale — in hash mode
    // that orphans any existing #hashRouter's captured #view node (see
    // #setupHashRouter's doc), so rebuild it against the fresh one; its
    // own `.start()` re-renders the current route with the new `.auth` in
    // the process. In host mode there's no router to rebind — renderView()
    // already re-queries `#view` live on every call.
    if (this.routingMode === "hash") this.#setupHashRouter();
    else this.renderView();
    // honua-studio#23: the composition map resolves its sources against the
    // catalog, which is bearer-gated — so a new session means a new catalog
    // (and, on a standalone boot, the first one that can be read at all).
    this.#refreshSourceCatalog();
  }

  /**
   * The resolved, live `AuthSession` this element (and, through
   * `src/elements/session.ts`'s `resolveInjectedAuth`, every descendant
   * placeholder) actually drives its UI from — standalone OIDC or a
   * `HostAdapterAuthSession` wrapping `.session`, decided by
   * `createAuthSession()`. Read-only; constructed lazily.
   */
  public get auth(): AuthSession {
    return this.#auth ?? this.resetAuth();
  }

  /** The `StudioClient` powering the catalog/packages view — bearer-attached via `.auth`. Defaults to a fresh instance reading from `/api`; override for fixtures/tests. */
  public get studioClient(): StudioClient {
    if (!this.#studioClient)
      this.#studioClient = new StudioClient(runtimeServerBaseUrl(), this.auth, runtimeMcpBaseUrl());
    return this.#studioClient;
  }

  public set studioClient(client: StudioClient) {
    this.#studioClient = client;
    this.#studioClientOverridden = true;
    this.renderView();
  }

  /**
   * The composition engine state (honua-studio#7/#8) the auto-composed
   * `<honua-studio-canvas>` renders and `.toolCallOrchestrator` mutates.
   * Lazily created (empty state) on first access; persists for this
   * element's lifetime — reconnecting does not reset it.
   */
  public get composition(): CompositionController {
    if (!this.#composition) this.#composition = new CompositionController(createEmptyCompositionState());
    return this.#composition;
  }

  /**
   * The MCP tool-call orchestrator (honua-studio#7) wired to `.composition`
   * and, when the auto-composed `<honua-studio-chat>` is present, that
   * chat's own `ActivityLog` — so composition entries interleave with chat
   * entries in a shared `<honua-studio-activity-log>`. Fixture/offline mode
   * (the local reducer only) until `.enableLiveComposition()` attaches a
   * live MCP session (AD-8's authoritative server-draft path).
   */
  public get toolCallOrchestrator(): ToolCallOrchestrator {
    if (!this.#orchestrator) {
      const chat = this.querySelector<HonuaStudioChatElement>("honua-studio-chat");
      this.#orchestrator = new ToolCallOrchestrator({ controller: this.composition, activityLog: chat?.activityLog });
    }
    return this.#orchestrator;
  }

  /**
   * The catalog the composition map resolves layer sources against
   * (honua-studio#23) and the AI map kit advertises to a model. Fetched once
   * per connection from `.studioClient`; a host that already has the listing
   * (or wants to constrain it) may assign it instead, which also skips the
   * fetch.
   */
  /** Actual published choices for the canonical GP layer picker; no map focus is inferred. */
  public async listProcessSources(): Promise<readonly { id: string; title: string }[]> {
    const generation = this.#workspaceAuthGeneration;
    const auth = this.auth;
    const client = this.#studioClientOverridden
      ? this.studioClient
      : new StudioClient(runtimeServerBaseUrl(), auth, runtimeMcpBaseUrl());
    const catalog = await client.listCatalog();
    if (generation !== this.#workspaceAuthGeneration || auth !== this.auth)
      throw new Error("The workspace authority changed.");
    this.#applySourceCatalog(catalog);
    this.#processSourceCatalogGeneration = generation;
    return catalog
      .filter(
        (source) => typeof source.locator?.serviceId === "string" && Number.isSafeInteger(source.locator?.layerId),
      )
      .map((source) => ({ id: source.id, title: source.title ?? source.id }));
  }

  public async resolveProcessSource(
    sourceId: string,
  ): Promise<{ processLayerId?: number; unavailableReason?: string }> {
    const generation = this.#workspaceAuthGeneration;
    const source = this.#sourceCatalog?.find((entry) => entry.id === sourceId);
    if (!source || this.#processSourceCatalogGeneration !== generation)
      throw new Error("Refresh the authorized source choices before selecting a process layer.");
    const baseUrl =
      this.#session && "kind" in this.#session && this.#session.kind === "cookie"
        ? verifiedSourcePathBase(this.#session.sourcePathBase)
        : runtimeMcpBaseUrl();
    const provider = new AuthoritativeStyleProvider({
      baseUrl,
      ...(baseUrl !== runtimeMcpBaseUrl() ? { catalogAliasBaseUrl: runtimeMcpBaseUrl() } : {}),
      documentUrl: window.document.baseURI,
      getAuth: () => this.auth,
      signal: AbortSignal.timeout(8000),
    });
    const result = await provider.resolveProcessSource(source);
    if (generation !== this.#workspaceAuthGeneration) throw new Error("The workspace authority changed.");
    return result;
  }

  /** Read-only style discovery pinned to this human authority; lease renewal may refresh transport only. */
  public createWorkspaceStyleProvider(
    options: { readonly getAuthority?: () => unknown } = {},
  ): AuthoritativeStyleProvider {
    const generation = this.#workspaceAuthGeneration;
    const authority = options.getAuthority?.();
    const baseUrl =
      this.#session && "kind" in this.#session && this.#session.kind === "cookie"
        ? verifiedSourcePathBase(this.#session.sourcePathBase)
        : runtimeMcpBaseUrl();
    return new AuthoritativeStyleProvider({
      baseUrl,
      ...(baseUrl !== runtimeMcpBaseUrl() ? { catalogAliasBaseUrl: runtimeMcpBaseUrl() } : {}),
      documentUrl: window.document.baseURI,
      getAuth: () => {
        if (generation !== this.#workspaceAuthGeneration || options.getAuthority?.() !== authority)
          throw new Error("The selected style workspace authority changed.");
        return this.auth;
      },
    });
  }

  public get sourceCatalog(): readonly CatalogDataset[] | undefined {
    return this.#sourceCatalog;
  }

  public set sourceCatalog(catalog: readonly CatalogDataset[] | undefined) {
    // A host that assigns the catalog owns it: no fetch overwrites it.
    // Lease renewal retains it; another authority must supply a fresh catalog.
    this.#catalogFromHost = true;
    this.#catalogRequested = true;
    this.#applySourceCatalog(catalog);
  }

  async #addCatalogSource(dataset: CatalogDataset): Promise<void> {
    if (!this.#sourceCatalog?.some((entry) => entry.id === dataset.id)) {
      this.#applySourceCatalog([...(this.#sourceCatalog ?? []), dataset]);
    }
    const result = await this.#dispatchCommands([
      { name: "addLayer", layer: { id: dataset.id, sourceId: dataset.id, title: dataset.title } },
    ]);
    if (!result.ok) throw new Error(result.reason);
  }

  #applySourceCatalog(catalog: readonly CatalogDataset[] | undefined): void {
    this.#sourceCatalog = catalog;
    // The kit advertises the catalog, so it has to be rebuilt around a new one.
    this.#aiMapKit = undefined;
    const canvas = this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas");
    if (canvas) canvas.sourceCatalog = catalog;
    if (this.isConnected && this.#orchestrator?.isLive) this.#scheduleLiveAgentSession();
  }

  /**
   * Fetches the catalog once and hands it to the canvas. Failure is
   * deliberately silent at this level: no catalog means composed layers
   * report as "not renderable" in the canvas (with a reason and a readout
   * row), which is a better failure than a shell that refuses to boot
   * because a listing endpoint was unreachable.
   */
  async #loadSourceCatalog(): Promise<void> {
    if (this.#catalogRequested || this.#sourceCatalog !== undefined) return;
    // Never fetch while signed out. `StudioClient` turns a second 401 into a
    // `StudioSessionExpiredError` and the session records the failure, so an
    // eager anonymous fetch would flip a freshly-booted, never-signed-in
    // shell from "Signed out" to "Session expired" — a false and alarming
    // claim, and one `test/playwright/boot-mock.spec.mjs` rightly fails on.
    // `#onAuthStatusChanged` calls back here the moment a session exists.
    const status = this.auth.getState().status;
    if (status !== "fresh" && status !== "refreshing") return;
    this.#catalogRequested = true;
    try {
      const generation = this.#workspaceAuthGeneration;
      const auth = this.auth;
      const catalog = await this.studioClient.listCatalog();
      if (!this.isConnected || generation !== this.#workspaceAuthGeneration || auth !== this.auth) return;
      this.#applySourceCatalog(catalog);
    } catch {
      // See the doc above — an unreachable catalog degrades the map, it does
      // not break the shell. It is also *expected* on a standalone boot: the
      // catalog is bearer-gated and the shell renders before sign-in, which
      // is exactly what `#refreshSourceCatalog` below exists to recover from.
    }
  }

  /**
   * Re-fetches the catalog after the session changed — a new session can mean
   * a different server, a different tenant, or simply the first one that can
   * actually read the catalog at all.
   *
   * Called from two places: the `.session` setter (a host swapping the
   * adapter) and an auth **status transition** into `"fresh"`. The transition
   * gate is not incidental: `AuthSession.getAccessToken()` dispatches a state
   * change on every single call (see `resetAuth`'s comment about the render
   * loop this already caused once) and `listCatalog()` calls it, so retrying
   * on every dispatch would be an unbounded fetch loop.
   */
  #refreshSourceCatalog(): void {
    if (this.#catalogFromHost) return;
    this.#sourceCatalog = undefined;
    this.#catalogRequested = false;
    void this.#loadSourceCatalog();
  }

  #onAuthStatusChanged(): void {
    if (!this.isConnected) return;
    const status = this.#auth?.getState().status;
    if (status === this.#lastAuthStatus) return;
    this.#lastAuthStatus = status;
    if (status !== "fresh" || this.#sourceCatalog !== undefined) return;
    this.#refreshSourceCatalog();
  }

  /**
   * The SDK AI map kit (honua-studio#23 REQ-002) over `.composition` —
   * `createHonuaAiMapKit`'s tool definitions (Honua/MCP/OpenAI shapes),
   * capability-aware map context, system prompt, and policy-gated
   * `execute()`. Lazily built and rebuilt whenever the catalog it advertises
   * changes, so a model driving Studio can only reference sources the server
   * actually published (#1 REQ-001). See `../map/agent-map-kit.ts` for the
   * sdk-js#1259 `StudioAgentSession` seam.
   */
  public get aiMapKit(): HonuaAiMapKit {
    if (!this.#aiMapKit) {
      this.#aiMapKit = createStudioAiMapKit({
        controller: this.composition,
        ...(this.#sourceCatalog !== undefined ? { catalog: this.#sourceCatalog } : {}),
      });
    }
    return this.#aiMapKit;
  }

  /**
   * Attaches a live MCP session so subsequent chat tool-call intents mutate
   * a real Studio lifecycle draft via `honua_studio_*` tools (AD-8's
   * authoritative path) instead of applying through the local reducer only.
   * Bearer-attached via `.auth`, same as `.studioClient`. A host that never
   * calls this stays in fixture/offline mode — the only mode CI and the
   * default dev/demo experience use (NFR-001).
   *
   * honua-studio#23 REQ-004: this is still the public API, but it is no
   * longer only reachable from `window.__honuaStudioApp`. The shell's own
   * "Go live…" control in the header calls exactly this method, and every
   * mode change (either direction) is announced as
   * `honua-studio-composition-mode-change` and recorded in the shared
   * activity log.
   */
  public enableLiveComposition(options: {
    readonly baseUrl?: string;
    readonly packageKey: string;
    readonly family?: StudioPackageFamilyWire;
    readonly schemaVersion?: string;
  }): void {
    const liveOptions: LiveCompositionOptions = {
      baseUrl: options.baseUrl ?? runtimeMcpBaseUrl(),
      packageKey: options.packageKey,
      ...(options.family !== undefined ? { family: options.family } : {}),
      ...(options.schemaVersion !== undefined ? { schemaVersion: options.schemaVersion } : {}),
    };
    this.#liveCompositionOptions = liveOptions;
    this.#replaceLiveCompositionSession(liveOptions);
    this.#liveCompositionPackageKey = options.packageKey;
    this.#announceCompositionMode({
      mode: "live",
      packageKey: options.packageKey,
      ...(options.family !== undefined ? { family: options.family } : {}),
    });
  }

  #replaceLiveCompositionSession(options: LiveCompositionOptions): void {
    this.#agentSetupGeneration += 1;
    this.querySelector<HonuaStudioChatElement>("honua-studio-chat")?.detachAgentSession();
    this.#liveAgentBaseUrl = options.baseUrl;
    this.toolCallOrchestrator.attachLiveSession({
      client: new McpClient({ baseUrl: options.baseUrl, auth: this.auth }),
      packageKey: options.packageKey,
      ...(options.family !== undefined ? { family: options.family } : {}),
      ...(options.schemaVersion !== undefined ? { schemaVersion: options.schemaVersion } : {}),
    });
    this.#scheduleLiveAgentSession();
  }

  #scheduleLiveAgentSession(): void {
    const setup = this.#attachLiveAgentSession(this.#liveAgentBaseUrl);
    const generation = this.#agentSetupGeneration;
    void setup.catch((error) => {
      if (generation !== this.#agentSetupGeneration) return;
      this.disableLiveComposition();
      const chat = this.querySelector<HonuaStudioChatElement>("honua-studio-chat");
      chat?.activityLog.append("assistant_turn_error", {
        errorMessage: error instanceof Error ? error.message : String(error),
        phase: "agent-session-setup",
      });
    });
  }

  /**
   * Returns composition to fixture/offline mode — the default the whole app
   * boots in (REQ-005). Detaching does NOT roll back state the server
   * already accepted; it stops future tool calls going to the server, which
   * is the honest thing for a control that says "return to fixture mode".
   */
  public disableLiveComposition(): void {
    if (!this.toolCallOrchestrator.isLive) return;
    this.toolCallOrchestrator.detachLiveSession();
    this.#agentSetupGeneration += 1;
    this.querySelector<HonuaStudioChatElement>("honua-studio-chat")?.detachAgentSession();
    const chat = this.querySelector<HonuaStudioChatElement>("honua-studio-chat");
    if (chat) chat.agentSessionPending = false;
    this.#liveCompositionPackageKey = undefined;
    this.#liveCompositionOptions = undefined;
    this.#announceCompositionMode({ mode: "fixture" });
  }

  #announceCompositionMode(detail: HonuaStudioCompositionModeChangeDetail): void {
    this.paintLiveCompositionControls();
    const chat = this.querySelector<HonuaStudioChatElement>("honua-studio-chat");
    chat?.activityLog.append("composition_mode_changed", { ...detail });
    this.dispatchTypedEvent<HonuaStudioCompositionModeChangeDetail>("honua-studio-composition-mode-change", detail);
  }

  /** `"hash"` (default, self-owned) or `"host"` (host-owned URL — see docs/element-contract.md § Routing). */
  public get routingMode(): HonuaStudioRoutingMode {
    return this.getAttribute("routing-mode") === "host" ? "host" : "hash";
  }

  public set routingMode(mode: HonuaStudioRoutingMode) {
    this.setAttribute("routing-mode", mode);
  }

  /**
   * The path currently rendered. In `"hash"` mode this mirrors
   * `window.location.hash` and is read-only in practice (the element is the
   * source of truth). In `"host"` mode the host is the source of truth:
   * assign this (or set the `current-path` attribute) whenever the host's
   * own router navigates, and listen for `honua-studio-navigate` to learn
   * when the element wants to navigate.
   */
  public get currentPath(): string {
    return this.#currentPath;
  }

  public set currentPath(path: string) {
    // Delegates entirely to the `current-path` attribute + attributeChangedCallback
    // — the single place base-path stripping happens (see stripBasePath()
    // below). honua-studio#5 finding: this setter used to normalize and
    // write `#currentPath` directly, WITHOUT stripping base-path, which
    // then immediately overwrote the correctly-stripped value
    // attributeChangedCallback had just computed for the same call —
    // harness/blazor-host's watchdog remount path calls `mount()` (sets the
    // attribute directly, base-path correctly stripped) followed by
    // `syncCurrentPath()` (used this setter, silently un-stripping it back
    // to the raw host path) on every single resync, so `<honua-studio-app>`
    // always rendered its home route instead of the one the URL said.
    if (this.getAttribute("current-path") === path) return;
    this.setAttribute("current-path", path);
  }

  public get themeSet(): ThemeSet {
    const value = this.getAttribute("data-theme-set");
    return value === "console" ? "console" : "standalone";
  }

  public set themeSet(value: ThemeSet) {
    (this.#themeLoader ?? this.ensureThemeLoader()).setThemeSet(value);
  }

  public get themeMode(): ThemeMode {
    const value = this.getAttribute("data-theme");
    return value === "light" || value === "dark" ? value : "auto";
  }

  public set themeMode(value: ThemeMode) {
    (this.#themeLoader ?? this.ensureThemeLoader()).setThemeMode(value);
  }

  public get themeSwitcherVisibility(): HonuaStudioThemeSwitcherVisibility {
    return this.getAttribute("theme-switcher") === "hidden" ? "hidden" : "visible";
  }

  public set themeSwitcherVisibility(value: HonuaStudioThemeSwitcherVisibility) {
    this.setAttribute("theme-switcher", value);
  }

  private ensureThemeLoader(): ThemeLoader {
    if (!this.#themeLoader) {
      this.#themeLoader = new ThemeLoader(this, safeLocalStorage());
    }
    return this.#themeLoader;
  }

  /** (Re)builds `.auth` from the current `.session`, disposing whatever was there before. Always leaves `#auth` set; returns it. */
  private resetAuth(): AuthSession {
    this.#authUnsubscribe?.();
    this.#authUnsubscribe = undefined;
    disposeAuthSession(this.#auth);
    if (!this.#studioClientOverridden) this.#studioClient = undefined;

    const auth = createAuthSession({ hostAdapter: this.#session });
    this.#auth = auth;
    this.#workspaceDraft?.rebind(new StudioLifecycleClient({ baseUrl: runtimeServerBaseUrl(), auth }));
    // honua-studio#5 finding: paintAuthControls() ONLY here — never
    // renderView(). AuthSession implementations dispatch a state change on
    // EVERY getAccessToken() call, even when the token is unchanged
    // (HostAdapterAuthSession.getAccessToken() unconditionally re-dispatches
    // "credential-issued" — see src/auth/host-session.ts). renderView()
    // re-invokes the current route's render function, and the home route
    // (../pages/home.js) calls client.listCatalog()/listPackages(), each of
    // which calls auth.getAccessToken() to attach a bearer header — which
    // dispatches again — which (had this listener also called renderView())
    // would re-invoke the route render, re-fetch, re-dispatch, forever: a
    // tight synchronous-enough loop that hung page load solid in testing,
    // with no thrown error to surface it. The route-level view already
    // manages its OWN reactivity to auth changes via its own independent
    // `auth.subscribe()` (renderHome's `onAuthState`, unsubscribing itself
    // once its own DOM is replaced) — this top-level listener's only job is
    // the header's status label / sign-in-out button visibility.
    this.#authUnsubscribe = auth.subscribe(() => {
      this.paintAuthControls();
      this.#onAuthStatusChanged();
    });
    if (this.isConnected) void this.completeStandaloneRedirectCallback(auth);
    return auth;
  }

  /**
   * Completes an OIDC Authorization Code redirect back to this page
   * (honua-studio#4 REQ-001), ported from #4's src/main.ts into the element
   * itself so every host gets it, not just the standalone shell's own
   * bootstrap — "no privileged internal APIs" (REQ-002) cuts both ways:
   * nothing in main.ts does anything the element can't do for itself.
   * No-op outside standalone mode or when the URL isn't a redirect
   * callback; runs at most once per connection.
   */
  private async completeStandaloneRedirectCallback(auth: AuthSession): Promise<void> {
    if (this.#redirectCallbackHandled) return;
    if (auth.mode !== "standalone" || !auth.isRedirectCallback()) return;
    this.#redirectCallbackHandled = true;
    try {
      await auth.handleRedirectCallback();
    } catch {
      // The state machine already reflects the failure (auth.subscribe's
      // listener repaints "expired"); the shell still needs to work so the
      // user can retry sign-in.
    }
    window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
  }

  /**
   * (Re)builds `this.#hashRouter` bound to the CURRENT `#view` node.
   * `routingMode === "hash"` only — stops and discards any prior router
   * first, so this is safe to call whenever `renderChrome()` has just
   * replaced the shadow DOM wholesale (`setShadowHtml` creates a brand new
   * `#view` element every rebuild).
   *
   * honua-studio#9 finding: `.session`'s reassignment-after-connect path
   * (`this.#chromeBuilt = false; this.renderChrome(); ...`) used to leave a
   * PRE-EXISTING `#hashRouter` bound to the now-DETACHED old `#view` node —
   * every hash navigation after a post-connect `.session` reassignment
   * silently rendered into an orphaned, invisible DOM tree (caught by
   * `test/playwright/lifecycle-journey.spec.mjs`'s `#/content` navigation
   * after assigning `.session` the same way `mcp-compose-journey.spec.mjs`
   * already does). Calling this after every chrome rebuild — not just the
   * first, onConnect one — closes that gap.
   */
  #setupHashRouter(): void {
    if (this.routingMode !== "hash" || this.#isWorkspaceHost()) return;
    this.#hashRouter?.stop();
    this.#hashRouter = new Router(
      this.viewRoot(),
      ROUTES.map((route) => ({
        path: route.path,
        render: (root) => {
          this.#currentPath = route.path;
          route.render(root, this.studioClient, this.auth, (dataset) => this.#addCatalogSource(dataset));
          this.syncNavCurrent();
        },
      })),
      {
        path: "*",
        render: (root) => {
          this.#currentPath = "/";
          ROUTES[0]?.render(root, this.studioClient, this.auth, (dataset) => this.#addCatalogSource(dataset));
          this.syncNavCurrent();
        },
      },
    );
    this.#hashRouter.start();
  }

  protected onConnect(signal: AbortSignal): void {
    // Auth must resolve before the FIRST renderChrome() build below — the
    // shell's markup depends on `auth.mode` (host-adapter mode renders no
    // sign-in/out controls at all, REQ-003) and its initial status label.
    this.resetAuth();

    // Chrome (and its #view outlet) must exist before the hash router below
    // can bind to it — render() (chrome + view) otherwise only runs AFTER
    // onConnect returns. renderChrome() is idempotent, so the base class's
    // own post-onConnect render() call is a cheap no-op sync, not a rebuild.
    this.renderChrome();
    this.listen(this, "keydown", (event) => {
      const key = event as KeyboardEvent;
      if (!(key.ctrlKey || key.metaKey) || key.altKey) return;
      if (
        key
          .composedPath()
          .some(
            (target) =>
              target instanceof HTMLElement &&
              (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)),
          )
      )
        return;
      const action =
        key.key.toLowerCase() === "z"
          ? key.shiftKey
            ? "redo"
            : "undo"
          : key.key.toLowerCase() === "y"
            ? "redo"
            : undefined;
      if (!action || !(action === "undo" ? this.composition.canUndo() : this.composition.canRedo())) return;
      key.preventDefault();
      void this.applyHistoryAction(action);
    });

    const loader = this.ensureThemeLoader();
    // A host that already stamped data-theme-set/data-theme (markup, or a
    // property set before this element upgraded) owns that decision — only
    // fall back to persisted/default state when neither is present, so the
    // standalone bootstrap's persistence never fights an embed's own choice.
    if (!this.hasAttribute("data-theme-set") && !this.hasAttribute("data-theme")) {
      loader.boot();
    }

    const basePath = this.getAttribute("base-path");
    if (this.routingMode === "hash") {
      this.#setupHashRouter();
    } else {
      this.#currentPath = stripBasePath(normalizePath(this.getAttribute("current-path") ?? "/"), basePath);
    }

    // Every connection gets its own default chat/canvas composition unless a
    // host has already supplied its own light-DOM children — a host that
    // wants total control over the composed surfaces skips this by pre-populating them.
    if (!this.querySelector("honua-studio-chat")) {
      const chat = document.createElement("honua-studio-chat");
      chat.slot = "chat";
      chat.setAttribute("label", "Chat");
      this.appendChild(chat);
    }
    if (!this.querySelector("honua-studio-canvas")) {
      const canvas = document.createElement("honua-studio-canvas");
      canvas.slot = "canvas";
      canvas.setAttribute("label", "Canvas");
      this.appendChild(canvas);
    }

    if (this.#workspaceAgentAdapter) this.agentSessionAdapter = this.#workspaceAgentAdapter;

    // honua-studio#7: wire the auto-composed chat/canvas pair to
    // `.composition`/`.toolCallOrchestrator` — a host that supplied its own
    // children instead is responsible for its own wiring (same "no
    // privileged internal APIs" boundary `main.ts`'s doc calls out).
    const canvas = this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas");
    if (canvas)
      canvas.sourceAuthBaseUrl =
        this.#session && "kind" in this.#session && this.#session.kind === "cookie"
          ? verifiedSourcePathBase(this.#session.sourcePathBase)
          : runtimeMcpBaseUrl();
    if (canvas && !canvas.composition) canvas.composition = this.composition;
    // honua-studio#31: a widget's intrinsic mutation is a composition command
    // like any other, so it goes through the SAME orchestrator a chat tool
    // call goes through — which is what routes `setVisibility` to
    // `honua_studio_set_layer_visibility` in live mode. Assigned only when
    // the canvas has not been given one by its host.
    if (canvas && !canvas.commandDispatch) canvas.commandDispatch = (commands) => this.#dispatchCommands(commands);
    // honua-studio#23: the canvas needs the catalog to turn a composition
    // layer's bare `sourceId` into something MapLibre can draw. Assign what
    // we already have synchronously; otherwise fetch it in the background so
    // the shell never blocks on it.
    if (canvas && this.#sourceCatalog) canvas.sourceCatalog = this.#sourceCatalog;
    else void this.#loadSourceCatalog();
    void this.toolCallOrchestrator; // constructs it now, while `<honua-studio-chat>` (if any) is resolvable for its ActivityLog.
    void this.#resumeSharePreview();
    this.listen(this, "honua-studio-chat-tool-call-result", (event) => {
      const detail = (event as CustomEvent<HonuaStudioChatToolCallResultDetail>).detail;
      void this.#handleChatToolCall(detail);
    });

    // honua-studio#9 build item 5: lifecycle actions taken in
    // `<honua-studio-lifecycle-panel>` (mounted by `../pages/content.js`
    // inside this element's OWN shadow `#view`) are logged to the SAME
    // shared activity log chat/composition entries already use — REQ-012's
    // "recorded in the activity log like any other context" extended to
    // draft/version/publish/rollback actions. `honua-studio-lifecycle-activity`
    // is `composed: true` (`dispatchTypedEvent`), so it escapes both the
    // panel's own shadow root AND this element's shadow root and reaches
    // this listener on `this`, the same way `<honua-studio-canvas>`'s
    // selection-change event already does from a light-DOM position.
    this.listen(this, "honua-studio-lifecycle-activity", (event) => {
      const detail = (event as CustomEvent<HonuaStudioLifecycleActivityDetail>).detail;
      const chat = this.querySelector<HonuaStudioChatElement>("honua-studio-chat");
      chat?.activityLog.append("lifecycle_action", { ...detail });
    });

    this.agentSessionAdapter = this.#workspaceAgentAdapter;
    if (this.#workspaceConversation.length) this.setWorkspaceConversation(this.#workspaceConversation);
    // honua-studio#10 build item 2: GP authoring/validation/preview/execution
    // actions taken in `<honua-studio-gp-panel>` (mounted by a host the same
    // way `<honua-studio-lifecycle-panel>` is — see the listener above) are
    // logged to the SAME shared activity log — REQ-012's "recorded in the
    // activity log like any other context" extended to GP actions.
    this.listen(this, "honua-studio-gp-activity", (event) => {
      const detail = (event as CustomEvent<HonuaStudioGpActivityDetail>).detail;
      const chat = this.querySelector<HonuaStudioChatElement>("honua-studio-chat");
      chat?.activityLog.append("gp_action", { ...detail });
    });

    // honua-studio#10 build item 4: "the agent can offer add-to-composition
    // (via the existing composition path)" — a completed GP job's output is
    // added the SAME way a chat tool-call intent adds any other layer:
    // through `.toolCallOrchestrator`'s `addLayer` command, never a
    // GP-specific composition code path.
    this.listen(this, "honua-studio-gp-add-output", (event) => {
      const detail = (event as CustomEvent<HonuaStudioGpAddOutputDetail>).detail;
      void this.toolCallOrchestrator.handleToolCall({
        toolName: "addLayer",
        arguments: {
          layer: { id: detail.sourceId, sourceId: detail.sourceId, ...(detail.title ? { title: detail.title } : {}) },
        },
      });
    });

    void signal; // Router cleanup goes through router.stop() in onDisconnect, not this signal — Router owns its own listener bookkeeping.
  }

  async #attachLiveAgentSession(baseUrl: string): Promise<void> {
    const chat = this.querySelector<HonuaStudioChatElement>("honua-studio-chat");
    if (chat && this.#workspaceAgentAdapter) chat.agentSessionAdapter = this.#workspaceAgentAdapter;
    if (
      !chat ||
      chat.agentSessionAdapter ||
      chat.hasCustomTransport ||
      this.auth.fetchRequest ||
      !this.toolCallOrchestrator.isLive
    )
      return;
    const setupGeneration = ++this.#agentSetupGeneration;
    chat.agentSessionPending = true;
    const draft = await this.toolCallOrchestrator.ensureLiveDraft();
    if (setupGeneration !== this.#agentSetupGeneration || !this.toolCallOrchestrator.isLive) return;
    chat.agentSessionPending = false;
    const kit = this.aiMapKit;
    const styleAuth = this.auth;
    const styleProvider = new AuthoritativeStyleProvider({
      baseUrl: runtimeMcpBaseUrl(),
      documentUrl: document.baseURI,
      getAuth: () => this.auth,
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
      /* The prompt explicitly reports unavailable styles; names never substitute for definitions. */
    }
    if (setupGeneration !== this.#agentSetupGeneration || !this.toolCallOrchestrator.isLive) return;
    if (this.auth !== styleAuth) return;
    const sessionRef: { current?: StudioAgentSession } = {};
    const certification = this.#agentCertification;
    sessionRef.current = chat.attachAgentSession({
      ...(certification?.certification ? { certification: certification.certification } : {}),
      ...(certification?.transcriptVerifier ? { transcriptVerifier: certification.transcriptVerifier } : {}),
      baseUrl,
      auth: this.auth,
      mcpClient: new StudioAuthoringMcpClient({ baseUrl, auth: this.auth, workflowView: "setup" }),
      tools: [...this.agentToolDefinitions(kit)],
      execute: async (call) => {
        // Local runtime tools execute through the kit. The compatibility
        // forwarding remains for a host that deliberately supplies the
        // visibility mutation through the public runtime-tool seam; normally
        // sdk-js discovers and dispatches it through MCP.
        const forwardedCall = call as unknown as {
          readonly name: string;
          readonly args?: Readonly<Record<string, unknown>>;
        };
        if (forwardedCall.name === "honua_studio_set_layer_visibility") {
          const result = await this.toolCallOrchestrator.handleToolCall({
            toolName: forwardedCall.name,
            arguments: forwardedCall.args ?? {},
          });
          if (result.ok && this.toolCallOrchestrator.draftId && this.toolCallOrchestrator.generation !== undefined) {
            sessionRef.current?.attachDraft({
              draftId: this.toolCallOrchestrator.draftId,
              generation: this.toolCallOrchestrator.generation,
            });
          }
          return orchestrationAgentResult(forwardedCall, result);
        }
        return kit.execute(call);
      },
      draft,
      system: () =>
        buildStudioSystemPrompt({
          draftId: this.toolCallOrchestrator.draftId,
          generation: this.toolCallOrchestrator.generation,
          catalog: this.#sourceCatalog,
          styles: styles.map(({ styleId, title, description, styleVersion, sha256 }) => ({
            styleId,
            title,
            description,
            styleVersion,
            sha256,
          })),
          composition: this.composition.state,
        }),
      onEvent: (event) => {
        if (event.type === "toolResult") {
          if (
            setupGeneration !== this.#agentSetupGeneration ||
            sessionRef.current !== chat.agentSession ||
            !this.toolCallOrchestrator.isLive
          ) {
            return;
          }
          if (event.result.draft) this.toolCallOrchestrator.acceptServerDraft(event.result.draft as StudioMcpDraft);
          if (event.result.ok && event.result.toolName === "honua_studio_propose_publication") {
            try {
              const payload = JSON.parse(event.result.content) as { status?: string; result?: unknown };
              if (payload.status !== "ok") return;
              const baseUrl = new URL(runtimeServerBaseUrl(), document.baseURI).href;
              const note = projectPublicationReceipt(payload.result, baseUrl);
              if (note) {
                this.#publicationNoteGeneration += 1;
                chat.shareNote = note.text;
              }
            } catch {
              // A malformed receipt must not turn assistant text into a publication link.
            }
          }
        }
      },
    });
  }

  /**
   * Runs a widget's intrinsic mutation through `.toolCallOrchestrator` — the
   * one composition write path (honua-studio#31). The orchestrator decides
   * local vs. server per command from the tool bridge's `serverToolName`, so
   * a TOC toggle reaches `honua_studio_set_layer_visibility` in live mode and
   * the reducer in fixture mode, with the generation threading and the
   * activity-log entry an agent's command already gets.
   *
   * Commands run in order and the batch stops at the first failure: a compare
   * switch's two toggles are one user gesture, and half of it landing is
   * worse than none of it.
   */
  /** Resolve an observed published receipt against the live catalog before adding it to the map. */
  public async addPublishedLayer(layer: {
    readonly layerId: number;
    readonly serviceName: string;
    readonly layerName?: string;
  }): Promise<HonuaStudioCommandOutcome> {
    const auth = this.auth;
    const catalog = await this.studioClient.listCatalog();
    if (this.auth !== auth) throw new Error("The Studio target changed while resolving the published layer.");
    const suffix = `/rest/services/${layer.serviceName.split("/").map(encodeURIComponent).join("/")}/FeatureServer`;
    const matches = catalog.filter(
      (entry) =>
        entry.locator?.layerId === layer.layerId &&
        typeof entry.locator.url === "string" &&
        entry.locator.url.endsWith(suffix),
    );
    if (matches.length !== 1) throw new Error("The published layer has no unique verified catalog source.");
    const source = matches[0]!;
    this.#applySourceCatalog(catalog);
    return this.#dispatchCommands([
      { name: "addLayer", layer: { id: source.id, sourceId: source.id, title: layer.layerName ?? source.title } },
    ]);
  }

  async #dispatchCommands(commands: readonly CompositionCommand[]): Promise<HonuaStudioCommandOutcome> {
    if (this.hasUnsavedStyleChanges && commands.some((command) => command.name !== "setMapStyle"))
      return { ok: false, reason: "Save or discard visual style edits before changing the map." };
    if (this.#workspaceDraft) {
      const binding = this.#workspaceDraft;
      const generation = this.#workspaceAuthGeneration;
      const run = this.#workspaceDraftQueue.then(async (): Promise<HonuaStudioCommandOutcome> => {
        try {
          if (generation !== this.#workspaceAuthGeneration) throw new Error("The workspace session changed.");
          if (binding !== this.#workspaceDraft) throw new Error("The active map changed before the edit began.");
          const target = applyCompositionCommands(this.composition.state, commands).state;
          const observed =
            commands.length === 1 && commands[0]?.name === "setMapStyle"
              ? {
                  ...(await binding.replaceStyle(commands[0].mapSpec)),
                  pins: target.pins,
                  annotations: target.annotations,
                }
              : await binding.replace(target);
          if (generation !== this.#workspaceAuthGeneration) throw new Error("The workspace session changed.");
          for (const command of commands) this.composition.apply(command);
          this.composition.replaceState(observed);
          this.#announceWorkspaceDraft();
          return { ok: true };
        } catch (error) {
          if (generation === this.#workspaceAuthGeneration && binding === this.#workspaceDraft)
            this.#workspaceDraftConflict = true;
          return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
      });
      this.#workspaceDraftQueue = run.catch(() => undefined);
      return run;
    }
    if (this.#session && "kind" in this.#session && this.#session.kind === "cookie")
      return { ok: false, reason: "Attach the shared server draft before editing the map." };
    for (const command of commands) {
      const result = await this.toolCallOrchestrator.handleToolCall({
        toolName: command.name,
        arguments: { ...command } as Record<string, unknown>,
      });
      if (!result.ok) return { ok: false, reason: result.reason };
    }
    return { ok: true };
  }

  /** Restores a retained preview proposal into the conversation. Never publishes. */
  async #resumeSharePreview(): Promise<void> {
    const noteGeneration = this.#publicationNoteGeneration;
    try {
      const handle = loadShareProposal(sessionShareStorage());
      if (!handle) return;
      const chat = this.querySelector<HonuaStudioChatElement>("honua-studio-chat");
      if (!chat) return;
      chat.shareNote = projectShareConversation(handle, {
        proposalId: handle.proposalId,
        status: "AwaitingApproval",
      }).text;
      const token = await this.auth?.getAccessToken();
      if (!token) return;
      const status = await fetchShareProposalStatus(runtimeServerBaseUrl(), handle.proposalId, token);
      if (!status || noteGeneration !== this.#publicationNoteGeneration || !this.isConnected) return;
      chat.shareNote = projectShareConversation(handle, status).text;
    } catch {
      // A retained handle must not block the shell when the preview server is unreachable.
    }
  }

  /** Resolves one chat-emitted tool-call intent through `.toolCallOrchestrator` (honua-studio#7). Never throws — every outcome is recorded on the orchestrator's activity log; see `../mcp/orchestrator.js`'s module doc. */
  async #handleChatToolCall(detail: HonuaStudioChatToolCallResultDetail): Promise<void> {
    if (!detail.toolName) return; // no tool name to resolve — nothing this orchestrator can do with it.
    const args = isPlainObject(detail.arguments) ? detail.arguments : {};
    await this.toolCallOrchestrator.handleToolCall({ toolName: detail.toolName, arguments: args });
  }

  protected onDisconnect(): void {
    this.#historyUnsubscribe?.();
    this.#historyUnsubscribe = undefined;
    if (!this.#workspaceAgentAdapter) {
      this.querySelector<HonuaStudioChatElement>("honua-studio-chat")?.detachAgentSession();
    }
    this.#agentSetupGeneration += 1;
    this.#hashRouter?.stop();
    this.#hashRouter = undefined;
    this.#authUnsubscribe?.();
    this.#authUnsubscribe = undefined;
    disposeAuthSession(this.#auth);
    this.#auth = undefined;
    this.#themeLoader = undefined;
    this.#chromeBuilt = false;
  }

  public attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (!this.isConnected || oldValue === newValue) return;
    if (name === "data-theme-set" || name === "data-theme") {
      this.dispatchTypedEvent<HonuaStudioThemeChangeDetail>("honua-studio-theme-change", {
        themeSet: this.themeSet,
        mode: this.themeMode,
      });
      this.syncThemeControls();
      return;
    }
    if (name === "current-path" && this.routingMode === "host") {
      const basePath = this.getAttribute("base-path");
      this.#currentPath = stripBasePath(normalizePath(newValue ?? "/"), basePath);
      this.renderView();
      return;
    }
    if (name === "theme-switcher") {
      this.renderChrome();
      return;
    }
    if (name === "routing-mode" || name === "base-path") {
      // Mode/base-path changes mid-connection are unusual; re-run onConnect's
      // routing setup (stop any hash router, re-derive the current path) and
      // re-render. This reuses the connection's own AbortSignal — still
      // live, since disconnectedCallback (real unmount) hasn't run — so
      // listeners set up here still clean up correctly on the next
      // disconnect, and the chrome's own listeners are untouched.
      this.#hashRouter?.stop();
      this.#hashRouter = undefined;
      const signal = this.connectedSignal;
      if (signal) this.onConnect(signal);
      this.render();
    }
  }

  protected render(): void {
    this.renderChrome();
    this.renderView();
  }

  private viewRoot(): HTMLElement {
    const root = this.shadowRoot?.querySelector<HTMLElement>("#view");
    if (!root) throw new Error("honua-studio-app: shell markup is missing its #view outlet.");
    return root;
  }

  private renderChrome(): void {
    if (this.#chromeBuilt && this.shadowRoot?.querySelector(".app-shell")) {
      this.syncThemeControls();
      this.syncNavCurrent();
      this.paintAuthControls();
      return;
    }
    const switcherHidden = this.themeSwitcherVisibility === "hidden";
    // REQ-003: the embed host owns sign-in/out, so Studio never renders
    // interactive auth controls in host-adapter mode — only a status label.
    const authControlsMarkup =
      this.auth.mode === "standalone"
        ? `<button type="button" class="hn-btn hn-btn--sm" data-testid="auth-signin" hidden>Sign in</button>
           <button type="button" class="hn-btn hn-btn--sm" data-testid="auth-signout" hidden>Sign out</button>`
        : "";
    this.setShadowHtml(`
      <style>${baseElementStyles()}${appShellStyles()}</style>
      <div class="app-shell" data-testid="app-shell">
        <header class="app-header hn-panel">
          <div class="app-brand">
            <p class="hn-register">Honua Studio</p>
            <h1 class="app-title">Natural language to map app.</h1>
          </div>
          <nav class="app-nav" aria-label="Studio">
            ${ROUTES.map(
              (route) =>
                `<a href="#${route.path}" data-path="${route.path}" data-testid="${route.navTestId}">${route.label}</a>`,
            ).join("")}
          </nav>
          <div class="app-auth" data-testid="auth-controls" role="group" aria-label="Session">
            <span class="hn-muted" data-testid="auth-status"></span>
            ${authControlsMarkup}
          </div>
          <!-- honua-studio#23 REQ-004: live composition is a real control,
               not a test hook. Collapsed by default and announcing "Fixture
               mode", because fixture/offline IS the default (REQ-005) and a
               user should be able to see which one they are in without
               opening a console. -->
          <div class="app-composition-mode" data-testid="live-composition" role="group" aria-label="Composition mode">
            <span class="hn-badge" data-testid="live-composition-status">${FIXTURE_MODE_LABEL}</span>
            <button type="button" class="hn-btn hn-btn--sm" data-testid="history-undo" disabled>Undo</button>
            <button type="button" class="hn-btn hn-btn--sm" data-testid="history-redo" disabled>Redo</button>
            <span class="hn-muted" data-testid="history-status" role="status"></span>
            <button
              type="button"
              class="hn-btn hn-btn--sm"
              data-testid="live-composition-toggle"
              aria-expanded="false"
              aria-controls="live-composition-form"
            >Go live…</button>
            <form class="live-form" id="live-composition-form" data-testid="live-composition-form" hidden>
              <label class="live-field">
                <span class="hn-muted">Studio package key</span>
                <input type="text" required data-testid="live-composition-package-key" placeholder="pkg-…" />
              </label>
              <label class="live-field">
                <span class="hn-muted">Family</span>
                <select data-testid="live-composition-family">
                  ${LIVE_COMPOSITION_FAMILIES.map((family) => `<option value="${family}">${family}</option>`).join("")}
                </select>
              </label>
              <div class="live-actions">
                <button type="submit" class="hn-btn hn-btn--sm" data-testid="live-composition-submit">Connect</button>
                <button type="button" class="hn-btn hn-btn--sm" data-testid="live-composition-cancel">Cancel</button>
              </div>
              <p class="hn-muted live-note">
                Tool calls will mutate a real Studio draft on the connected server instead of local fixture state.
              </p>
            </form>
          </div>
          <div class="app-theme-controls" data-testid="theme-controls" ${switcherHidden ? "hidden" : ""}>
            <div class="theme-group" role="group" aria-label="Theme set">
              ${THEME_SETS.map(
                (set) =>
                  `<button type="button" class="hn-btn hn-btn--sm" data-theme-set-option="${set}" data-testid="theme-set-${set}">${THEME_SET_LABELS[set]}</button>`,
              ).join("")}
            </div>
            <div class="theme-group" role="group" aria-label="Theme mode">
              ${THEME_MODES.map(
                (mode) =>
                  `<button type="button" class="hn-btn hn-btn--sm" data-theme-mode-option="${mode}" data-testid="theme-mode-${mode}">${THEME_MODE_LABELS[mode]}</button>`,
              ).join("")}
            </div>
          </div>
        </header>
        <main id="view" class="app-view" data-testid="app-view"></main>
        <div class="app-slots" data-testid="app-slots">
          <slot name="chat" ${this.#workspaceAgentAdapter ? "hidden" : ""}></slot>
          <slot name="canvas"></slot>
        </div>
      </div>
    `);
    this.#chromeBuilt = true;

    const root = this.shadowRoot;
    const signal = this.connectedSignal;
    for (const button of root?.querySelectorAll<HTMLButtonElement>("[data-theme-set-option]") ?? []) {
      button.addEventListener(
        "click",
        () => {
          this.themeSet = button.dataset.themeSetOption as ThemeSet;
        },
        { signal },
      );
    }
    for (const button of root?.querySelectorAll<HTMLButtonElement>("[data-theme-mode-option]") ?? []) {
      button.addEventListener(
        "click",
        () => {
          this.themeMode = button.dataset.themeModeOption as ThemeMode;
        },
        { signal },
      );
    }
    for (const link of root?.querySelectorAll<HTMLAnchorElement>("[data-path]") ?? []) {
      link.addEventListener(
        "click",
        (event) => {
          const path = link.dataset.path;
          if (!path) return;
          if (this.routingMode === "host") {
            // Host owns the URL: never touch window.location, only request.
            event.preventDefault();
            const basePath = this.getAttribute("base-path");
            this.dispatchTypedEvent<HonuaStudioNavigateDetail>("honua-studio-navigate", {
              path: withBasePath(path, basePath),
            });
          }
          // In "hash" mode the anchor's own href does the navigating; the
          // Router's hashchange listener picks it up.
        },
        { signal },
      );
    }
    root?.querySelector('[data-testid="auth-signin"]')?.addEventListener(
      "click",
      () => {
        void this.auth.signIn();
      },
      { signal },
    );
    root?.querySelector('[data-testid="auth-signout"]')?.addEventListener(
      "click",
      () => {
        void this.auth.signOut();
      },
      { signal },
    );

    this.bindLiveCompositionControls();
    for (const action of ["undo", "redo"] as const) {
      root?.querySelector(`[data-testid="history-${action}"]`)?.addEventListener(
        "click",
        () => {
          void this.applyHistoryAction(action);
        },
        { signal },
      );
    }
    this.#historyUnsubscribe?.();
    this.#historyUnsubscribe = this.composition.subscribe(() => this.paintHistoryControls());
    this.paintHistoryControls();

    this.syncThemeControls();
    this.syncNavCurrent();
    this.paintAuthControls();
    this.paintLiveCompositionControls();
  }

  /** Wires the REQ-004 control group. Listeners are `connectedSignal`-scoped, so a chrome rebuild never doubles them up. */
  private bindLiveCompositionControls(): void {
    const root = this.shadowRoot;
    const signal = this.connectedSignal;
    if (!root) return;
    const form = root.querySelector<HTMLFormElement>('[data-testid="live-composition-form"]');
    const toggle = root.querySelector<HTMLButtonElement>('[data-testid="live-composition-toggle"]');
    toggle?.addEventListener(
      "click",
      () => {
        // One button, two jobs, decided by the mode you are in: open the
        // connect form from fixture mode, drop back to fixture from live.
        if (this.toolCallOrchestrator.isLive) {
          this.disableLiveComposition();
          return;
        }
        if (!form) return;
        form.hidden = !form.hidden;
        toggle.setAttribute("aria-expanded", String(!form.hidden));
        if (!form.hidden) {
          root.querySelector<HTMLInputElement>('[data-testid="live-composition-package-key"]')?.focus();
        }
      },
      { signal },
    );
    root.querySelector<HTMLButtonElement>('[data-testid="live-composition-cancel"]')?.addEventListener(
      "click",
      () => {
        if (form) form.hidden = true;
        toggle?.setAttribute("aria-expanded", "false");
      },
      { signal },
    );
    form?.addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        const packageKey = root
          .querySelector<HTMLInputElement>('[data-testid="live-composition-package-key"]')
          ?.value.trim();
        if (!packageKey) return;
        const family = root.querySelector<HTMLSelectElement>('[data-testid="live-composition-family"]')?.value as
          | StudioPackageFamilyWire
          | undefined;
        form.hidden = true;
        toggle?.setAttribute("aria-expanded", "false");
        this.enableLiveComposition({ packageKey, ...(family ? { family } : {}) });
      },
      { signal },
    );
  }

  /** Reflects the current composition mode into the header — called on every chrome build and on every mode change. */
  private paintLiveCompositionControls(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const live = this.#orchestrator?.isLive === true;
    const status = root.querySelector<HTMLElement>('[data-testid="live-composition-status"]');
    if (status) {
      status.textContent = live ? `Live · ${this.#liveCompositionPackageKey ?? "connected"}` : FIXTURE_MODE_LABEL;
      status.setAttribute("data-mode", live ? "live" : "fixture");
    }
    const toggle = root.querySelector<HTMLButtonElement>('[data-testid="live-composition-toggle"]');
    if (toggle) toggle.textContent = live ? "Return to fixture" : "Go live…";
    if (live) {
      const form = root.querySelector<HTMLFormElement>('[data-testid="live-composition-form"]');
      if (form) form.hidden = true;
      toggle?.setAttribute("aria-expanded", "false");
    }
  }

  private paintHistoryControls(): void {
    for (const action of ["undo", "redo"] as const) {
      const button = this.shadowRoot?.querySelector<HTMLButtonElement>(`[data-testid="history-${action}"]`);
      if (button)
        button.disabled =
          this.#historyBusy ||
          this.hasUnsavedStyleChanges ||
          !(action === "undo" ? this.composition.canUndo() : this.composition.canRedo());
    }
  }

  private syncThemeControls(): void {
    const root = this.shadowRoot;
    if (!root) return;
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-theme-set-option]")) {
      button.setAttribute("aria-pressed", String(button.dataset.themeSetOption === this.themeSet));
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-theme-mode-option]")) {
      button.setAttribute("aria-pressed", String(button.dataset.themeModeOption === this.themeMode));
    }
    const controls = root.querySelector<HTMLElement>('[data-testid="theme-controls"]');
    if (controls) controls.hidden = this.themeSwitcherVisibility === "hidden";
  }

  private syncNavCurrent(): void {
    const root = this.shadowRoot;
    if (!root) return;
    for (const link of root.querySelectorAll<HTMLAnchorElement>("[data-path]")) {
      if (link.dataset.path === this.#currentPath) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  private paintAuthControls(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const state = this.#auth?.getState() ?? { status: "signed-out" as const };
    const statusEl = root.querySelector<HTMLElement>('[data-testid="auth-status"]');
    if (statusEl) statusEl.textContent = AUTH_STATUS_LABELS[state.status];
    const signInButton = root.querySelector<HTMLButtonElement>('[data-testid="auth-signin"]');
    const signOutButton = root.querySelector<HTMLButtonElement>('[data-testid="auth-signout"]');
    const signedIn = state.status === "fresh" || state.status === "refreshing";
    if (signInButton) signInButton.hidden = signedIn;
    if (signOutButton) signOutButton.hidden = !signedIn;
  }

  private renderView(): void {
    if (!this.shadowRoot?.querySelector("#view")) return;
    if (this.#isWorkspaceHost()) {
      this.viewRoot().replaceChildren();
      return;
    }
    const route = ROUTES.find((candidate) => candidate.path === this.#currentPath) ?? ROUTES[0];
    route?.render(this.viewRoot(), this.studioClient, this.auth, (dataset) => this.#addCatalogSource(dataset));
    this.syncNavCurrent();
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}
