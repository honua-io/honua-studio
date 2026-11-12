/**
 * `<honua-studio-app>`: the Studio shell. Attribute, property and event contract: docs/element-contract.md;
 * session contract: docs/embed-session.md. A host that supplies its own chat or canvas child wires it itself;
 * this element only uses the public properties and events any embedder could use. Behaviour lives in the
 * controllers `StudioAppRoot` assembles; this class is the public facade and the element lifecycle.
 */
import type { HonuaAgentToolDefinitionLike, HonuaAiMapKit } from "@honua/sdk-js/agent-tools";
import {
  InMemoryStudioAiReplayStore,
  type StudioAiTranscriptCertification,
  type StudioAiTranscriptSigningManifest,
  StudioAiTranscriptVerifier,
} from "@honua/sdk-js/studio-agent";
import { historyShortcutAction } from "../app/composition-editor.js";
import type { DesignRelationship } from "../app/design-inspector-host.js";
import type { LiveEditingOptions } from "../app/live-composition-controller.js";
import type { ProcessSourceChoice } from "../app/source-catalog.js";
import { StudioAppRoot } from "../app/studio-workspace.js";
import type { EditorStyleProviderOptions } from "../app/workspace-authority.js";
import type { EditorDraftIdentity } from "../app/workspace-draft-session.js";
import type { EditorRelease } from "../app/workspace-publication.js";
import type { AuthSession, SessionAdapter } from "../auth/index.js";
import type { CatalogDataset, StudioClient } from "../client/studio-client.js";
import type { CompositionController } from "../composition/controller.js";
import type { StudioApprovalPending } from "../lifecycle/approval-pending.js";
import type { StudioContentVersion, StudioPublishRequestInput } from "../lifecycle/lifecycle-types.js";
import type { ToolCallOrchestrator } from "../mcp/orchestrator.js";
import type { ExploreDatasetInput, ExploreDatasetMetadata } from "../recipes/explore-dataset.js";
import type { AuthoritativeStyleProvider } from "../styles/authoritative-style-provider.js";
import { ThemeLoader } from "../theme/theme-loader.js";
import type { ThemeMode, ThemeSet } from "../theme/theme-loader.js";
import type { EditorAgentSessionAdapter, EditorConversationMessage } from "../workspace-agent.js";
import { HonuaStudioElementBase } from "./base-element.js";
import type { StudioAgentCertificationOptions } from "./studio-chat-element.js";
import { HonuaStudioLifecyclePanelElement } from "./studio-lifecycle-panel-element.js";
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

