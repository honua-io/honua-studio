import { isCookieSession, isSameCookiePrincipal, verifiedSourcePathBase } from "../auth/host-session.js";
import type { SessionAdapter } from "../auth/index.js";
import type { CompositionCommand } from "../composition/commands.js";
import { CompositionController } from "../composition/controller.js";
import { createEmptyCompositionState } from "../composition/model.js";
import { dispatchWithDeprecatedAlias } from "../elements/deprecated-aliases.js";
import type { HonuaStudioAppElement } from "../elements/studio-app-element.js";
import { CompositionEditor } from "./composition-editor.js";
import { DesignInspectorHost } from "./design-inspector-host.js";
import { hasEditedFormControl } from "./dirty-form.js";
import { LiveCompositionController } from "./live-composition-controller.js";
import { RecipeController } from "./recipe-controller.js";
import { ShellChrome } from "./shell-chrome.js";
import { ShellRouter } from "./shell-router.js";
import { SourceCatalog } from "./source-catalog.js";
import { StudioAppChildren } from "./studio-app-children.js";
import { StyleEditorHost } from "./style-editor-host.js";
import { EditorAuthority } from "./workspace-authority.js";
import { EditorDraftSession } from "./workspace-draft-session.js";
import { EditorRelease } from "./workspace-publication.js";

/** The protected `HonuaStudioElementBase` members the shell chrome needs. */
export interface StudioShellAccess {
  readonly setShadowHtml: (html: string) => void;
  readonly connectedSignal: () => AbortSignal | undefined;
}

/**
 * The composition root behind `<honua-studio-app>`: builds every controller, wires the hooks between them
 * and owns the policies that span them, such as revoking a former authority when the session changes.
 */
export class StudioAppRoot {
  readonly composition = new CompositionController(createEmptyCompositionState());
  readonly children: StudioAppChildren;
  readonly authority: EditorAuthority;
  readonly chrome: ShellChrome;
  readonly router: ShellRouter;
  readonly catalog: SourceCatalog;
  readonly drafts: EditorDraftSession;
  readonly publication: EditorRelease;
  readonly editor: CompositionEditor;
  readonly designInspector: DesignInspectorHost;
  readonly styleEditor: StyleEditorHost;
  readonly recipes: RecipeController;
  readonly live: LiveCompositionController;
  #lastAuthStatus: string | undefined;

