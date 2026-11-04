/**
 * `<honua-studio-app>`: the Studio shell. Attribute, property and event contract: docs/element-contract.md;
 * session contract: docs/embed-session.md. A host that supplies its own chat or canvas child wires it itself;
 * this element only uses the public properties and events any embedder could use.
 */
import type { HonuaAgentToolDefinitionLike, HonuaAiMapKit } from "@honua/sdk-js/agent-tools";
import {
  InMemoryStudioAiReplayStore,
  type StudioAiTranscriptCertification,
  type StudioAiTranscriptSigningManifest,
  StudioAiTranscriptVerifier,
} from "@honua/sdk-js/studio-agent";
import { CompositionEditor, historyShortcutAction } from "../app/composition-editor.js";
import { DesignInspectorHost, type DesignRelationship } from "../app/design-inspector-host.js";
import { hasEditedFormControl } from "../app/dirty-form.js";
import { LiveCompositionController, type LiveCompositionOptions } from "../app/live-composition-controller.js";
import { RecipeController } from "../app/recipe-controller.js";
import { ShellChrome } from "../app/shell-chrome.js";
import { ShellRouter } from "../app/shell-router.js";
import { type ProcessSourceChoice, SourceCatalog } from "../app/source-catalog.js";
import { StudioAppChildren } from "../app/studio-app-children.js";
import { StyleEditorHost } from "../app/style-editor-host.js";
import { WorkspaceAuthority, type WorkspaceStyleProviderOptions } from "../app/workspace-authority.js";
import { type WorkspaceDraftIdentity, WorkspaceDraftSession } from "../app/workspace-draft-session.js";
import { WorkspacePublication } from "../app/workspace-publication.js";
import { isCookieSession, isSameCookiePrincipal, verifiedSourcePathBase } from "../auth/host-session.js";
import type { AuthoritativeStyleProvider } from "../styles/authoritative-style-provider.js";
import type { WorkspaceAgentSessionAdapter, WorkspaceConversationMessage } from "../workspace-agent.js";

import type { AuthSession, SessionAdapter } from "../auth/index.js";
import type { CatalogDataset, StudioClient } from "../client/studio-client.js";
import { CompositionController } from "../composition/controller.js";
import { createEmptyCompositionState } from "../composition/model.js";
import type { StudioContentVersion, StudioPublishRequestInput } from "../lifecycle/lifecycle-types.js";
import type { ToolCallOrchestrator } from "../mcp/orchestrator.js";
import type { ExploreDatasetInput, ExploreDatasetMetadata } from "../recipes/explore-dataset.js";
import { ThemeLoader } from "../theme/theme-loader.js";
import type { ThemeMode, ThemeSet } from "../theme/theme-loader.js";
import { HonuaStudioElementBase } from "./base-element.js";
import type { StudioAgentCertificationOptions } from "./studio-chat-element.js";
import type {
  HonuaStudioChatToolCallResultDetail,
  HonuaStudioCommandOutcome,
  HonuaStudioGpActivityDetail,
  HonuaStudioGpAddOutputDetail,
  HonuaStudioLifecycleActivityDetail,
  HonuaStudioRoutingMode,
  HonuaStudioThemeChangeDetail,
  HonuaStudioThemeSwitcherVisibility,
} from "./types.js";

export class HonuaStudioAppElement extends HonuaStudioElementBase {
  static get observedAttributes(): string[] {
    return ["data-theme-set", "data-theme", "routing-mode", "current-path", "base-path", "theme-switcher"];
  }