type AgentToolDefinitions = (kit: HonuaAiMapKit) => ReadonlyArray<HonuaAgentToolDefinitionLike>;

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export class HonuaStudioAppElement extends HonuaStudioElementBase {
  static get observedAttributes(): string[] {
    return ["data-theme-set", "data-theme", "routing-mode", "current-path", "base-path", "theme-switcher"];
  }

  public styleEditorAssetsUrl = "/maputnik/index.html";
  readonly #root = new StudioAppRoot(this, {
    setShadowHtml: (html) => this.setShadowHtml(html),
    connectedSignal: () => this.connectedSignal,
  });
  readonly #authority = this.#root.authority;
  readonly #children = this.#root.children;
  readonly #chrome = this.#root.chrome;
  readonly #router = this.#root.router;
  readonly #catalog = this.#root.catalog;
  readonly #drafts = this.#root.drafts;
  readonly #publication = this.#root.publication;
  readonly #editor = this.#root.editor;
  readonly #designInspector = this.#root.designInspector;
  readonly #styleEditor = this.#root.styleEditor;
  readonly #recipes = this.#root.recipes;
  readonly #live = this.#root.live;
  #editorAgentAdapter: EditorAgentSessionAdapter | undefined;
  #editorConversation: readonly EditorConversationMessage[] = [];
  #themeLoader: ThemeLoader | undefined;

  /**
   * Host-injected session adapter (docs/embed-session.md); same shape as
   * `window.__HONUA_STUDIO_HOST_SESSION__`, and a host uses one or the other. Unset means the window
   * global if present, else standalone OIDC. Reassigning while connected rebuilds `.auth`.
   */
  public get session(): SessionAdapter | undefined {
    return this.#authority.session;
  }

  public set session(session: SessionAdapter | undefined) {
    this.#root.replaceSession(session);
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
    this.#router.render();
  }

  /** Read-only style discovery pinned to this human authority; lease renewal may refresh transport only. */
  public createEditorStyleProvider(options: EditorStyleProviderOptions = {}): AuthoritativeStyleProvider {
    return this.#authority.createEditorStyleProvider(options);
  }

  /** Editor-host agent transport; while set, the host's own composer replaces the chat slot. */
  public get agentSessionAdapter(): EditorAgentSessionAdapter | undefined {
    return this.#editorAgentAdapter;
  }

  public set agentSessionAdapter(adapter: EditorAgentSessionAdapter | undefined) {
    const previous = this.#editorAgentAdapter;
    this.#editorAgentAdapter = adapter;
    this.#root.syncHostMode();
    const chat = this.#children.chat();
    if (chat && (previous !== adapter || chat.agentSessionAdapter !== adapter)) {
      chat.detachAgentSession();
      chat.agentSessionAdapter = adapter;
    }
    if (adapter) this.#chrome.hideChatSlot();
    else this.#chrome.showChatSlot();
  }

  public setEditorConversation(messages: readonly EditorConversationMessage[]): boolean {
    this.#editorConversation = messages.map((message) => ({ ...message }));
    return this.#children.chat()?.setEditorConversation(this.#editorConversation) ?? true;
  }

  /** Composition state the canvas renders; it survives reconnection. */
  public get composition(): CompositionController {
    return this.#root.composition;
  }

  /**
   * Tool-call orchestrator over `.composition`, logging to the chat's activity log when a chat child
   * exists. Applies through the local reducer until `.enableLiveEditing()` attaches a live MCP session.
   */
  public get toolCallOrchestrator(): ToolCallOrchestrator {
    return this.#live.orchestrator;
  }

  /** SDK AI map kit over `.composition`; rebuilt with the catalog so a model only sees published sources. */
  public get aiMapKit(): HonuaAiMapKit {
    return this.#live.mapKit;
  }

  /** Local runtime tools offered to the agent; server-backed tools are discovered over MCP. */
  public get agentToolDefinitions(): AgentToolDefinitions {
    return this.#live.toolDefinitions;
  }

  public set agentToolDefinitions(provider: AgentToolDefinitions) {
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
   * Attaches a live MCP session so tool calls mutate a server draft through `honua_studio_*` tools instead
   * of the local reducer. The header's "Go live…" control calls this; every mode change is announced as
   * `honua-studio-editing-mode-change` and logged.
   */
  public enableLiveEditing(options: LiveEditingOptions): void {
    this.#live.enable(options);
  }

  /** Returns to fixture mode. State the server already accepted stays; only future tool calls stay local. */
  public disableLiveEditing(): void {
    this.#live.disable();
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

  /** Actual published choices for the canonical GP layer picker; no map focus is inferred. */
  public listProcessSources(): Promise<readonly ProcessSourceChoice[]> {
    return this.#catalog.listProcessSources();
  }

  public resolveProcessSource(sourceId: string): Promise<{ processLayerId?: number; unavailableReason?: string }> {
    return this.#catalog.resolveProcessSource(sourceId);
  }

  /** Resolve an observed published receipt against the live catalog before adding it to the map. */
  public addPublishedLayer(
    layer: { readonly layerId: number; readonly serviceName: string; readonly layerName?: string },
    options?: { readonly isCurrent?: () => boolean },
  ): Promise<HonuaStudioCommandOutcome> {
    return this.#editor.addPublishedLayer(layer, options);
  }

  /** Undo/redo in the authoritative draft before advancing the visible history. */
  public applyHistoryAction(action: "undo" | "redo"): Promise<boolean> {
    return this.#editor.applyHistory(action);
  }

  /** Explicit human create action; never creates a draft as a side effect of viewing or chatting. */
  public createEditorDraft(
    packageKey: string,
    commandId?: string,
  ): Promise<EditorDraftIdentity | StudioApprovalPending> {
    return this.#drafts.create(packageKey, commandId);
  }

  /** Read the authorized durable draft after a native turn. Does not execute tools. */
  public attachEditorDraft(draftId: string, mayAccept?: () => void): Promise<void> {
    return this.#drafts.attach(draftId, mayAccept);
  }

  /** Idle observation for external draft changes; never discard an unsaved form value. */
  public refreshEditorDraft(): Promise<boolean> {
    return this.#drafts.refresh();
  }

  /** Flush accepted human edits before the host captures a durable native turn. */
  public prepareEditorTurn(): Promise<EditorDraftIdentity | undefined> {
    return this.#drafts.prepareTurn();
  }

  /** Save the active server draft as an immutable version; never publish it. */
  public saveEditorVersion(): Promise<StudioContentVersion> {
    return this.#publication.saveVersion();
  }

  /** List versions belonging to the active draft's server-owned content item. */
  public listEditorVersions(): Promise<readonly StudioContentVersion[]> {
    return this.#publication.listVersions();
  }

  /** Read the exact saved version for the host's human publication review. Never submits. */
  public reviewEditorRelease(versionId: string): Promise<StudioContentVersion> {
    return this.#publication.review(versionId);
  }

  /** Human host action only; see `EditorRelease.publish` for the retry contract. */
  public releaseEditorVersion(
    review: StudioContentVersion,
    request: StudioPublishRequestInput,
    commandId: string,
  ): ReturnType<EditorRelease["publish"]> {
    return this.#publication.publish(review, request, commandId);
  }

  /** Read an active item's publication receipt without flushing edits or submitting a mutation. */
  public readEditorRelease(versionId: string, requestId: string): ReturnType<EditorRelease["readPublication"]> {
    return this.#publication.readPublication(versionId, requestId);
  }

  /** Reopen a version of the active map as a new draft, preserving the saved version. */
  public reopenEditorVersion(versionId: string): Promise<void> {
    return this.#publication.reopenVersion(versionId);
  }

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
  public createRecipeDraft(input: ExploreDatasetInput, submissionId: string): Promise<EditorDraftIdentity> {
    return this.#recipes.createDraft(input, submissionId);
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
    this.#ensureThemeLoader().setThemeSet(value);
  }

  public get themeMode(): ThemeMode {
    const value = this.getAttribute("data-theme");
    return value === "light" || value === "dark" ? value : "auto";
  }

  public set themeMode(value: ThemeMode) {
    this.#ensureThemeLoader().setThemeMode(value);
  }

  public get themeSwitcherVisibility(): HonuaStudioThemeSwitcherVisibility {
    return this.getAttribute("theme-switcher") === "hidden" ? "hidden" : "visible";
  }

  public set themeSwitcherVisibility(value: HonuaStudioThemeSwitcherVisibility) {
    this.setAttribute("theme-switcher", value);
  }

  protected onConnect(_signal: AbortSignal): void {
    // The chrome markup depends on auth.mode, so auth resolves first; the hash router binds to its #view.
    this.#authority.resetAuth();
    this.#chrome.render();
    this.listen(this, "keydown", (event) => this.#applyHistoryShortcut(event as KeyboardEvent));
    this.#bootTheme();
    if (this.routingMode === "hash") this.#router.startHashRouting();
    else this.#router.followHostPath(this.getAttribute("current-path"));
    this.#children.ensureDefaults();
    if (this.#editorAgentAdapter) this.agentSessionAdapter = this.#editorAgentAdapter;
    this.#root.connectCanvas();
    // Construct the orchestrator while the chat child is resolvable for its activity log.
    void this.toolCallOrchestrator;
    void this.#live.resumeSharePreview();
    this.#listenForChildActivity();
    this.agentSessionAdapter = this.#editorAgentAdapter;
    if (this.#editorConversation.length) this.setEditorConversation(this.#editorConversation);
  }

  protected onDisconnect(): void {
    this.closeDesignInspector();
    this.#recipes.dispose();
    this.#chrome.dispose();
    if (!this.#editorAgentAdapter) this.#children.chat()?.detachAgentSession();
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
      if (!this.#router.followHostPath(newValue)) {
        if (oldValue === null) this.removeAttribute("current-path");
        else if (this.getAttribute("current-path") !== oldValue) this.setAttribute("current-path", oldValue);
        return;
      }
      this.#router.render();
      return;
    }
    if (name === "theme-switcher") {
      this.#chrome.render();
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
    this.#chrome.render();
    this.#router.render();
  }

  #ensureThemeLoader(): ThemeLoader {
    this.#themeLoader ??= new ThemeLoader(this, safeLocalStorage());
    return this.#themeLoader;
  }

  /** A host that already stamped a theme owns it; persisted state applies only otherwise. */
  #bootTheme(): void {
    const loader = this.#ensureThemeLoader();
    if (!this.hasAttribute("data-theme-set") && !this.hasAttribute("data-theme")) loader.boot();
  }

  #applyHistoryShortcut(event: KeyboardEvent): void {
    const action = historyShortcutAction(event);
    if (!action || !(action === "undo" ? this.composition.canUndo() : this.composition.canRedo())) return;
    event.preventDefault();
    void this.applyHistoryAction(action);
  }

  /** The panel's draft is the one on screen. Attach it before opening, and leave a dirty editor in place. */
  async #openStyleFromPanel(event: Event): Promise<void> {
    const reported = event.composedPath().find((node) => node instanceof HonuaStudioLifecyclePanelElement);
    const panel = reported instanceof HonuaStudioLifecyclePanelElement ? reported : undefined;
    try {
      const requested = panel?.draftId;
      if (requested && requested !== this.#drafts.identity?.draftId) {
        if (!this.hasUnsavedStyleChanges) await this.closeStyleEditor();
        await this.attachEditorDraft(requested);
      }
      await this.openStyleEditor();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "The style editor could not open.";
      const status =
        this.shadowRoot?.querySelector<HTMLElement>("[aria-label='Map style editor'] [role='status']") ??
        panel?.querySelector<HTMLElement>("[role='status']");
      if (status) status.textContent = message;
      else if (panel) panel.showActionError(message);
      else {
        const fallback = this.shadowRoot?.querySelector("honua-studio-lifecycle-panel");
        if (fallback instanceof HonuaStudioLifecyclePanelElement) fallback.showActionError(message);
      }
    }
  }

  /** Chat tool calls, lifecycle and GP panel activity arrive as composed events from descendants. */
  #listenForChildActivity(): void {
    this.listen(this, "honua-studio-chat-tool-call-result", (event) => {
      void this.#editor.handleChatToolCall((event as CustomEvent<HonuaStudioChatToolCallResultDetail>).detail);
    });
    const logged = [
      ["honua-studio-lifecycle-activity", "lifecycle_action"],
      ["honua-studio-gp-activity", "gp_action"],
    ] as const;
    for (const [type, entry] of logged) {
      this.listen(this, type, (event) => {
        const detail = (event as CustomEvent<HonuaStudioLifecycleActivityDetail | HonuaStudioGpActivityDetail>).detail;
        this.#children.chat()?.activityLog.append(entry, { ...detail });
      });
    }
    this.listen(this, "honua-studio-edit-style", (event) => {
      void this.#openStyleFromPanel(event);
    });
    this.listen(this, "honua-studio-release-view", (event) => {
      if (!this.#styleEditor.releaseForNavigation()) event.preventDefault();
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
  }
}
