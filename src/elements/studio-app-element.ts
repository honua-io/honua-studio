/**
 * `<honua-studio-app>`: the Studio shell. Attribute, property and event contract: docs/element-contract.md;
 * session contract: docs/embed-session.md. A host that supplies its own chat or canvas child wires it itself;
 * this element only uses the public properties and events any embedder could use.
 */
import type { HonuaAgentToolDefinitionLike, HonuaAgentToolResult, HonuaAiMapKit } from "@honua/sdk-js/agent-tools";
import {
  InMemoryStudioAiReplayStore,
  type StudioAgentSession,
  type StudioAiTranscriptCertification,
  type StudioAiTranscriptSigningManifest,
  StudioAiTranscriptVerifier,
} from "@honua/sdk-js/studio-agent";
import { CompositionEditor, historyShortcutAction } from "../app/composition-editor.js";
import { DesignInspectorHost, type DesignRelationship } from "../app/design-inspector-host.js";
import { hasEditedFormControl } from "../app/dirty-form.js";
import { ShellChrome } from "../app/shell-chrome.js";
import { ShellRouter } from "../app/shell-router.js";
import { type ProcessSourceChoice, SourceCatalog } from "../app/source-catalog.js";
import { type EpochToken, StalenessEpoch } from "../app/staleness-epoch.js";
import { StyleEditorHost } from "../app/style-editor-host.js";
import { WorkspaceAuthority } from "../app/workspace-authority.js";
import { type WorkspaceDraftIdentity, WorkspaceDraftSession } from "../app/workspace-draft-session.js";
import { WorkspacePublication } from "../app/workspace-publication.js";
import { verifiedSourcePathBase } from "../auth/host-session.js";
import {
  type AuthoritativeStyleDefinition,
  AuthoritativeStyleProvider,
} from "../styles/authoritative-style-provider.js";
import type { WorkspaceAgentSessionAdapter, WorkspaceConversationMessage } from "../workspace-agent.js";

import type { AuthSession, SessionAdapter } from "../auth/index.js";
import {
  fetchShareProposalStatus,
  loadShareProposal,
  projectPublicationReceipt,
  projectShareConversation,
  sessionShareStorage,
} from "../chat/share-preview.js";
import { buildStudioSystemPrompt } from "../chat/system-prompt.js";
import { type CatalogDataset, StudioClient } from "../client/studio-client.js";
import { CompositionController } from "../composition/controller.js";
import { createEmptyCompositionState } from "../composition/model.js";
import { canonicalCompositionJson } from "../composition/model.js";
import { StudioLifecycleClient } from "../lifecycle/lifecycle-client.js";
import type { StudioContentVersion, StudioPublishRequestInput } from "../lifecycle/lifecycle-types.js";
import type { StudioPackageDraftCreateRequest } from "../lifecycle/lifecycle-types.js";
import { createStudioAiMapKit } from "../map/agent-map-kit.js";
import { McpClient } from "../mcp/client.js";
import { StudioAuthoringMcpClient } from "../mcp/composition-authoring-contract.js";
import { MAP_COMPOSITION_ENVELOPE, toCompositionDraftBody } from "../mcp/composition-envelope.js";
import { ToolCallOrchestrator } from "../mcp/orchestrator.js";
import type { StudioMcpDraft, StudioPackageFamilyWire } from "../mcp/studio-tools.js";
import {
  type ExploreDatasetInput,
  type ExploreDatasetMetadata,
  compileExploreDataset,
} from "../recipes/explore-dataset.js";
import { RecipePanel } from "../recipes/recipe-panel.js";
import { RecipeSubmission } from "../recipes/recipe-submission.js";
import { runtimeMcpBaseUrl, runtimeServerBaseUrl } from "../runtime-config.js";
import { ThemeLoader } from "../theme/theme-loader.js";
import type { ThemeMode, ThemeSet } from "../theme/theme-loader.js";
import { createCatalogWidgetDataLoader } from "../widgets/widget-data.js";
import { HonuaStudioElementBase } from "./base-element.js";
import type { HonuaStudioCanvasElement } from "./studio-canvas-element.js";
import type { HonuaStudioChatElement, StudioAgentCertificationOptions } from "./studio-chat-element.js";
import type {
  HonuaStudioChatToolCallResultDetail,
  HonuaStudioCommandOutcome,
  HonuaStudioCompositionModeChangeDetail,
  HonuaStudioGpActivityDetail,
  HonuaStudioGpAddOutputDetail,
  HonuaStudioLifecycleActivityDetail,
  HonuaStudioRoutingMode,
  HonuaStudioThemeChangeDetail,
  HonuaStudioThemeSwitcherVisibility,
} from "./types.js";

function recipeSourceIdentity(source: CatalogDataset, verifiedSourceBase?: string): string | undefined {
  const locator = source.locator;
  if (
    !locator ||
    typeof locator.url !== "string" ||
    typeof locator.serviceId !== "string" ||
    !Number.isSafeInteger(locator.layerId)
  )
    return undefined;
  try {
    const url = new URL(locator.url, document.baseURI);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /%(?:2f|5c|25)/i.test(url.pathname)
    )
      return undefined;
    url.pathname = url.pathname
      .replace(/\/$/, "")
      .replace(new RegExp(`/FeatureServer/${locator.layerId}$`, "i"), "/FeatureServer");
    const documentOrigin = new URL(document.baseURI).origin;
    const catalogRoot = new URL(runtimeMcpBaseUrl() || "/", document.baseURI);
    const roots = [
      catalogRoot,
      ...(verifiedSourceBase === undefined ? [] : [new URL(verifiedSourceBase || "/", document.baseURI)]),
    ];
    if (catalogRoot.origin === documentOrigin)
      for (const root of roots) {
        const prefix = root.pathname.replace(/\/$/, "");
        if (
          root.origin === documentOrigin &&
          url.origin === documentOrigin &&
          url.pathname.startsWith(`${prefix}/rest/services/`)
        ) {
          url.pathname = `${catalogRoot.pathname.replace(/\/$/, "")}${url.pathname.slice(prefix.length)}`;
          break;
        }
      }
    return canonicalCompositionJson({
      id: source.id,
      protocol: source.protocol,
      locator: { ...locator, url: url.href },
    });
  } catch {
    return undefined;
  }
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