  constructor(
    private readonly host: HonuaStudioAppElement,
    shell: StudioShellAccess,
  ) {
    this.children = new StudioAppChildren(host);
    this.authority = this.#createAuthority();
    this.chrome = this.#createChrome(shell);
    this.router = this.#createRouter();
    this.catalog = this.#createCatalog();
    this.drafts = this.#createDrafts();
    this.publication = new EditorRelease(this.authority, this.drafts, {
      prepareEditorTurn: () => host.prepareEditorTurn(),
      saveCurrentView: (current) => this.#saveCurrentView(current),
    });
    this.editor = this.#createEditor();
    this.designInspector = new DesignInspectorHost({ host, ...this.#editingParts(), children: this.children });
    this.styleEditor = new StyleEditorHost({
      host,
      ...this.#editingParts(),
      editor: this.editor,
      children: this.children,
    });
    this.recipes = new RecipeController({
      host,
      authority: this.authority,
      catalog: this.catalog,
      drafts: this.drafts,
      chrome: this.chrome,
    });
    this.live = new LiveCompositionController({
      host,
      catalog: this.catalog,
      chrome: this.chrome,
      children: this.children,
    });
  }

  /** A workspace host (agent adapter or cookie session) owns navigation and the composer. */
  isEditorHost(): boolean {
    return Boolean(this.host.agentSessionAdapter) || this.authority.hasCookieSession;
  }

  syncHostMode(): void {
    const workspaceHost = this.isEditorHost();
    this.host.toggleAttribute("data-editor-host", workspaceHost);
    if (workspaceHost) this.router.stop();
    if (this.host.isConnected) this.router.render();
  }

  /** A same-principal cookie session renews the lease in place; any other session replaces the authority. */
  replaceSession(session: SessionAdapter | undefined): void {
    if (this.authority.session === session) return;
    if (isCookieSession(session)) verifiedSourcePathBase(session.sourcePathBase);
    const renewsLease = isSameCookiePrincipal(this.authority.session, session);
    if (!renewsLease) this.#revokeAuthority();
    this.authority.adoptSession(session);
    this.syncHostMode();
    const canvas = this.children.canvas();
    if (canvas) canvas.sourceAuthBaseUrl = this.authority.sourceBaseUrl;
    if (!this.host.isConnected) {
      this.authority.disposeAuth();
      this.authority.forgetStudioClient();
      return;
    }
    if (!(renewsLease && isCookieSession(session) && this.authority.renewCookieLease(session)))
      this.authority.resetAuth();
    // A host-owned catalog does not reload on session replacement, so its widget rows are invalidated
    // explicitly, and nothing else would rebuild the agent session with the new credentials.
    for (const target of this.children.canvases()) target.widgetDeck?.refreshSession();
    this.live.renewCredentials();
    // auth.mode decides whether sign-in/out buttons exist at all, so a new principal rebuilds the chrome.
    // A lease renewal keeps the DOM so the style editor iframe keeps uncommitted field text.
    if (!renewsLease) this.chrome.invalidate();
    this.chrome.render();
    // Routes receive `auth` as an argument, so the current route renders once more with the new session.
    if (this.host.routingMode === "hash") this.router.startHashRouting();
    else this.router.render();
    // The catalog is bearer-gated, so a new session needs a new catalog.
    if (renewsLease) this.catalog.revalidate();
    else this.catalog.refresh();
  }

  /** Binds a canvas that its host has not wired to this composition, its write path and its catalog. */
  connectCanvas(): void {
    const canvas = this.children.canvas();
    if (canvas) canvas.sourceAuthBaseUrl = this.authority.sourceBaseUrl;
    if (canvas && !canvas.composition) canvas.composition = this.composition;
    if (canvas && !canvas.commandDispatch) canvas.commandDispatch = (commands) => this.editor.dispatch(commands);
    if (canvas && this.catalog.catalog) canvas.sourceCatalog = this.catalog.catalog;
    else void this.catalog.load();
  }

  hasDirtyForm(): boolean {
    if (this.host.hasUnsavedStyleChanges) return true;
    const isIgnored = (element: Element) =>
      this.styleEditor.contains(element) || Boolean(this.chrome.recipeOutlet()?.contains(element));
    const { shadowRoot } = this.host;
    return (
      hasEditedFormControl(this.host, isIgnored) || Boolean(shadowRoot && hasEditedFormControl(shadowRoot, isIgnored))
    );
  }

  /** Everything the former principal could see or edit goes, including cached source metadata. */
  #revokeAuthority(): void {
    const hadAuthority = this.authority.holdsSession || Boolean(this.drafts.binding);
    this.host.closeDesignInspector();
    this.recipes.resetAuthority();
    this.styleEditor.dispose();
    this.authority.epoch.next();
    if (hadAuthority) {
      this.catalog.forget();
      this.live.forgetMapKit();
      const canvas = this.children.canvas();
      if (canvas) canvas.sourceCatalog = undefined;
    }
    this.drafts.detach();
    this.composition.resetBaseline(createEmptyCompositionState());
    this.composition.clearSelection();
    this.children.canvas()?.resetExploration();
    if (hadAuthority) this.drafts.announce();
  }

  #onAuthStatusChanged(): void {
    if (!this.host.isConnected) return;
    const status = this.authority.resolvedAuth?.getState().status;
    if (status === this.#lastAuthStatus) return;
    this.#lastAuthStatus = status;
    if (status === "expired" || status === "signed-out") this.host.closeDesignInspector();
    if (status === "signed-out" || status === "expired") this.recipes.resetAuthority();
    if (status !== "fresh" || this.catalog.catalog !== undefined) return;
    this.catalog.refresh();
  }

  async #saveCurrentView(current: () => void): Promise<void> {
    const mapView = this.children.canvas()?.mapView;
    await mapView?.settleAuthoredView();
    current();
    const camera = mapView?.camera();
    if (!camera) return;
    const command: CompositionCommand = { name: "setView", view: { ...camera, pitch: camera.pitch ?? 0 } };
    const outcome = await this.editor.applyQueuedDraftCommands([command]);
    if (!outcome.ok) throw new Error(outcome.reason);
    current();
    this.children.chat()?.activityLog.append("composition_command_applied", {
      toolName: command.name,
      mode: "workspace",
      command: command.name,
      commandInput: structuredClone(command),
      ...this.drafts.identity,
    });
  }

