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
import { type EpochToken, StalenessEpoch } from "../app/staleness-epoch.js";
import { HostAdapterAuthSession, verifiedSourcePathBase } from "../auth/host-session.js";
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
import { type CompositionState, createEmptyCompositionState } from "../composition/model.js";
import { canonicalCompositionJson } from "../composition/model.js";
import { applyCompositionCommands } from "../composition/reducer.js";
import type { DesignInspectorPanel } from "../design/design-inspector-panel.js";
import { StudioLifecycleClient } from "../lifecycle/lifecycle-client.js";
import type { StudioContentVersion, StudioPublishRequestInput } from "../lifecycle/lifecycle-types.js";
import type { StudioPackageDraftCreateRequest } from "../lifecycle/lifecycle-types.js";
import { WorkspaceDraftBinding } from "../lifecycle/workspace-draft.js";
import { createStudioAiMapKit } from "../map/agent-map-kit.js";
import { McpClient } from "../mcp/client.js";
import { StudioAuthoringMcpClient } from "../mcp/composition-authoring-contract.js";
import { MAP_COMPOSITION_ENVELOPE, toCompositionDraftBody } from "../mcp/composition-envelope.js";
import { ToolCallOrchestrator } from "../mcp/orchestrator.js";
import type { StudioMcpDraft, StudioPackageFamilyWire } from "../mcp/studio-tools.js";
import { resolveToolCall } from "../mcp/tool-bridge.js";
import { renderAbout } from "../pages/about.js";
import { renderContent } from "../pages/content.js";
import { renderHome } from "../pages/home.js";
import {
  type ExploreDatasetInput,
  type ExploreDatasetMetadata,
  compileExploreDataset,
} from "../recipes/explore-dataset.js";
import { RecipePanel } from "../recipes/recipe-panel.js";
import { RecipeSubmission } from "../recipes/recipe-submission.js";
import { Router } from "../router/router.js";
import { runtimeMcpBaseUrl, runtimeServerBaseUrl } from "../runtime-config.js";
import { ThemeLoader } from "../theme/theme-loader.js";
import type { ThemeMode, ThemeSet } from "../theme/theme-loader.js";
import { createCatalogWidgetDataLoader } from "../widgets/widget-data.js";
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

/** Package families whose drafts carry a composition body; mirrors the server gate and `mock-server.mjs`. */
const LIVE_COMPOSITION_FAMILIES: readonly StudioPackageFamilyWire[] = ["map", "app"];

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