interface LiveCompositionOptions {
  readonly baseUrl: string;
  readonly packageKey: string;
  readonly family?: StudioPackageFamilyWire;
  readonly schemaVersion?: string;
}

export class HonuaStudioAppElement extends HonuaStudioElementBase {
  static get observedAttributes(): string[] {
    return ["data-theme-set", "data-theme", "routing-mode", "current-path", "base-path", "theme-switcher"];
  }

  readonly #composition = new CompositionController(createEmptyCompositionState());
  readonly #authority: WorkspaceAuthority = new WorkspaceAuthority({
    isConnected: () => this.isConnected,
    onAuthReplaced: (auth) => this.#drafts.rebind(new StudioLifecycleClient({ baseUrl: runtimeServerBaseUrl(), auth })),
    // Never renderView() from this listener: every getAccessToken() dispatches a state change and the home
    // route fetches with a token, so re-rendering routes here loops forever. Routes subscribe themselves.
    onAuthStateChange: () => {
      this.#chrome.paintAuth();
      this.#onAuthStatusChanged();
    },
  });
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
    this.#chrome.hideChatSlot(Boolean(adapter));
  }

  #isWorkspaceHost(): boolean {
    return Boolean(
      this.#workspaceAgentAdapter ||
        (this.#authority.session && "kind" in this.#authority.session && this.#authority.session.kind === "cookie"),
    );
  }
  #syncWorkspaceChrome(): void {
    const host = this.#isWorkspaceHost();
    this.toggleAttribute("data-workspace-host", host);
    if (host) this.#router.stop();
    if (this.isConnected) this.renderView();
  }

  #themeLoader: ThemeLoader | undefined;
  readonly #chrome: ShellChrome = new ShellChrome({
    host: this,
    setShadowHtml: (html) => this.setShadowHtml(html),
    connectedSignal: () => this.connectedSignal,
    authStatus: () => this.#authority.resolvedAuth?.getState().status ?? "signed-out",
    isDesignInspectorOpen: () => this.#designInspector.isOpen,
    isHistoryBusy: () => this.#drafts.historyBusy,
    liveStatus: () => ({ live: this.#orchestrator?.isLive === true, packageKey: this.#liveCompositionPackageKey }),
    onNavigate: (path, event) => this.#router.requestNavigation(path, event),
  });
  readonly #router: ShellRouter = new ShellRouter({
    host: this,
    hasView: () => this.#chrome.hasView(),
    viewRoot: () => this.#chrome.viewRoot(),
    onRouteRendered: () => this.#chrome.syncNav(),
    isWorkspaceHost: () => this.#isWorkspaceHost(),
    addCatalogSource: (dataset) => this.#editor.addCatalogSource(dataset),
  });
  readonly #catalog: SourceCatalog = new SourceCatalog(this.#authority, {
    isConnected: () => this.isConnected,
    onCatalogReplacing: () => {
      this.closeDesignInspector();
      if (this.#recipeSourceChoices) this.#recipePreviousChoices = this.#recipeSourceChoices;
      this.#recipeSourcesAuthority = undefined;
      this.#recipeSourceChoices = undefined;
    },
    onCatalogApplied: (catalog) => {
      // The kit advertises the catalog, so it has to be rebuilt around a new one.
      this.#aiMapKit = undefined;
      const canvas = this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas");
      if (canvas) canvas.sourceCatalog = catalog;
      if (this.isConnected && this.#orchestrator?.isLive) this.#scheduleLiveAgentSession();
    },
    onRevalidate: () => {
      this.#recipeSourcesAuthority = undefined;
    },
  });
  readonly #drafts: WorkspaceDraftSession = new WorkspaceDraftSession(this.#authority, this.#composition, {
    prepareWorkspaceTurn: () => this.prepareWorkspaceTurn(),
    attachWorkspaceDraft: (draftId) => this.attachWorkspaceDraft(draftId),
    hasDirtyForm: () => this.#hasDirtyWorkspaceForm(),
    settleStyleEdits: () => this.#styleEditor.settled(),
    onDraftRequested: () => this.closeDesignInspector(),
    beforeMapSwitch: (draftId) => {
      this.closeDesignInspector();
      if (this.#recipeDraftToAttach !== draftId) this.#disposeRecipePicker();
    },
    afterMapSwitch: () => this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas")?.resetExploration(),
    onDraftChange: (identity) =>
      this.dispatchEvent(
        new CustomEvent("honua-workspace-draft-change", { bubbles: true, composed: true, detail: identity }),
      ),
  });
  readonly #publication: WorkspacePublication = new WorkspacePublication(this.#authority, this.#drafts, () =>
    this.prepareWorkspaceTurn(),
  );
  readonly #editor: CompositionEditor = new CompositionEditor({
    authority: this.#authority,
    drafts: this.#drafts,
    catalog: this.#catalog,
    composition: this.#composition,
    chrome: this.#chrome,
    orchestrator: () => this.toolCallOrchestrator,
    chat: () => this.querySelector<HonuaStudioChatElement>("honua-studio-chat") ?? undefined,
    canvas: () => this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas") ?? undefined,
    hasUnsavedStyleChanges: () => this.hasUnsavedStyleChanges,
  });
  readonly #designInspector: DesignInspectorHost = new DesignInspectorHost({
    host: this,
    authority: this.#authority,
    drafts: this.#drafts,
    catalog: this.#catalog,
    composition: this.#composition,
    chrome: this.#chrome,
    canvas: () => this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas") ?? undefined,
  });
  readonly #styleEditor: StyleEditorHost = new StyleEditorHost({
    host: this,
    authority: this.#authority,
    drafts: this.#drafts,
    catalog: this.#catalog,
    composition: this.#composition,
    chrome: this.#chrome,
    editor: this.#editor,
    canvas: () => this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas") ?? undefined,
  });

  public get selectedDesignRelationship(): DesignRelationship | undefined {
    return this.#designInspector.selectedRelationship;
  }

  /** Shared embedded editor surface; hosts may open this beside their one conversation. */
  public openDesignInspector(): Promise<void> {
    return this.#designInspector.open();
  }

  public closeDesignInspector(): void {
    this.#designInspector.close();
  }

  public styleEditorAssetsUrl = "/maputnik/index.html";

  public get hasUnsavedStyleChanges(): boolean {
    return this.#styleEditor.hasUnsavedChanges;
  }

  public openStyleEditor(options: { layerId?: string } = {}): Promise<void> {
    return this.#styleEditor.open(options?.layerId);
  }

  public closeStyleEditor(): Promise<void> {
    return this.#styleEditor.close();
  }

  public discardStyleChanges(): Promise<void> {
    return this.#styleEditor.discard();
  }
  #orchestrator: ToolCallOrchestrator | undefined;
  #liveCompositionPackageKey: string | undefined;
  #aiMapKit: HonuaAiMapKit | undefined;
  #lastAuthStatus: string | undefined;
  #agentToolDefinitions: ((kit: HonuaAiMapKit) => ReadonlyArray<HonuaAgentToolDefinitionLike>) | undefined;
  #agentCertification: StudioAgentCertificationOptions | undefined;
  #agentSetup = new StalenessEpoch();
  #publicationNote = new StalenessEpoch();
  #liveAgentBaseUrl = "/api";
  #liveCompositionOptions: LiveCompositionOptions | undefined;
  #recipeAuthority = new StalenessEpoch();
  #revokedRecipeSubmissionIds = new Set<string>();
  #recipePanel: RecipePanel | undefined;
  #recipeSourcesAuthority: EpochToken | undefined;
  #recipeSourceChoices: readonly CatalogDataset[] | undefined;
  #recipePreviousChoices: readonly CatalogDataset[] | undefined;
  #recipeSourceIdentity(source: CatalogDataset): string | undefined {
    return recipeSourceIdentity(
      source,
      this.#authority.session && "kind" in this.#authority.session && this.#authority.session.kind === "cookie"
        ? verifiedSourcePathBase(this.#authority.session.sourcePathBase)
        : undefined,
    );
  }
  #recipeDraftToAttach: string | undefined;
  #recipeSubmissions = new Map<
    string,
    {
      input: string;
      generation: EpochToken;
      submission: RecipeSubmission;
      originalDraftId?: string;
      originalDraftGeneration?: number;
      attachmentAllowed: boolean;
      metadataAbort?: AbortController;
      request?: StudioPackageDraftCreateRequest;
      pending?: Promise<{ draftId: string; generation: number; packageKey: string }>;
    }
  >();

  /** Optional host entrypoint; viewing and choosing inputs never creates a draft. */
  public openRecipePicker(): void {
    const outlet = this.#chrome.recipeOutlet();
    if (!outlet) throw new Error("Connect the Studio element before opening recipes.");
    outlet.hidden = false;
    this.#recipePanel ??= new RecipePanel(outlet, {
      listSources: (signal) => this.listRecipeSources(signal),
      describeSource: (id, signal) => this.resolveRecipeSource(id, signal),
      create: (input, id) => this.createRecipeDraft(input, id),
      close: () => this.closeRecipePicker(),
      startAnother: () => {
        this.#disposeRecipePicker();
        this.openRecipePicker();
      },
      canChangeInputs: (id) => !this.#recipeSubmissions.get(id)?.submission.submitted,
    });
    this.#chrome.setExpanded("recipe-toggle", true);
    this.#recipePanel.resume();
  }

  public closeRecipePicker(): void {
    this.#recipePanel?.cancelDiscovery();
    for (const entry of this.#recipeSubmissions.values())
      if (entry.pending) {
        entry.attachmentAllowed = false;
        entry.metadataAbort?.abort();
      }
    const outlet = this.#chrome.recipeOutlet();
    if (outlet) outlet.hidden = true;
    this.#chrome.setExpanded("recipe-toggle", false);
    this.#chrome.focus("recipe-toggle");
  }

  #disposeRecipePicker(): void {
    this.#recipePanel?.dispose();
    this.#recipePanel = undefined;
    this.#recipeSourcesAuthority = undefined;
    this.#recipeSourceChoices = undefined;
    this.#recipePreviousChoices = undefined;
    this.closeRecipePicker();
  }

  #resetRecipeAuthority(): void {
    this.#disposeRecipePicker();
    this.#recipeAuthority.next();
    for (const id of this.#recipeSubmissions.keys()) this.#revokedRecipeSubmissionIds.add(id);
    this.#recipeSubmissions.clear();
  }

  public async listRecipeSources(signal: AbortSignal): Promise<readonly CatalogDataset[]> {
    const generation = this.#recipeAuthority.current;
    const leaseGeneration = this.#authority.lease.current;
    this.#recipeSourcesAuthority = undefined;
    this.#recipeSourceChoices = undefined;
    const hostOwnsCatalog = this.#catalog.fromHost;
    const hostCatalog = this.#catalog.catalog;
    const auth = this.auth;
    const client = new StudioClient(
      runtimeServerBaseUrl(),
      {
        getAccessToken: (options) => auth.getAccessToken(options),
        fetchRequest: (input, init) => (auth.fetchRequest ?? fetch)(input, { ...init, signal }),
      },
      runtimeMcpBaseUrl(),
    );
    const catalog = await client.listCatalog();
    signal.throwIfAborted();
    if (
      !this.#recipeAuthority.isCurrent(generation) ||
      auth !== this.auth ||
      !this.#authority.lease.isCurrent(leaseGeneration)
    )
      throw new Error("The workspace authority changed.");
    let choices: readonly CatalogDataset[] = catalog;
    if (hostOwnsCatalog) {
      if (!this.#catalog.fromHost || hostCatalog !== this.#catalog.catalog)
        throw new Error("The host source choices changed. Refresh the recipe sources.");
      choices = (hostCatalog ?? []).filter((source) => {
        const observed = catalog.find((entry) => entry.id === source.id);
        if (!observed) return false;
        const identity = this.#recipeSourceIdentity(source);
        if (!identity || identity !== this.#recipeSourceIdentity(observed))
          throw new Error(
            `Host source "${source.id}" disagrees with the authorized published locator. Refresh the host source choices.`,
          );
        return true;
      });
    } else {
      if (this.#catalog.fromHost) throw new Error("The host source choices changed. Refresh the recipe sources.");
      this.#catalog.apply(catalog);
    }
    this.#recipeSourceChoices = structuredClone(choices);
    this.#recipeSourcesAuthority = generation;
    return structuredClone(choices);
  }

  public async resolveRecipeSource(sourceId: string, signal: AbortSignal): Promise<ExploreDatasetMetadata> {
    const generation = this.#recipeAuthority.current;
    let choices = this.#recipeSourceChoices;
    let selectedSource = choices?.find((entry) => entry.id === sourceId);
    let current = this.#catalog.find(sourceId);
    if (
      (!selectedSource || !current || this.#recipeSourcesAuthority !== generation) &&
      (selectedSource ?? this.#recipePreviousChoices?.find((entry) => entry.id === sourceId))
    ) {
      const previous = structuredClone(
        selectedSource ?? this.#recipePreviousChoices!.find((entry) => entry.id === sourceId)!,
      );
      await this.listRecipeSources(signal);
      choices = this.#recipeSourceChoices;
      selectedSource = choices?.find((entry) => entry.id === sourceId);
      current = this.#catalog.find(sourceId);
      if (
        !selectedSource ||
        this.#recipeSourceIdentity(previous) !== this.#recipeSourceIdentity(selectedSource) ||
        previous.geometryType !== selectedSource.geometryType
      ) {
        this.#recipeSourceChoices = undefined;
        this.#recipePreviousChoices = undefined;
        this.#recipeSourcesAuthority = undefined;
        throw new Error("The authorized source changed. Refresh the dataset choices before selecting a source.");
      }
    }
    const source = selectedSource && structuredClone(selectedSource);
    if (
      !source ||
      !current ||
      this.#recipeSourceIdentity(current) !== this.#recipeSourceIdentity(source) ||
      this.#recipeSourcesAuthority !== generation
    )
      throw new Error("Refresh the authorized dataset choices before selecting a source.");
    if (source.protocol !== "geoservices-feature-service")
      throw new Error("Choose a published Honua vector FeatureServer source.");
    const provider = this.createWorkspaceStyleProvider({ signal, getAuthority: () => this.#recipeAuthority.current });
    const descriptor = await provider.describeDataset(source);
    if (choices !== this.#recipeSourceChoices)
      throw new Error("The source choices changed. Refresh the recipe sources.");
    const bounds = await provider.describeSourceBounds(source);
    if (choices !== this.#recipeSourceChoices)
      throw new Error("The source choices changed. Refresh the recipe sources.");
    const type = descriptor.geometryType.toLowerCase();
    if (type.includes("raster") || type.includes("image"))
      throw new Error("Choose a point, line or polygon vector source.");
    const auth = this.auth;
    const baseUrl = provider.serverRoot;
    const result = await createCatalogWidgetDataLoader({
      catalog: [source],
      baseUrl: runtimeMcpBaseUrl(),
      sourceAuthBaseUrl: baseUrl,
      sourceCatalogBaseUrl: runtimeMcpBaseUrl(),
      documentUrl: document.baseURI,
      featureLimit: 100,
      getAuth: () => {
        this.#recipeAuthority.assertCurrent(generation, "The workspace authority changed.");
        return this.auth;
      },
      fetchImpl: (input, init) => (auth.fetchRequest ?? fetch)(input, { ...init, signal }),
    })(sourceId, { signal });
    signal.throwIfAborted();
    this.#recipeAuthority.assertCurrent(generation, "The workspace authority changed.");
    if (choices !== this.#recipeSourceChoices)
      throw new Error("The source choices changed. Refresh the recipe sources.");
    if (!result.ok) throw new Error(`Readable feature queries are required. ${result.reason}`);
    return {
      source: { ...source, geometryType: descriptor.geometryType },
      fields: descriptor.fields,
      rows: result.rows,
      truncated: result.truncated,
      ...(bounds ? { bounds } : {}),
    };
  }

  /** Explicit create. Stable submission IDs reuse the same canonical request and Idempotency-Key. */
  public createRecipeDraft(
    requestedInput: ExploreDatasetInput,
    submissionId: string,
  ): Promise<{ draftId: string; generation: number; packageKey: string }> {
    const input = structuredClone(requestedInput);
    Object.freeze(input.tableFields);
    Object.freeze(input);
    if (!/^[A-Za-z0-9-]{1,100}$/.test(submissionId))
      return Promise.reject(new Error("A stable recipe submission ID is required."));
    if (this.#revokedRecipeSubmissionIds.has(submissionId))
      return Promise.reject(new Error("Retry this submission only in its original workspace authority."));
    const generation = this.#recipeAuthority.current;
    const json = canonicalCompositionJson(input);
    let entry = this.#recipeSubmissions.get(submissionId);
    if (entry && (entry.input !== json || entry.generation !== generation))
      return Promise.reject(new Error("Retry this submission with its original inputs and workspace authority."));
    if (!entry) {
      entry = {
        input: json,
        generation,
        submission: new RecipeSubmission(),
        originalDraftId: this.#drafts.identity?.draftId,
        attachmentAllowed: true,
      };
      this.#recipeSubmissions.set(submissionId, entry);
    }
    if (entry.pending) return entry.pending;
    entry.attachmentAllowed = true;
    entry.metadataAbort = new AbortController();
    const submission = entry;
    const run = (async () => {
      await this.prepareWorkspaceTurn();
      this.#recipeAuthority.assertCurrent(generation, "The workspace authority changed.");
      const client = new StudioLifecycleClient({ baseUrl: runtimeServerBaseUrl(), auth: this.auth });
      if (!submission.request) {
        submission.originalDraftId = this.#drafts.identity?.draftId;
        submission.originalDraftGeneration = this.#drafts.identity?.generation;
        const capabilities = await client.getPackageFamilies();
        const map = capabilities.families.find((family) => family.family === "map");
        if (!map || map.supportLevel === "unsupported" || !map.supportedOperations.includes("draft.create"))
          throw new Error("Map draft creation is unavailable on this server. Ask the operator to enable it.");
        if (!submission.attachmentAllowed) throw new Error("Recipe creation was cancelled before submission.");
        const metadata = await this.resolveRecipeSource(
          input.sourceId,
          AbortSignal.any([AbortSignal.timeout(15000), submission.metadataAbort!.signal]),
        );
        const { state } = compileExploreDataset(input, metadata);
        this.#recipeAuthority.assertCurrent(generation, "The workspace authority changed.");
        submission.request = {
          packageKey: input.packageKey,
          envelope: { ...MAP_COMPOSITION_ENVELOPE, body: toCompositionDraftBody(state, input.packageKey) },
        };
      }
      if (!submission.attachmentAllowed && !submission.submission.submitted)
        throw new Error("Recipe creation was cancelled before submission.");
      const created = await submission.submission.createDraft(submission.request, (request, commandId) =>
        client.createDraft(request, commandId),
      );
      this.#recipeAuthority.assertCurrent(
        generation,
        "The workspace authority changed. Reopen this draft in its original workspace.",
      );
      const activeDraftId = this.#drafts.identity?.draftId;
      if (!submission.attachmentAllowed)
        throw new Error(
          `Creation returned draft ${created.draftId} after this picker was closed. Reopen and retry this submission to attach that same draft.`,
        );
      if (activeDraftId === created.draftId) return this.#drafts.identity!;
      if (
        activeDraftId !== submission.originalDraftId ||
        this.#drafts.identity?.generation !== submission.originalDraftGeneration
      )
        throw new Error(
          `Draft ${created.draftId} was created, but the active map changed. Open that draft explicitly to recover it.`,
        );
      const mayAttach = () => {
        this.#recipeAuthority.assertCurrent(
          generation,
          "The workspace authority changed. Reopen this draft in its original workspace.",
        );
        if (!submission.attachmentAllowed)
          throw new Error(
            `Draft ${created.draftId} was created, but attachment was cancelled. Open that draft explicitly to recover it.`,
          );
        const current = this.#drafts.identity;
        if (
          current?.draftId !== submission.originalDraftId ||
          current?.generation !== submission.originalDraftGeneration
        )
          throw new Error(
            `Draft ${created.draftId} was created, but the active map changed. Open that draft explicitly to recover it.`,
          );
      };
      this.#recipeDraftToAttach = created.draftId;
      try {
        await this.#drafts.attach(created.draftId, mayAttach);
      } finally {
        this.#recipeDraftToAttach = undefined;
      }
      const identity = this.#drafts.identity;
      if (!identity || identity.draftId !== created.draftId)
        throw new Error("Retry to attach the already created draft.");
      return identity;
    })();
    submission.pending = run;
    void run
      .finally(() => {
        submission.pending = undefined;
      })
      .catch(() => undefined);
    return run;
  }

  /** Local runtime tools offered to the agent; server-backed tools are discovered over MCP. */
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
   * Certification binding and transcript verifier for the live agent session. The SDK dispatches a
   * model-selected tool only after verifying that round's signed provenance; without these options the turn
   * ends with the SDK's refusal. Assigning rebuilds a live session so a new binding applies to the next turn.
   */
  public get agentCertification(): StudioAgentCertificationOptions | undefined {
    return this.#agentCertification;
  }

  public set agentCertification(options: StudioAgentCertificationOptions | undefined) {
    this.#agentCertification = options;
    if (this.#orchestrator?.isLive) this.#scheduleLiveAgentSession();
  }

  /** Explicit human create action; never creates a draft as a side effect of viewing or chatting. */
  public createWorkspaceDraft(packageKey: string): Promise<WorkspaceDraftIdentity> {
    return this.#drafts.create(packageKey);
  }

  /** Read the authorized durable draft after a native turn. Does not execute tools. */
  public attachWorkspaceDraft(draftId: string): Promise<void> {
    return this.#drafts.attach(draftId);
  }

  /** Save the active server draft as an immutable version; never publish it. */
  public saveWorkspaceVersion(): Promise<StudioContentVersion> {
    return this.#publication.saveVersion();
  }

  /** List versions belonging to the active draft's server-owned content item. */
  public listWorkspaceVersions(): Promise<readonly StudioContentVersion[]> {
    return this.#publication.listVersions();
  }

  /** Read the exact saved version for the host's human publication review. Never submits. */
  public reviewWorkspacePublication(versionId: string): Promise<StudioContentVersion> {
    return this.#publication.review(versionId);
  }

  /** Human host action only; see `WorkspacePublication.publish` for the retry contract. */
  public publishWorkspaceVersion(
    review: StudioContentVersion,
    request: StudioPublishRequestInput,
    commandId: string,
  ): ReturnType<WorkspacePublication["publish"]> {
    return this.#publication.publish(review, request, commandId);
  }

  /** Read an active item's publication receipt without flushing edits or submitting a mutation. */
  public readWorkspacePublication(
    versionId: string,
    requestId: string,
  ): ReturnType<WorkspacePublication["readPublication"]> {
    return this.#publication.readPublication(versionId, requestId);
  }

  /** Reopen a version of the active map as a new draft, preserving the saved version. */
  public reopenWorkspaceVersion(versionId: string): Promise<void> {
    return this.#publication.reopenVersion(versionId);
  }

  /** Idle observation for external draft changes; never discard an unsaved form value. */
  public refreshWorkspaceDraft(): Promise<boolean> {
    return this.#drafts.refresh();
  }

  /** Flush accepted human edits before the host captures a durable native turn. */
  public prepareWorkspaceTurn(): Promise<WorkspaceDraftIdentity | undefined> {
    return this.#drafts.prepareTurn();
  }

  /** Undo/redo in the authoritative draft before advancing the visible history. */
  public applyHistoryAction(action: "undo" | "redo"): Promise<boolean> {
    return this.#editor.applyHistory(action);
  }

  #hasDirtyWorkspaceForm(): boolean {
    if (this.hasUnsavedStyleChanges) return true;
    const isIgnored = (element: Element) =>
      this.#styleEditor.contains(element) || Boolean(this.#chrome.recipeOutlet()?.contains(element));
    return (
      hasEditedFormControl(this, isIgnored) ||
      Boolean(this.shadowRoot && hasEditedFormControl(this.shadowRoot, isIgnored))
    );
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
   * Host-injected session adapter (docs/embed-session.md); same shape as
   * `window.__HONUA_STUDIO_HOST_SESSION__`, and a host uses one or the other. Unset means the window
   * global if present, else standalone OIDC. Reassigning while connected rebuilds `.auth`.
   */
  public get session(): SessionAdapter | undefined {
    return this.#authority.session;
  }

  public set session(session: SessionAdapter | undefined) {
    if (this.#authority.session === session) return;
    if (session && "kind" in session && session.kind === "cookie") verifiedSourcePathBase(session.sourcePathBase);
    const previous = this.#authority.session;
    const hadAuthority = Boolean(this.#authority.holdsSession || this.#drafts.binding);
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
      this.closeDesignInspector();
      this.#resetRecipeAuthority();
      this.#styleEditor.dispose();
      this.#authority.epoch.next();
      if (hadAuthority) {
        // Cached human descriptor metadata belongs to the former authority too.
        this.#catalog.forget();
        this.#aiMapKit = undefined;
        const previousCanvas = this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas");
        if (previousCanvas) previousCanvas.sourceCatalog = undefined;
      }
      this.#drafts.detach();
      this.composition.resetBaseline(createEmptyCompositionState());
      this.composition.clearSelection();
      this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas")?.resetExploration();
      if (hadAuthority) this.#drafts.announce();
    }
    this.#authority.adoptSession(session);
    this.#syncWorkspaceChrome();
    const sourceCanvas = this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas");
    if (sourceCanvas)
      sourceCanvas.sourceAuthBaseUrl =
        session && "kind" in session && session.kind === "cookie"
          ? verifiedSourcePathBase(session.sourcePathBase)
          : runtimeMcpBaseUrl();
    if (!this.isConnected) {
      this.#authority.disposeAuth();
      this.#authority.forgetStudioClient();
      return;
    }
    const renewed =
      samePrincipal &&
      session &&
      "kind" in session &&
      session.kind === "cookie" &&
      this.#authority.renewCookieLease(session);
    if (!renewed) this.#authority.resetAuth();
    // A host-owned catalog does not reload on session replacement. Invalidate
    // its widget rows explicitly rather than leaving another session's data visible.
    for (const canvas of this.querySelectorAll<HonuaStudioCanvasElement>("honua-studio-canvas")) {
      canvas.widgetDeck?.refreshSession();
    }
    // Live clients capture their AuthSession at construction, and a host-owned catalog never refreshes,
    // so nothing else would rebuild the agent session with the new credentials.
    if (this.#orchestrator?.isLive && this.#liveCompositionOptions) {
      this.#replaceLiveCompositionSession(this.#liveCompositionOptions);
    }
    // auth.mode decides whether sign-in/out buttons exist at all, so a new principal rebuilds the chrome.
    // A cookie lease renewal keeps the DOM so the style editor iframe keeps uncommitted field text.
    if (!samePrincipal) this.#chrome.invalidate();
    this.renderChrome();
    // Routes receive `auth` as an argument, so re-render the current route once with the new session.
    if (this.routingMode === "hash") this.#router.startHashRouting();
    else this.renderView();
    // The catalog is bearer-gated, so a new session needs a new catalog.
    if (samePrincipal) this.#catalog.revalidate();
    else this.#catalog.refresh();
  }

  /** The resolved `AuthSession` this element and its descendants (`resolveInjectedAuth`) use; built lazily. */
  public get auth(): AuthSession {
    return this.#authority.auth;
  }

  /** Catalog and packages client bound to `.auth`; assign one for fixtures and tests. */
  public get studioClient(): StudioClient {
    return this.#authority.studioClient;
  }

  public set studioClient(client: StudioClient) {
    this.#authority.studioClient = client;
    this.renderView();
  }

  /** Composition state the canvas renders; it survives reconnection. */
  public get composition(): CompositionController {
    return this.#composition;
  }

  /**
   * Tool-call orchestrator over `.composition`, logging to the chat's activity log when a chat child
   * exists. Applies through the local reducer until `.enableLiveComposition()` attaches a live MCP session.
   */
  public get toolCallOrchestrator(): ToolCallOrchestrator {
    if (!this.#orchestrator) {
      const chat = this.querySelector<HonuaStudioChatElement>("honua-studio-chat");
      this.#orchestrator = new ToolCallOrchestrator({ controller: this.composition, activityLog: chat?.activityLog });
    }
    return this.#orchestrator;
  }

  /** Actual published choices for the canonical GP layer picker; no map focus is inferred. */
  public listProcessSources(): Promise<readonly ProcessSourceChoice[]> {
    return this.#catalog.listProcessSources();
  }

  public resolveProcessSource(sourceId: string): Promise<{ processLayerId?: number; unavailableReason?: string }> {
    return this.#catalog.resolveProcessSource(sourceId);
  }

  /** Read-only style discovery pinned to this human authority; lease renewal may refresh transport only. */
  public createWorkspaceStyleProvider(
    options: { readonly getAuthority?: () => unknown; readonly signal?: AbortSignal } = {},
  ): AuthoritativeStyleProvider {
    const generation = this.#authority.epoch.current;
    const authority = options.getAuthority?.();
    const baseUrl =
      this.#authority.session && "kind" in this.#authority.session && this.#authority.session.kind === "cookie"
        ? verifiedSourcePathBase(this.#authority.session.sourcePathBase)
        : runtimeMcpBaseUrl();
    return new AuthoritativeStyleProvider({
      baseUrl,
      ...(baseUrl !== runtimeMcpBaseUrl() ? { catalogAliasBaseUrl: runtimeMcpBaseUrl() } : {}),
      documentUrl: window.document.baseURI,
      signal: options.signal,
      getAuth: () => {
        if (!this.#authority.epoch.isCurrent(generation) || options.getAuthority?.() !== authority)
          throw new Error("The selected style workspace authority changed.");
        return this.auth;
      },
    });
  }

  /**
   * Catalog the map resolves layer sources against and the AI map kit advertises. Fetched once per
   * connection; a host may assign its own listing instead, which skips the fetch.
   */
  public get sourceCatalog(): readonly CatalogDataset[] | undefined {
    return this.#catalog.catalog;
  }

  public set sourceCatalog(catalog: readonly CatalogDataset[] | undefined) {
    const replacing = catalog !== this.#catalog.catalog;
    this.#catalog.claimForHost();
    if (replacing) this.#disposeRecipePicker();
    this.#catalog.apply(catalog);
  }

  #onAuthStatusChanged(): void {
    if (!this.isConnected) return;
    const status = this.#authority.resolvedAuth?.getState().status;
    if (status === this.#lastAuthStatus) return;
    this.#lastAuthStatus = status;
    if (status === "expired" || status === "signed-out") this.closeDesignInspector();
    if (status === "signed-out" || status === "expired") this.#resetRecipeAuthority();
    if (status !== "fresh" || this.#catalog.catalog !== undefined) return;
    this.#catalog.refresh();
  }

  /** SDK AI map kit over `.composition`; rebuilt with the catalog so a model only sees published sources. */
  public get aiMapKit(): HonuaAiMapKit {
    if (!this.#aiMapKit) {
      this.#aiMapKit = createStudioAiMapKit({
        controller: this.composition,
        ...(this.#catalog.catalog !== undefined ? { catalog: this.#catalog.catalog } : {}),
      });
    }
    return this.#aiMapKit;
  }

  /**
   * Attaches a live MCP session so tool calls mutate a server draft through `honua_studio_*` tools instead
   * of the local reducer. The header's "Go live…" control calls this; every mode change is announced as
   * `honua-studio-composition-mode-change` and logged.
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
    this.#agentSetup.next();
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
    const generation = this.#agentSetup.current;
    void setup.catch((error) => {
      if (!this.#agentSetup.isCurrent(generation)) return;
      this.disableLiveComposition();
      const chat = this.querySelector<HonuaStudioChatElement>("honua-studio-chat");
      chat?.activityLog.append("assistant_turn_error", {
        errorMessage: error instanceof Error ? error.message : String(error),
        phase: "agent-session-setup",
      });
    });
  }

  /** Returns to fixture mode. State the server already accepted stays; only future tool calls stay local. */
  public disableLiveComposition(): void {
    if (!this.toolCallOrchestrator.isLive) return;
    this.toolCallOrchestrator.detachLiveSession();
    this.#agentSetup.next();
    this.querySelector<HonuaStudioChatElement>("honua-studio-chat")?.detachAgentSession();
    const chat = this.querySelector<HonuaStudioChatElement>("honua-studio-chat");
    if (chat) chat.agentSessionPending = false;
    this.#liveCompositionPackageKey = undefined;
    this.#liveCompositionOptions = undefined;
    this.#announceCompositionMode({ mode: "fixture" });
  }

  #announceCompositionMode(detail: HonuaStudioCompositionModeChangeDetail): void {
    this.#chrome.paintLiveComposition();
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
    return this.#router.currentPath;
  }

  public set currentPath(path: string) {
    // Base-path stripping happens only in attributeChangedCallback.
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

  protected onConnect(signal: AbortSignal): void {
    // The chrome markup depends on auth.mode, so auth resolves first.
    this.#authority.resetAuth();

    // The hash router binds to #view, so the chrome exists before it.
    this.renderChrome();
    this.listen(this, "keydown", (event) => {
      const action = historyShortcutAction(event as KeyboardEvent);
      if (!action || !(action === "undo" ? this.composition.canUndo() : this.composition.canRedo())) return;
      event.preventDefault();
      void this.applyHistoryAction(action);
    });

    const loader = this.ensureThemeLoader();
    // A host that already stamped a theme owns it; persisted state applies only otherwise.
    if (!this.hasAttribute("data-theme-set") && !this.hasAttribute("data-theme")) {
      loader.boot();
    }

    if (this.routingMode === "hash") this.#router.startHashRouting();
    else this.#router.followHostPath(this.getAttribute("current-path"));

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

    const canvas = this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas");
    if (canvas)
      canvas.sourceAuthBaseUrl =
        this.#authority.session && "kind" in this.#authority.session && this.#authority.session.kind === "cookie"
          ? verifiedSourcePathBase(this.#authority.session.sourcePathBase)
          : runtimeMcpBaseUrl();
    if (canvas && !canvas.composition) canvas.composition = this.composition;
    if (canvas && !canvas.commandDispatch) canvas.commandDispatch = (commands) => this.#editor.dispatch(commands);
    if (canvas && this.#catalog.catalog) canvas.sourceCatalog = this.#catalog.catalog;
    else void this.#catalog.load();
    // Construct the orchestrator while the chat child is resolvable for its activity log.
    void this.toolCallOrchestrator;
    void this.#resumeSharePreview();
    this.listen(this, "honua-studio-chat-tool-call-result", (event) => {
      const detail = (event as CustomEvent<HonuaStudioChatToolCallResultDetail>).detail;
      void this.#editor.handleChatToolCall(detail);
    });

    this.listen(this, "honua-studio-lifecycle-activity", (event) => {
      const detail = (event as CustomEvent<HonuaStudioLifecycleActivityDetail>).detail;
      const chat = this.querySelector<HonuaStudioChatElement>("honua-studio-chat");
      chat?.activityLog.append("lifecycle_action", { ...detail });
    });

    this.agentSessionAdapter = this.#workspaceAgentAdapter;
    if (this.#workspaceConversation.length) this.setWorkspaceConversation(this.#workspaceConversation);
    this.listen(this, "honua-studio-gp-activity", (event) => {
      const detail = (event as CustomEvent<HonuaStudioGpActivityDetail>).detail;
      const chat = this.querySelector<HonuaStudioChatElement>("honua-studio-chat");
      chat?.activityLog.append("gp_action", { ...detail });
    });

    this.listen(this, "honua-studio-gp-add-output", (event) => {
      const detail = (event as CustomEvent<HonuaStudioGpAddOutputDetail>).detail;
      void this.toolCallOrchestrator.handleToolCall({
        toolName: "addLayer",
        arguments: {
          layer: { id: detail.sourceId, sourceId: detail.sourceId, ...(detail.title ? { title: detail.title } : {}) },
        },
      });
    });

    void signal;
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
    const setupGeneration = this.#agentSetup.next();
    chat.agentSessionPending = true;
    const draft = await this.toolCallOrchestrator.ensureLiveDraft();
    if (!this.#agentSetup.isCurrent(setupGeneration) || !this.toolCallOrchestrator.isLive) return;
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
    if (!this.#agentSetup.isCurrent(setupGeneration) || !this.toolCallOrchestrator.isLive) return;
    if (this.auth !== styleAuth) return;
    const sessionRef: { current?: StudioAgentSession } = {};
    const certification = this.#agentCertification;
    sessionRef.current = chat.attachAgentSession({
      ...(certification?.certification ? { certification: certification.certification } : {}),
      ...(certification?.transcriptVerifier ? { transcriptVerifier: certification.transcriptVerifier } : {}),
      baseUrl,
      auth: this.auth,
      mcpClient: new StudioAuthoringMcpClient({ baseUrl, auth: this.auth, workflowView: "setup" }),
      workflowKnowledge: true,
      tools: [...this.agentToolDefinitions(kit)],
      execute: async (call) => {
        // A host may supply the visibility mutation through the runtime-tool seam; route it through the
        // orchestrator. Every other local tool executes through the kit.
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
          catalog: this.#catalog.catalog,
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
            !this.#agentSetup.isCurrent(setupGeneration) ||
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
                this.#publicationNote.next();
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

  /** Resolve an observed published receipt against the live catalog before adding it to the map. */
  public addPublishedLayer(
    layer: { readonly layerId: number; readonly serviceName: string; readonly layerName?: string },
    options?: { readonly isCurrent?: () => boolean },
  ): Promise<HonuaStudioCommandOutcome> {
    return this.#editor.addPublishedLayer(layer, options);
  }

  /** Restores a retained preview proposal into the conversation. Never publishes. */
  async #resumeSharePreview(): Promise<void> {
    const noteGeneration = this.#publicationNote.current;
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
      if (!status || !this.#publicationNote.isCurrent(noteGeneration) || !this.isConnected) return;
      chat.shareNote = projectShareConversation(handle, status).text;
    } catch {
      // A retained handle must not block the shell when the preview server is unreachable.
    }
  }

  protected onDisconnect(): void {
    this.closeDesignInspector();
    this.#disposeRecipePicker();
    this.#chrome.dispose();
    if (!this.#workspaceAgentAdapter) {
      this.querySelector<HonuaStudioChatElement>("honua-studio-chat")?.detachAgentSession();
    }
    this.#agentSetup.next();
    this.#router.stop();
    this.#authority.disposeAuth();
    this.#themeLoader = undefined;
  }

  public attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (!this.isConnected || oldValue === newValue) return;
    if (name === "data-theme-set" || name === "data-theme") {
      this.dispatchTypedEvent<HonuaStudioThemeChangeDetail>("honua-studio-theme-change", {
        themeSet: this.themeSet,
        mode: this.themeMode,
      });
      this.#chrome.syncTheme();
      return;
    }
    if (name === "current-path" && this.routingMode === "host") {
      this.#router.followHostPath(newValue);
      this.renderView();
      return;
    }
    if (name === "theme-switcher") {
      this.renderChrome();
      return;
    }
    if (name === "routing-mode" || name === "base-path") {
      // Re-run onConnect's routing setup on the still-live connection signal, so its listeners still clean up.
      this.#router.stop();
      const signal = this.connectedSignal;
      if (signal) this.onConnect(signal);
      this.render();
    }
  }

  protected render(): void {
    this.renderChrome();
    this.renderView();
  }

  private renderChrome(): void {
    this.#chrome.render();
  }

  private renderView(): void {
    this.#router.render();
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}