  #editingParts() {
    return {
      authority: this.authority,
      drafts: this.drafts,
      catalog: this.catalog,
      composition: this.composition,
      chrome: this.chrome,
    };
  }

  #createAuthority(): EditorAuthority {
    return new EditorAuthority({
      isConnected: () => this.host.isConnected,
      onAuthReplaced: () => this.drafts.rebind(this.authority.lifecycleClient()),
      // Never render routes from this listener: every getAccessToken() dispatches a state change and the
      // home route fetches with a token, so re-rendering routes here loops forever. Routes subscribe themselves.
      onAuthStateChange: () => {
        this.chrome.paintAuth();
        this.#onAuthStatusChanged();
      },
    });
  }

  #createChrome(shell: StudioShellAccess): ShellChrome {
    return new ShellChrome({
      host: this.host,
      ...shell,
      authStatus: () => this.authority.resolvedAuth?.getState().status ?? "signed-out",
      isDesignInspectorOpen: () => this.designInspector.isOpen,
      isHistoryBusy: () => this.drafts.historyBusy,
      liveStatus: () => ({ live: this.live.isLive, packageKey: this.live.packageKey }),
      onNavigate: (path, event) => this.router.requestNavigation(path, event),
    });
  }

  #createRouter(): ShellRouter {
    return new ShellRouter({
      host: this.host,
      hasView: () => this.chrome.hasView(),
      viewRoot: () => this.chrome.viewRoot(),
      onRouteRendered: () => this.chrome.syncNav(),
      isEditorHost: () => this.isEditorHost(),
      addCatalogSource: (dataset) => this.editor.addCatalogSource(dataset),
      releaseView: () => this.styleEditor.releaseForNavigation(),
    });
  }

  #createCatalog(): SourceCatalog {
    return new SourceCatalog(this.authority, {
      isConnected: () => this.host.isConnected,
      onCatalogReplacing: () => {
        this.host.closeDesignInspector();
        this.recipes.onCatalogReplaced();
      },
      onCatalogApplied: (catalog) => {
        this.live.forgetMapKit();
        const canvas = this.children.canvas();
        if (canvas) canvas.sourceCatalog = catalog;
        if (this.host.isConnected && this.live.isLive) this.live.scheduleAgentSession();
      },
      onRevalidate: () => this.recipes.invalidateSourceChoices(),
    });
  }

  #createDrafts(): EditorDraftSession {
    const { host } = this;
    return new EditorDraftSession(this.authority, this.composition, {
      prepareEditorTurn: () => host.prepareEditorTurn(),
      attachEditorDraft: (draftId) => host.attachEditorDraft(draftId),
      hasDirtyForm: () => this.hasDirtyForm(),
      settleStyleEdits: () => this.styleEditor.settled(),
      onDraftRequested: () => host.closeDesignInspector(),
      beforeMapSwitch: (draftId) => {
        host.closeDesignInspector();
        if (!this.recipes.isAttaching(draftId)) this.recipes.dispose();
      },
      afterMapSwitch: () => this.children.canvas()?.resetExploration(),
      onDraftChange: (identity) =>
        dispatchWithDeprecatedAlias(
          host,
          new CustomEvent("honua-studio-draft-change", { bubbles: true, composed: true, detail: identity }),
        ),
    });
  }

  #createEditor(): CompositionEditor {
    return new CompositionEditor({
      ...this.#editingParts(),
      orchestrator: () => this.host.toolCallOrchestrator,
      children: this.children,
      hasUnsavedStyleChanges: () => this.host.hasUnsavedStyleChanges,
    });
  }
}