/** Duck-typed: only sessions that own an external subscription expose `dispose()`. */
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

  #cookieLease = new StalenessEpoch();
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
  #designInspector: DesignInspectorPanel | undefined;
  #designInspectorContainer: HTMLElement | undefined;
  #designInspectorOpening = new StalenessEpoch();
  #designRelationship: { readonly interactionId: string; readonly ownerRef: string } | undefined;
  #designRelationshipState: CompositionState | undefined;
  #designRelationshipSelection: readonly unknown[] | undefined;
  public get selectedDesignRelationship(): { readonly interactionId: string; readonly ownerRef: string } | undefined {
    const relationship = this.#designRelationship;
    if (
      !relationship ||
      this.#designRelationshipSelection !== this.composition.selection ||
      this.#designRelationshipState !== this.composition.state ||
      !this.composition.state.interactions.some((entry) => entry.id === relationship.interactionId)
    )
      return undefined;
    const owner = this.composition.selection[0];
    const ref =
      owner && owner.kind !== "feature"
        ? `${owner.kind === "component" ? "widget" : owner.kind}:${owner.id}`
        : undefined;
    return ref === relationship.ownerRef ? { ...relationship } : undefined;
  }

  /** Shared embedded editor surface; hosts may open this beside their one conversation. */
  public async openDesignInspector(): Promise<void> {
    if (this.#designInspector) return;
    const opening = this.#designInspectorOpening.next();
    const generation = this.#workspaceAuthority.current;
    const identity = this.#workspaceDraft?.identity?.draftId;
    const { DesignInspectorPanel: Panel } = await import("../design/design-inspector-panel.js");
    if (
      !this.isConnected ||
      !this.#designInspectorOpening.isCurrent(opening) ||
      !this.#workspaceAuthority.isCurrent(generation) ||
      identity !== this.#workspaceDraft?.identity?.draftId
    )
      return;
    const container = document.createElement("div");
    container.id = "design-inspector-panel";
    this.shadowRoot?.querySelector(".app-slots")?.before(container);
    this.#designInspectorContainer = container;
    const canvas = this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas") ?? undefined;
    this.#designInspector = new Panel({
      container,
      controller: this.composition,
      canvas,
      describeSource: async (sourceId, signal) => {
        if (this.auth.getState().status !== "fresh") throw new Error("Sign in to describe authorized source fields.");
        const source = this.#sourceCatalog?.find((entry) => entry.id === sourceId);
        if (!source)
          throw new Error(
            "Source is absent from the authorized catalog. Refresh source access before describing fields.",
          );
        const baseUrl = canvas?.sourceAuthBaseUrl ?? runtimeMcpBaseUrl();
        const provider = new AuthoritativeStyleProvider({
          baseUrl,
          ...(baseUrl !== runtimeMcpBaseUrl() ? { catalogAliasBaseUrl: runtimeMcpBaseUrl() } : {}),
          documentUrl: document.baseURI,
          getAuth: () => this.auth,
          signal,
        });
        const fields = await provider.describeSource(source);
        signal.throwIfAborted();
        if (!this.#workspaceAuthority.isCurrent(generation) || identity !== this.#workspaceDraft?.identity?.draftId)
          throw new Error("The workspace draft or authority changed.");
        return fields;
      },
      select: (consumer, interactionId) => {
        this.#designRelationship =
          interactionId && this.composition.state.interactions.some((entry) => entry.id === interactionId)
            ? { interactionId, ownerRef: consumer.ref }
            : undefined;
        this.#designRelationshipState = this.composition.state;
        this.composition.select([consumer.target]);
        this.#designRelationshipSelection = this.composition.selection;
        this.dispatchTypedEvent("honua-studio-selection-change", {
          targets: [consumer.target],
          ...(this.selectedDesignRelationship ? { relationship: this.selectedDesignRelationship } : {}),
        });
      },
      close: () => {
        this.closeDesignInspector();
        this.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="design-inspector-toggle"]')?.focus();
      },
    });
    this.shadowRoot?.querySelector('[data-testid="design-inspector-toggle"]')?.setAttribute("aria-expanded", "true");
    container.querySelector<HTMLButtonElement>("button")?.focus();
  }

  public closeDesignInspector(): void {
    this.#designInspectorOpening.next();
    this.#designInspector?.dispose();
    this.#designInspector = undefined;
    this.#designInspectorContainer?.remove();
    this.#designInspectorContainer = undefined;
    this.#designRelationship = undefined;
    this.#designRelationshipState = undefined;
    this.#designRelationshipSelection = undefined;
    const toggle = this.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="design-inspector-toggle"]');
    toggle?.setAttribute("aria-expanded", "false");
  }
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
    const canvas = this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas");
    if (!canvas) throw new Error("Open the map canvas before its style editor.");
    if (!this.composition.state.mapSpec) {
      const binding = this.#workspaceDraft;
      const epoch = this.#workspaceAuthority.current;
      const pending = this.#workspaceDraftQueue.then(async () => {
        const style = await canvas.editableMapStyle();
        if (!this.#workspaceAuthority.isCurrent(epoch) || this.#workspaceDraft !== binding)
          throw new Error("The workspace authority changed.");
        const observed = await binding.initializeStyle(style);
        if (!this.#workspaceAuthority.isCurrent(epoch) || this.#workspaceDraft !== binding)
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
    const generation = this.#workspaceAuthority.current;
    const identity = this.#workspaceDraft?.identity;
    if (!identity) throw new Error("The workspace draft is unavailable.");
    const document = await canvas.editableMapStyle();
    if (!this.#workspaceAuthority.isCurrent(generation) || identity.draftId !== this.#workspaceDraft?.identity?.draftId)
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
        this.#workspaceAuthority.assertCurrent(generation, "The workspace authority changed.");
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
          !this.#workspaceAuthority.isCurrent(generation) ||
          identity.draftId !== this.#workspaceDraft?.identity?.draftId
        )
          throw new Error("The workspace authority changed. Reopen the visual editor.");
        const result = await this.#dispatchCommands([{ name: "setMapStyle", mapSpec: style }]);
        if (!result.ok) throw new Error(result.reason);
        this.#workspaceAuthority.assertCurrent(generation, "The workspace authority changed.");
        return canvas.editableMapStyle();
      },
      onDiscard: async () => {
        // Explicit discard permits authoritative refresh; no stale buffer is written.
        canvas.stylePreview = undefined;
        const id = this.#workspaceDraft?.identity?.draftId;
        if (!id || !this.#workspaceAuthority.isCurrent(generation)) throw new Error("The workspace authority changed.");
        const editor = this.#styleEditor;
        this.#styleEditor = undefined;
        try {
          await this.attachWorkspaceDraft(id);
        } finally {
          if (this.#workspaceAuthority.isCurrent(generation)) this.#styleEditor = editor;
          else editor?.dispose();
        }
        this.#workspaceAuthority.assertCurrent(generation, "The workspace authority changed.");
        return canvas.editableMapStyle();
      },
    });
    const editor = this.#styleEditor;
    this.#styleEditorUnsubscribe = this.composition.subscribe(() => {
      if (editor.dirty) return;
      void canvas
        .editableMapStyle()
        .then((style) => {
          if (this.#styleEditor === editor && this.#workspaceAuthority.isCurrent(generation))
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
  #activeMap = new StalenessEpoch();
  #workspacePublicationReviews = new WeakMap<
    StudioContentVersion,
    {
      binding: WorkspaceDraftBinding;
      generation: EpochToken;
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
  #workspaceAuthority = new StalenessEpoch();
  #workspaceDraftConflict = false;
  #workspaceDraftQueue: Promise<unknown> = Promise.resolve();
  #historyUnsubscribe: (() => void) | undefined;
  #historyBusy = false;
  #orchestrator: ToolCallOrchestrator | undefined;
  #liveCompositionPackageKey: string | undefined;
  #aiMapKit: HonuaAiMapKit | undefined;
  #sourceCatalog: readonly CatalogDataset[] | undefined;
  #processSourceCatalogAuthority: EpochToken | undefined;
  #catalogRequested = false;
  #catalogFromHost = false;
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
      this.#session && "kind" in this.#session && this.#session.kind === "cookie"
        ? verifiedSourcePathBase(this.#session.sourcePathBase)
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
    const outlet = this.shadowRoot?.querySelector<HTMLElement>("[data-recipe-outlet]");
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
    this.shadowRoot?.querySelector("[data-testid='recipe-toggle']")?.setAttribute("aria-expanded", "true");
    this.#recipePanel.resume();
  }

  public closeRecipePicker(): void {
    this.#recipePanel?.cancelDiscovery();
    for (const entry of this.#recipeSubmissions.values())
      if (entry.pending) {
        entry.attachmentAllowed = false;
        entry.metadataAbort?.abort();
      }
    const outlet = this.shadowRoot?.querySelector<HTMLElement>("[data-recipe-outlet]");
    if (outlet) outlet.hidden = true;
    const button = this.shadowRoot?.querySelector<HTMLButtonElement>("[data-testid='recipe-toggle']");
    button?.setAttribute("aria-expanded", "false");
    button?.focus();
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
    const leaseGeneration = this.#cookieLease.current;
    this.#recipeSourcesAuthority = undefined;
    this.#recipeSourceChoices = undefined;
    const hostOwnsCatalog = this.#catalogFromHost;
    const hostCatalog = this.#sourceCatalog;
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
      !this.#cookieLease.isCurrent(leaseGeneration)
    )
      throw new Error("The workspace authority changed.");
    let choices: readonly CatalogDataset[] = catalog;
    if (hostOwnsCatalog) {
      if (!this.#catalogFromHost || hostCatalog !== this.#sourceCatalog)
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
      if (this.#catalogFromHost) throw new Error("The host source choices changed. Refresh the recipe sources.");
      this.#applySourceCatalog(catalog);
    }
    this.#recipeSourceChoices = structuredClone(choices);
    this.#recipeSourcesAuthority = generation;
    return structuredClone(choices);
  }

  public async resolveRecipeSource(sourceId: string, signal: AbortSignal): Promise<ExploreDatasetMetadata> {
    const generation = this.#recipeAuthority.current;
    let choices = this.#recipeSourceChoices;
    let selectedSource = choices?.find((entry) => entry.id === sourceId);
    let current = this.#sourceCatalog?.find((entry) => entry.id === sourceId);
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
      current = this.#sourceCatalog?.find((entry) => entry.id === sourceId);
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
        originalDraftId: this.#workspaceDraft?.identity?.draftId,
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
        submission.originalDraftId = this.#workspaceDraft?.identity?.draftId;
        submission.originalDraftGeneration = this.#workspaceDraft?.identity?.generation;
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
      const activeDraftId = this.#workspaceDraft?.identity?.draftId;
      if (!submission.attachmentAllowed)
        throw new Error(
          `Creation returned draft ${created.draftId} after this picker was closed. Reopen and retry this submission to attach that same draft.`,
        );
      if (activeDraftId === created.draftId) return this.#workspaceDraft!.identity!;
      if (
        activeDraftId !== submission.originalDraftId ||
        this.#workspaceDraft?.identity?.generation !== submission.originalDraftGeneration
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
        const current = this.#workspaceDraft?.identity;
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
        await this.#queueWorkspaceDraft(created.draftId, mayAttach);
      } finally {
        this.#recipeDraftToAttach = undefined;
      }
      const identity = this.#workspaceDraft?.identity;
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
  public async createWorkspaceDraft(
    packageKey: string,
  ): Promise<{ draftId: string; generation: number; packageKey: string }> {
    const key = packageKey.trim();
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(key))
      throw new Error("Use 1–200 letters, numbers, dots, dashes or underscores for the package key.");
    const generation = this.#workspaceAuthority.current;
    await this.prepareWorkspaceTurn();
    this.#workspaceAuthority.assertCurrent(generation, "The workspace session changed.");
    const client = new StudioLifecycleClient({ baseUrl: runtimeServerBaseUrl(), auth: this.auth });
    const created = await client.createDraft({
      packageKey: key,
      envelope: {
        ...MAP_COMPOSITION_ENVELOPE,
        body: toCompositionDraftBody(createEmptyCompositionState(), key),
      },
    });
    this.#workspaceAuthority.assertCurrent(generation, "The workspace session changed.");
    await this.attachWorkspaceDraft(created.draftId);
    const identity = this.#workspaceDraft?.identity;
    if (!identity || identity.draftId !== created.draftId) throw new Error("The created draft was not attached.");
    return identity;
  }

  /** Read the authorized durable draft after a native turn. Does not execute tools. */
  public attachWorkspaceDraft(draftId: string): Promise<void> {
    return this.#queueWorkspaceDraft(draftId);
  }

  #queueWorkspaceDraft(draftId: string, mayAccept?: () => void): Promise<void> {
    if (draftId !== this.#workspaceDraft?.identity?.draftId) this.closeDesignInspector();
    const generation = this.#workspaceAuthority.current;
    const run = this.#workspaceDraftQueue.then(() => this.#observeWorkspaceDraft(draftId, generation, mayAccept));
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
      if (state.binding !== this.#workspaceDraft || !this.#workspaceAuthority.isCurrent(state.generation))
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

  /** Read an active item's publication receipt without flushing edits or submitting a mutation. */
  public async readWorkspacePublication(
    versionId: string,
    requestId: string,
  ): ReturnType<StudioLifecycleClient["getPublicationRequest"]> {
    const binding = this.#workspaceDraft;
    const generation = this.#workspaceAuthority.current;
    const identity = binding?.identity;
    if (!binding || !identity) throw new Error("Open a map draft before reading its publication.");
    if (![versionId, requestId].every((id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id)))
      throw new Error("Version and publication request IDs are required.");
    const current = () => {
      if (binding !== this.#workspaceDraft || !this.#workspaceAuthority.isCurrent(generation))
        throw new Error("The workspace session or map changed.");
    };
    current();
    const client = new StudioLifecycleClient({ baseUrl: runtimeServerBaseUrl(), auth: this.auth });
    const draft = await client.getDraft(identity.draftId);
    current();
    if (draft.draftId !== identity.draftId || draft.packageKey !== identity.packageKey)
      throw new Error("The publication draft does not belong to the active map.");
    const receipt = await client.getPublicationRequest(draft.itemId, versionId, requestId);
    current();
    if (receipt.itemId !== draft.itemId || receipt.versionId !== versionId || receipt.requestId !== requestId)
      throw new Error("The publication receipt does not belong to the selected version.");
    return receipt;
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
      generation: EpochToken,
    ) => Promise<T>,
  ): Promise<T> {
    const binding = this.#workspaceDraft;
    const generation = this.#workspaceAuthority.current;
    const identity = binding?.identity;
    if (!binding || !identity) throw new Error("Open a map draft before using saved versions.");
    await this.prepareWorkspaceTurn();
    const current = () => {
      if (!this.#workspaceAuthority.isCurrent(generation) || binding !== this.#workspaceDraft)
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

  async #observeWorkspaceDraft(draftId: string, generation: EpochToken, mayAccept?: () => void): Promise<void> {
    this.#workspaceAuthority.assertCurrent(generation, "The workspace session changed.");
    mayAccept?.();
    if (this.#hasDirtyWorkspaceForm()) throw new Error("Save pending Studio edits before attaching a draft.");
    const previous = this.#workspaceDraft?.identity;
    // Observe prospectively: a refused read must not advance the active binding's generation.
    const binding = new WorkspaceDraftBinding(
      new StudioLifecycleClient({ baseUrl: runtimeServerBaseUrl(), auth: this.auth }),
    );
    const state = await binding.observe(draftId);
    this.#workspaceAuthority.assertCurrent(generation, "The workspace session changed.");
    mayAccept?.();
    if (this.#hasDirtyWorkspaceForm()) throw new Error("Save pending Studio edits before attaching a draft.");
    // A same-principal lease can renew while the prospective GET is in flight.
    // Adopt its observed state with the current transport, not the expired lease.
    binding.rebind(new StudioLifecycleClient({ baseUrl: runtimeServerBaseUrl(), auth: this.auth }));
    if (previous?.draftId !== draftId) this.closeDesignInspector();
    if (previous?.draftId !== draftId && this.#recipeDraftToAttach !== draftId) this.#disposeRecipePicker();
    if (previous?.draftId !== draftId) this.#activeMap.next();
    this.#workspaceDraft = binding;
    this.#workspaceDraftConflict = false;
    const reset = previous?.draftId !== draftId || previous?.generation !== binding.identity?.generation;
    const attach = reset
      ? this.composition.resetBaseline.bind(this.composition)
      : this.composition.replaceState.bind(this.composition);
    attach({
      ...state,
      pins: previous?.draftId === draftId ? this.composition.state.pins : state.pins,
      annotations: previous?.draftId === draftId ? this.composition.state.annotations : state.annotations,
    });
    if (previous?.draftId !== draftId) {
      this.composition.clearSelection();
      this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas")?.resetExploration();
    }
    this.#announceWorkspaceDraft();
  }

  /** Idle observation for external draft changes; never discard an unsaved form value. */
  public async refreshWorkspaceDraft(): Promise<boolean> {
    const binding = this.#workspaceDraft;
    const generation = this.#workspaceAuthority.current;
    await this.#workspaceDraftQueue;
    const identity = binding?.identity;
    if (!identity || binding !== this.#workspaceDraft || this.#historyBusy || this.#workspaceDraftConflict)
      return false;
    if (this.#hasDirtyWorkspaceForm()) return false;
    try {
      await this.attachWorkspaceDraft(identity.draftId);
    } catch (error) {
      if (
        !this.#workspaceAuthority.isCurrent(generation) ||
        this.#historyBusy ||
        this.#workspaceDraftConflict ||
        this.#hasDirtyWorkspaceForm()
      )
        return false;
      throw error;
    }
    return this.#workspaceAuthority.isCurrent(generation) && !this.#hasDirtyWorkspaceForm();
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
        if (
          element.tagName === "HONUA-STUDIO-CHAT" ||
          element.tagName === "HONUA-STUDIO-CONTROL-BAR" ||
          this.#styleEditorPanel?.contains(element) ||
          this.shadowRoot?.querySelector("[data-recipe-outlet]")?.contains(element)
        )
          continue;
        if (element instanceof HTMLInputElement) {
          const checkable = element.type === "checkbox" || element.type === "radio";
          if (checkable ? element.checked !== element.defaultChecked : element.value !== element.defaultValue)
            return true;
        } else if (element instanceof HTMLTextAreaElement && element.value !== element.defaultValue) return true;
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
    const authGeneration = this.#workspaceAuthority.current;
    this.#historyBusy = true;
    this.paintHistoryControls();
    try {
      let applied: boolean;
      if (this.#workspaceDraft) {
        const target = action === "undo" ? this.composition.history.peekUndo() : this.composition.history.peekRedo();
        if (!target) return false;
        const binding = this.#workspaceDraft;
        const generation = this.#workspaceAuthority.current;
        const run = this.#workspaceDraftQueue.then(async () => {
          this.#workspaceAuthority.assertCurrent(generation, "The workspace session changed.");
          const observed = await binding.replace(target);
          this.#workspaceAuthority.assertCurrent(generation, "The workspace session changed.");
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
      if (this.#workspaceDraft && this.#workspaceAuthority.isCurrent(authGeneration))
        this.#workspaceDraftConflict = true;
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
   * Host-injected session adapter (docs/embed-session.md); same shape as
   * `window.__HONUA_STUDIO_HOST_SESSION__`, and a host uses one or the other. Unset means the window
   * global if present, else standalone OIDC. Reassigning while connected rebuilds `.auth`.
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
      this.closeDesignInspector();
      this.#resetRecipeAuthority();
      this.#disposeStyleEditor();
      this.#workspaceAuthority.next();
      if (hadAuthority) {
        // Cached human descriptor metadata belongs to the former authority too.
        this.#sourceCatalog = undefined;
        this.#processSourceCatalogAuthority = undefined;
        this.#catalogRequested = false;
        this.#aiMapKit = undefined;
        const previousCanvas = this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas");
        if (previousCanvas) previousCanvas.sourceCatalog = undefined;
      }
      this.#workspaceDraft = undefined;
      this.#workspaceDraftConflict = false;
      this.composition.resetBaseline(createEmptyCompositionState());
      this.composition.clearSelection();
      this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas")?.resetExploration();
      if (hadAuthority) this.#announceWorkspaceDraft();
    }
    this.#session = session;
    this.#cookieLease.next();
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
    if (
      samePrincipal &&
      this.#auth instanceof HostAdapterAuthSession &&
      session &&
      "kind" in session &&
      session.kind === "cookie"
    )
      this.#auth.renewCookie(session);
    else this.resetAuth();
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
    if (!samePrincipal) this.#chromeBuilt = false;
    this.renderChrome();
    // Routes receive `auth` as an argument, so re-render the current route once with the new session.
    if (this.routingMode === "hash") this.#setupHashRouter();
    else this.renderView();
    // The catalog is bearer-gated, so a new session needs a new catalog.
    this.#refreshSourceCatalog(Boolean(samePrincipal));
  }

  /** The resolved `AuthSession` this element and its descendants (`resolveInjectedAuth`) use; built lazily. */
  public get auth(): AuthSession {
    return this.#auth ?? this.resetAuth();
  }

  /** Catalog and packages client bound to `.auth`; assign one for fixtures and tests. */
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

  /** Composition state the canvas renders; it survives reconnection. */
  public get composition(): CompositionController {
    if (!this.#composition) this.#composition = new CompositionController(createEmptyCompositionState());
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
  public async listProcessSources(): Promise<readonly { id: string; title: string }[]> {
    const generation = this.#workspaceAuthority.current;
    const auth = this.auth;
    const client = this.#studioClientOverridden
      ? this.studioClient
      : new StudioClient(runtimeServerBaseUrl(), auth, runtimeMcpBaseUrl());
    const catalog = await client.listCatalog();
    if (!this.#workspaceAuthority.isCurrent(generation) || auth !== this.auth)
      throw new Error("The workspace authority changed.");
    this.#applySourceCatalog(catalog);
    this.#processSourceCatalogAuthority = generation;
    return catalog
      .filter(
        (source) => typeof source.locator?.serviceId === "string" && Number.isSafeInteger(source.locator?.layerId),
      )
      .map((source) => ({ id: source.id, title: source.title ?? source.id }));
  }

  public async resolveProcessSource(
    sourceId: string,
  ): Promise<{ processLayerId?: number; unavailableReason?: string }> {
    const generation = this.#workspaceAuthority.current;
    const source = this.#sourceCatalog?.find((entry) => entry.id === sourceId);
    if (!source || this.#processSourceCatalogAuthority !== generation)
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
    this.#workspaceAuthority.assertCurrent(generation, "The workspace authority changed.");
    return result;
  }

  /** Read-only style discovery pinned to this human authority; lease renewal may refresh transport only. */
  public createWorkspaceStyleProvider(
    options: { readonly getAuthority?: () => unknown; readonly signal?: AbortSignal } = {},
  ): AuthoritativeStyleProvider {
    const generation = this.#workspaceAuthority.current;
    const authority = options.getAuthority?.();
    const baseUrl =
      this.#session && "kind" in this.#session && this.#session.kind === "cookie"
        ? verifiedSourcePathBase(this.#session.sourcePathBase)
        : runtimeMcpBaseUrl();
    return new AuthoritativeStyleProvider({
      baseUrl,
      ...(baseUrl !== runtimeMcpBaseUrl() ? { catalogAliasBaseUrl: runtimeMcpBaseUrl() } : {}),
      documentUrl: window.document.baseURI,
      signal: options.signal,
      getAuth: () => {
        if (!this.#workspaceAuthority.isCurrent(generation) || options.getAuthority?.() !== authority)
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
    return this.#sourceCatalog;
  }

  public set sourceCatalog(catalog: readonly CatalogDataset[] | undefined) {
    // A host that assigns the catalog owns it: no fetch overwrites it.
    // Lease renewal retains it; another authority must supply a fresh catalog.
    this.#catalogFromHost = true;
    this.#catalogRequested = true;
    if (catalog !== this.#sourceCatalog) this.#disposeRecipePicker();
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
    if (catalog !== this.#sourceCatalog) this.closeDesignInspector();
    if (catalog !== this.#sourceCatalog) {
      if (this.#recipeSourceChoices) this.#recipePreviousChoices = this.#recipeSourceChoices;
      this.#recipeSourcesAuthority = undefined;
      this.#recipeSourceChoices = undefined;
    }
    this.#sourceCatalog = catalog;
    // The kit advertises the catalog, so it has to be rebuilt around a new one.
    this.#aiMapKit = undefined;
    const canvas = this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas");
    if (canvas) canvas.sourceCatalog = catalog;
    if (this.isConnected && this.#orchestrator?.isLive) this.#scheduleLiveAgentSession();
  }

  /** Fetches the catalog once. Failure is silent: the canvas reports layers as not renderable instead. */
  async #loadSourceCatalog(revalidate = false): Promise<void> {
    if (this.#catalogRequested || (!revalidate && this.#sourceCatalog !== undefined)) return;
    // Never fetch while signed out: a second 401 marks the session expired, which would show a
    // never-signed-in shell as "Session expired". The auth status listener retries once signed in.
    const status = this.auth.getState().status;
    if (status !== "fresh" && status !== "refreshing") return;
    this.#catalogRequested = true;
    try {
      const generation = this.#workspaceAuthority.current;
      const auth = this.auth;
      const previousCatalog = this.#sourceCatalog;
      const catalog = await this.studioClient.listCatalog();
      if (
        !this.isConnected ||
        !this.#workspaceAuthority.isCurrent(generation) ||
        auth !== this.auth ||
        this.#sourceCatalog !== previousCatalog
      )
        return;
      if (previousCatalog && canonicalCompositionJson(previousCatalog) === canonicalCompositionJson(catalog)) return;
      this.#applySourceCatalog(catalog);
    } catch {
      // An unreachable catalog degrades the map; it must not break the shell.
    }
  }

  /**
   * Re-fetches the catalog after the session changed. Only call it on a session replacement or a status
   * transition: every `getAccessToken()` dispatches a state change, so refetching per dispatch would loop.
   */
  #refreshSourceCatalog(preserve = false): void {
    if (this.#catalogFromHost) return;
    if (preserve) this.#recipeSourcesAuthority = undefined;
    else this.#sourceCatalog = undefined;
    this.#catalogRequested = false;
    void this.#loadSourceCatalog(preserve);
  }

  #onAuthStatusChanged(): void {
    if (!this.isConnected) return;
    const status = this.#auth?.getState().status;
    if (status === this.#lastAuthStatus) return;
    this.#lastAuthStatus = status;
    if (status === "expired" || status === "signed-out") this.closeDesignInspector();
    if (status === "signed-out" || status === "expired") this.#resetRecipeAuthority();
    if (status !== "fresh" || this.#sourceCatalog !== undefined) return;
    this.#refreshSourceCatalog();
  }

  /** SDK AI map kit over `.composition`; rebuilt with the catalog so a model only sees published sources. */
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

  /** Rebuilds `.auth` from the current `.session`, disposing the previous one. */
  private resetAuth(): AuthSession {
    this.#authUnsubscribe?.();
    this.#authUnsubscribe = undefined;
    disposeAuthSession(this.#auth);
    if (!this.#studioClientOverridden) this.#studioClient = undefined;

    const auth = createAuthSession({ hostAdapter: this.#session });
    this.#auth = auth;
    this.#workspaceDraft?.rebind(new StudioLifecycleClient({ baseUrl: runtimeServerBaseUrl(), auth }));
    // Never renderView() from this listener: every getAccessToken() dispatches a state change and the home
    // route fetches with a token, so re-rendering routes here loops forever. Routes subscribe themselves.
    this.#authUnsubscribe = auth.subscribe(() => {
      this.paintAuthControls();
      this.#onAuthStatusChanged();
    });
    if (this.isConnected) void this.completeStandaloneRedirectCallback(auth);
    return auth;
  }

  /** Completes a standalone OIDC redirect back to this page, at most once; a no-op otherwise. */
  private async completeStandaloneRedirectCallback(auth: AuthSession): Promise<void> {
    if (this.#redirectCallbackHandled) return;
    if (auth.mode !== "standalone" || !auth.isRedirectCallback()) return;
    this.#redirectCallbackHandled = true;
    try {
      await auth.handleRedirectCallback();
    } catch {
      // The auth state already shows the failure; the shell stays usable so the user can retry sign-in.
    }
    window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
  }

  /** Binds a fresh hash router to the current `#view`; a chrome rebuild replaces that node. */
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
    // The chrome markup depends on auth.mode, so auth resolves first.
    this.resetAuth();

    // The hash router binds to #view, so the chrome exists before it.
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
    // A host that already stamped a theme owns it; persisted state applies only otherwise.
    if (!this.hasAttribute("data-theme-set") && !this.hasAttribute("data-theme")) {
      loader.boot();
    }

    const basePath = this.getAttribute("base-path");
    if (this.routingMode === "hash") {
      this.#setupHashRouter();
    } else {
      this.#currentPath = stripBasePath(normalizePath(this.getAttribute("current-path") ?? "/"), basePath);
    }

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
        this.#session && "kind" in this.#session && this.#session.kind === "cookie"
          ? verifiedSourcePathBase(this.#session.sourcePathBase)
          : runtimeMcpBaseUrl();
    if (canvas && !canvas.composition) canvas.composition = this.composition;
    if (canvas && !canvas.commandDispatch) canvas.commandDispatch = (commands) => this.#dispatchCommands(commands);
    if (canvas && this.#sourceCatalog) canvas.sourceCatalog = this.#sourceCatalog;
    else void this.#loadSourceCatalog();
    // Construct the orchestrator while the chat child is resolvable for its activity log.
    void this.toolCallOrchestrator;
    void this.#resumeSharePreview();
    this.listen(this, "honua-studio-chat-tool-call-result", (event) => {
      const detail = (event as CustomEvent<HonuaStudioChatToolCallResultDetail>).detail;
      void this.#handleChatToolCall(detail);
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
  public async addPublishedLayer(
    layer: { readonly layerId: number; readonly serviceName: string; readonly layerName?: string },
    options?: { readonly isCurrent?: () => boolean },
  ): Promise<HonuaStudioCommandOutcome> {
    let auth = this.auth;
    let leaseGeneration = this.#cookieLease.current;
    const mapEpoch = this.#activeMap.current;
    const authorityGeneration = this.#workspaceAuthority.current;
    const requireOriginalTarget = () => {
      if (
        !this.#activeMap.isCurrent(mapEpoch) ||
        !this.#workspaceAuthority.isCurrent(authorityGeneration) ||
        options?.isCurrent?.() === false
      )
        throw new Error("The active map changed while resolving the published layer. Review the map and try again.");
    };
    requireOriginalTarget();
    let catalog = await this.studioClient.listCatalog();
    requireOriginalTarget();
    if (this.auth !== auth || !this.#cookieLease.isCurrent(leaseGeneration)) {
      // A same-authority cookie lease may renew during discovery. Re-read with
      // its new credentials; never dispatch a catalog captured by the old lease.
      auth = this.auth;
      leaseGeneration = this.#cookieLease.current;
      catalog = await this.studioClient.listCatalog();
      requireOriginalTarget();
      if (this.auth !== auth || !this.#cookieLease.isCurrent(leaseGeneration))
        throw new Error("The Studio target changed while resolving the published layer.");
    }
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
    return this.#dispatchCommands(
      [{ name: "addLayer", layer: { id: source.id, sourceId: source.id, title: layer.layerName ?? source.title } }],
      options,
    );
  }

  /**
   * The one composition write path for widgets, chat and the editor. Commands run in order and stop at the
   * first failure: a compare switch's two toggles are one gesture, and half of it landing is worse than none.
   */
  async #dispatchCommands(
    commands: readonly CompositionCommand[],
    options?: { readonly isCurrent?: () => boolean },
  ): Promise<HonuaStudioCommandOutcome> {
    if (options?.isCurrent?.() === false) return { ok: false, reason: "The initiating view changed." };
    if (this.hasUnsavedStyleChanges && commands.some((command) => command.name !== "setMapStyle"))
      return { ok: false, reason: "Save or discard visual style edits before changing the map." };
    if (this.#workspaceDraft) {
      const binding = this.#workspaceDraft;
      const generation = this.#workspaceAuthority.current;
      const run = this.#workspaceDraftQueue.then(async (): Promise<HonuaStudioCommandOutcome> => {
        if (options?.isCurrent?.() === false)
          return { ok: false, reason: "The initiating view changed before the edit began." };
        try {
          this.#workspaceAuthority.assertCurrent(generation, "The workspace session changed.");
          if (binding !== this.#workspaceDraft) throw new Error("The active map changed before the edit began.");
          const styleCommand = commands.length === 1 && commands[0]?.name === "setMapStyle" ? commands[0] : undefined;
          const current = this.composition.state;
          let anchor = current;
          if (styleCommand) {
            const canvas = this.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas");
            if (!canvas) throw new Error("Open the map canvas before editing its style.");
            const mapSpec = await canvas.editableMapStyle();
            if (!this.#workspaceAuthority.isCurrent(generation) || binding !== this.#workspaceDraft)
              throw new Error("The workspace session changed.");
            if (current !== this.composition.state || options?.isCurrent?.() === false)
              throw new Error("The map changed while preparing its style.");
            // New composition sources are resolved by the authorized canvas, not
            // supplied by the editor. Validate its candidate against that snapshot.
            anchor = { ...current, mapSpec };
          }
          const target = applyCompositionCommands(anchor, commands).state;
          const observed = styleCommand
            ? {
                ...(await binding.replaceStyle(styleCommand.mapSpec)),
                pins: target.pins,
                annotations: target.annotations,
              }
            : await binding.replace(target);
          this.#workspaceAuthority.assertCurrent(generation, "The workspace session changed.");
          // The accepted style response establishes one authoritative revision;
          // replaying it against the older source anchor would reject valid additions.
          if (!styleCommand) for (const command of commands) this.composition.apply(command);
          this.composition.replaceState(observed);
          this.#announceWorkspaceDraft();
          return { ok: true };
        } catch (error) {
          if (this.#workspaceAuthority.isCurrent(generation) && binding === this.#workspaceDraft)
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

  /** Resolves one chat tool-call intent. Never throws: every outcome lands in the activity log. */
  async #handleChatToolCall(detail: HonuaStudioChatToolCallResultDetail): Promise<void> {
    if (!detail.toolName) return;
    const args = isPlainObject(detail.arguments) ? detail.arguments : {};
    if (this.#workspaceDraft) {
      const resolved = resolveToolCall({ toolName: detail.toolName, arguments: args });
      const outcome = resolved.ok ? await this.#dispatchCommands([resolved.command]) : resolved;
      if (!outcome.ok)
        this.querySelector<HonuaStudioChatElement>("honua-studio-chat")?.activityLog.append("assistant_turn_error", {
          phase: "workspace-command",
          errorMessage: outcome.reason,
        });
      return;
    }
    await this.toolCallOrchestrator.handleToolCall({ toolName: detail.toolName, arguments: args });
  }

  protected onDisconnect(): void {
    this.closeDesignInspector();
    this.#disposeRecipePicker();
    this.#historyUnsubscribe?.();
    this.#historyUnsubscribe = undefined;
    if (!this.#workspaceAgentAdapter) {
      this.querySelector<HonuaStudioChatElement>("honua-studio-chat")?.detachAgentSession();
    }
    this.#agentSetup.next();
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
      // Re-run onConnect's routing setup on the still-live connection signal, so its listeners still clean up.
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
    // An embed host owns sign-in/out, so host-adapter mode renders only a status label.
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
          <div class="app-composition-mode" data-testid="live-composition" role="group" aria-label="Composition mode">
            <span class="hn-badge" data-testid="live-composition-status">${FIXTURE_MODE_LABEL}</span>
            <button type="button" class="hn-btn hn-btn--sm" data-testid="history-undo" disabled>Undo</button>
            <button type="button" class="hn-btn hn-btn--sm" data-testid="history-redo" disabled>Redo</button>
            <button type="button" class="hn-btn hn-btn--sm" data-testid="design-inspector-toggle" aria-expanded="false" aria-controls="design-inspector-panel">Inspect data and interactions</button>
            <span class="hn-muted" data-testid="history-status" role="status"></span>
            <button type="button" class="hn-btn hn-btn--sm" data-testid="recipe-toggle" aria-expanded="false" aria-controls="recipe-outlet">Start from a recipe</button>
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
        <div id="recipe-outlet" data-recipe-outlet hidden></div>
        <div class="app-slots" data-testid="app-slots">
          <slot name="chat" ${this.#workspaceAgentAdapter ? "hidden" : ""}></slot>
          <slot name="canvas"></slot>
        </div>
      </div>
    `);
    this.#chromeBuilt = true;

    const root = this.shadowRoot;
    const signal = this.connectedSignal;
    root?.querySelector("[data-testid='recipe-toggle']")?.addEventListener(
      "click",
      () => {
        const outlet = root.querySelector<HTMLElement>("[data-recipe-outlet]");
        if (outlet?.hidden) this.openRecipePicker();
        else this.closeRecipePicker();
      },
      { signal },
    );
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
    root?.querySelector('[data-testid="design-inspector-toggle"]')?.addEventListener(
      "click",
      () => {
        if (this.#designInspector) this.closeDesignInspector();
        else void this.openDesignInspector();
      },
      { signal },
    );
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

  /** Listeners are `connectedSignal`-scoped, so a chrome rebuild never doubles them up. */
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