  readonly #composition = new CompositionController(createEmptyCompositionState());
  readonly #children = new StudioAppChildren(this);
  readonly #authority: WorkspaceAuthority = new WorkspaceAuthority({
    isConnected: () => this.isConnected,
    onAuthReplaced: () => this.#drafts.rebind(this.#authority.lifecycleClient()),
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
    return this.#children.chat()?.setWorkspaceConversation(this.#workspaceConversation) ?? true;
  }

  public get agentSessionAdapter(): WorkspaceAgentSessionAdapter | undefined {
    return this.#workspaceAgentAdapter;
  }
  public set agentSessionAdapter(adapter: WorkspaceAgentSessionAdapter | undefined) {
    const previous = this.#workspaceAgentAdapter;
    this.#workspaceAgentAdapter = adapter;
    this.#syncWorkspaceChrome();
    const chat = this.#children.chat();
    if (chat && (previous !== adapter || chat.agentSessionAdapter !== adapter)) {
      chat.detachAgentSession();
      chat.agentSessionAdapter = adapter;
    }
    this.#chrome.hideChatSlot(Boolean(adapter));
  }

  #isWorkspaceHost(): boolean {
    return Boolean(this.#workspaceAgentAdapter) || this.#authority.hasCookieSession;
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
    liveStatus: () => ({ live: this.#live.isLive, packageKey: this.#live.packageKey }),
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
      this.#recipes.onCatalogReplaced();
    },
    onCatalogApplied: (catalog) => {
      this.#live.forgetMapKit();
      const canvas = this.#children.canvas();
      if (canvas) canvas.sourceCatalog = catalog;
      if (this.isConnected && this.#live.isLive) this.#live.scheduleAgentSession();
    },
    onRevalidate: () => this.#recipes.invalidateSourceChoices(),
  });
  readonly #drafts: WorkspaceDraftSession = new WorkspaceDraftSession(this.#authority, this.#composition, {
    prepareWorkspaceTurn: () => this.prepareWorkspaceTurn(),
    attachWorkspaceDraft: (draftId) => this.attachWorkspaceDraft(draftId),
    hasDirtyForm: () => this.#hasDirtyWorkspaceForm(),
    settleStyleEdits: () => this.#styleEditor.settled(),
    onDraftRequested: () => this.closeDesignInspector(),
    beforeMapSwitch: (draftId) => {
      this.closeDesignInspector();
      if (!this.#recipes.isAttaching(draftId)) this.#recipes.dispose();
    },
    afterMapSwitch: () => this.#children.canvas()?.resetExploration(),
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
    children: this.#children,
    hasUnsavedStyleChanges: () => this.hasUnsavedStyleChanges,
  });
  readonly #designInspector: DesignInspectorHost = new DesignInspectorHost({
    host: this,
    authority: this.#authority,
    drafts: this.#drafts,
    catalog: this.#catalog,
    composition: this.#composition,
    chrome: this.#chrome,
    children: this.#children,
  });
  readonly #styleEditor: StyleEditorHost = new StyleEditorHost({
    host: this,
    authority: this.#authority,
    drafts: this.#drafts,
    catalog: this.#catalog,
    composition: this.#composition,
    chrome: this.#chrome,
    editor: this.#editor,
    children: this.#children,
  });
  readonly #recipes: RecipeController = new RecipeController({
    host: this,
    authority: this.#authority,
    catalog: this.#catalog,
    drafts: this.#drafts,
    chrome: this.#chrome,
  });
  readonly #live: LiveCompositionController = new LiveCompositionController({
    host: this,
    catalog: this.#catalog,
    chrome: this.#chrome,
    children: this.#children,
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
  #lastAuthStatus: string | undefined;

  /** Optional host entrypoint; viewing and choosing inputs never creates a draft. */
  public openRecipePicker(): void {
    this.#recipes.open();
  }

  public closeRecipePicker(): void {
    this.#recipes.close();
  }

  public listRecipeSources(signal: AbortSignal): Promise<readonly CatalogDataset[]> {
    return this.#recipes.listSources(signal);
  }

  public resolveRecipeSource(sourceId: string, signal: AbortSignal): Promise<ExploreDatasetMetadata> {
    return this.#recipes.resolveSource(sourceId, signal);
  }

  /** Explicit create. Stable submission IDs reuse the same canonical request and Idempotency-Key. */
  public createRecipeDraft(input: ExploreDatasetInput, submissionId: string): Promise<WorkspaceDraftIdentity> {
    return this.#recipes.createDraft(input, submissionId);
  }

  /** Local runtime tools offered to the agent; server-backed tools are discovered over MCP. */
  public get agentToolDefinitions(): (kit: HonuaAiMapKit) => ReadonlyArray<HonuaAgentToolDefinitionLike> {
    return this.#live.toolDefinitions;
  }

  public set agentToolDefinitions(provider: (kit: HonuaAiMapKit) => ReadonlyArray<HonuaAgentToolDefinitionLike>) {
    this.#live.toolDefinitions = provider;
  }

  /**
   * Certification binding and transcript verifier for the live agent session. The SDK dispatches a
   * model-selected tool only after verifying that round's signed provenance; without these options the turn
   * ends with the SDK's refusal. Assigning rebuilds a live session so a new binding applies to the next turn.
   */
  public get agentCertification(): StudioAgentCertificationOptions | undefined {
    return this.#live.certification;
  }

  public set agentCertification(options: StudioAgentCertificationOptions | undefined) {
    this.#live.certification = options;
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
    if (isCookieSession(session)) verifiedSourcePathBase(session.sourcePathBase);
    const previous = this.#authority.session;
    const hadAuthority = Boolean(this.#authority.holdsSession || this.#drafts.binding);
    const samePrincipal = isSameCookiePrincipal(previous, session);
    if (!samePrincipal) {
      this.closeDesignInspector();
      this.#recipes.resetAuthority();
      this.#styleEditor.dispose();
      this.#authority.epoch.next();
      if (hadAuthority) {
        // Cached human descriptor metadata belongs to the former authority too.
        this.#catalog.forget();
        this.#live.forgetMapKit();
        const previousCanvas = this.#children.canvas();
        if (previousCanvas) previousCanvas.sourceCatalog = undefined;
      }
      this.#drafts.detach();
      this.composition.resetBaseline(createEmptyCompositionState());
      this.composition.clearSelection();
      this.#children.canvas()?.resetExploration();
      if (hadAuthority) this.#drafts.announce();
    }
    this.#authority.adoptSession(session);
    this.#syncWorkspaceChrome();
    const sourceCanvas = this.#children.canvas();
    if (sourceCanvas) sourceCanvas.sourceAuthBaseUrl = this.#authority.sourceBaseUrl;
    if (!this.isConnected) {
      this.#authority.disposeAuth();
      this.#authority.forgetStudioClient();
      return;
    }
    const renewed = samePrincipal && isCookieSession(session) && this.#authority.renewCookieLease(session);
    if (!renewed) this.#authority.resetAuth();
    // A host-owned catalog does not reload on session replacement. Invalidate
    // its widget rows explicitly rather than leaving another session's data visible.
    for (const canvas of this.#children.canvases()) {
      canvas.widgetDeck?.refreshSession();
    }
    // A host-owned catalog never refreshes, so nothing else would rebuild the agent session.
    this.#live.renewCredentials();
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
    return this.#live.orchestrator;
  }

  /** Actual published choices for the canonical GP layer picker; no map focus is inferred. */
  public listProcessSources(): Promise<readonly ProcessSourceChoice[]> {
    return this.#catalog.listProcessSources();
  }

  public resolveProcessSource(sourceId: string): Promise<{ processLayerId?: number; unavailableReason?: string }> {
    return this.#catalog.resolveProcessSource(sourceId);
  }

  /** Read-only style discovery pinned to this human authority; lease renewal may refresh transport only. */
  public createWorkspaceStyleProvider(options: WorkspaceStyleProviderOptions = {}): AuthoritativeStyleProvider {
    return this.#authority.createWorkspaceStyleProvider(options);
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
    if (replacing) this.#recipes.dispose();
    this.#catalog.apply(catalog);
  }

  #onAuthStatusChanged(): void {
    if (!this.isConnected) return;
    const status = this.#authority.resolvedAuth?.getState().status;
    if (status === this.#lastAuthStatus) return;
    this.#lastAuthStatus = status;
    if (status === "expired" || status === "signed-out") this.closeDesignInspector();
    if (status === "signed-out" || status === "expired") this.#recipes.resetAuthority();
    if (status !== "fresh" || this.#catalog.catalog !== undefined) return;
    this.#catalog.refresh();
  }

  /** SDK AI map kit over `.composition`; rebuilt with the catalog so a model only sees published sources. */
  public get aiMapKit(): HonuaAiMapKit {
    return this.#live.mapKit;
  }

  /**
   * Attaches a live MCP session so tool calls mutate a server draft through `honua_studio_*` tools instead
   * of the local reducer. The header's "Go live…" control calls this; every mode change is announced as
   * `honua-studio-composition-mode-change` and logged.
   */
  public enableLiveComposition(options: LiveCompositionOptions): void {
    this.#live.enable(options);
  }

  /** Returns to fixture mode. State the server already accepted stays; only future tool calls stay local. */
  public disableLiveComposition(): void {
    this.#live.disable();
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

    if (!this.#children.chat()) {
      const chat = document.createElement("honua-studio-chat");
      chat.slot = "chat";
      chat.setAttribute("label", "Chat");
      this.appendChild(chat);
    }
    if (!this.#children.canvas()) {
      const canvas = document.createElement("honua-studio-canvas");
      canvas.slot = "canvas";
      canvas.setAttribute("label", "Canvas");
      this.appendChild(canvas);
    }

    if (this.#workspaceAgentAdapter) this.agentSessionAdapter = this.#workspaceAgentAdapter;

    const canvas = this.#children.canvas();
    if (canvas) canvas.sourceAuthBaseUrl = this.#authority.sourceBaseUrl;
    if (canvas && !canvas.composition) canvas.composition = this.composition;
    if (canvas && !canvas.commandDispatch) canvas.commandDispatch = (commands) => this.#editor.dispatch(commands);
    if (canvas && this.#catalog.catalog) canvas.sourceCatalog = this.#catalog.catalog;
    else void this.#catalog.load();
    // Construct the orchestrator while the chat child is resolvable for its activity log.
    void this.toolCallOrchestrator;
    void this.#live.resumeSharePreview();
    this.listen(this, "honua-studio-chat-tool-call-result", (event) => {
      const detail = (event as CustomEvent<HonuaStudioChatToolCallResultDetail>).detail;
      void this.#editor.handleChatToolCall(detail);
    });

    this.listen(this, "honua-studio-lifecycle-activity", (event) => {
      const detail = (event as CustomEvent<HonuaStudioLifecycleActivityDetail>).detail;
      const chat = this.#children.chat();
      chat?.activityLog.append("lifecycle_action", { ...detail });
    });

    this.agentSessionAdapter = this.#workspaceAgentAdapter;
    if (this.#workspaceConversation.length) this.setWorkspaceConversation(this.#workspaceConversation);
    this.listen(this, "honua-studio-gp-activity", (event) => {
      const detail = (event as CustomEvent<HonuaStudioGpActivityDetail>).detail;
      const chat = this.#children.chat();
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

  /** Resolve an observed published receipt against the live catalog before adding it to the map. */
  public addPublishedLayer(
    layer: { readonly layerId: number; readonly serviceName: string; readonly layerName?: string },
    options?: { readonly isCurrent?: () => boolean },
  ): Promise<HonuaStudioCommandOutcome> {
    return this.#editor.addPublishedLayer(layer, options);
  }

  protected onDisconnect(): void {
    this.closeDesignInspector();
    this.#recipes.dispose();
    this.#chrome.dispose();
    if (!this.#workspaceAgentAdapter) {
      this.#children.chat()?.detachAgentSession();
    }
    this.#live.cancelAgentSetup();
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
