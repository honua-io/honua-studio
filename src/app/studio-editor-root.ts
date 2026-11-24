import { isCookieSession, isSameCookiePrincipal, verifiedSourcePathBase } from "../auth/host-session.js";
import type { SessionAdapter } from "../auth/index.js";
import type { CompositionCommand } from "../composition/commands.js";
import { CompositionController } from "../composition/controller.js";
import { type CompositionState, type CompositionView, createEmptyCompositionState } from "../composition/model.js";
import { applyCompositionCommand } from "../composition/reducer.js";
import type { HonuaStudioAppElement } from "../elements/studio-app-element.js";
import { CompositionEditor } from "./composition-editor.js";
import { DesignInspectorHost } from "./design-inspector-host.js";
import { hasEditedFormControl } from "./dirty-form.js";
import { EditorAuthority } from "./editor-authority.js";
import { EditorDraftSession } from "./editor-draft-session.js";
import { EditorRelease } from "./editor-release.js";
import { LiveCompositionController } from "./live-composition-controller.js";
import { ManualElementsHost } from "./manual-elements-host.js";
import { RecipeController } from "./recipe-controller.js";
import { ShellChrome } from "./shell-chrome.js";
import { ShellRouter } from "./shell-router.js";
import { SourceCatalog } from "./source-catalog.js";
import { StudioAppChildren } from "./studio-app-children.js";
import { StyleEditorHost } from "./style-editor-host.js";

/** The protected `HonuaStudioElementBase` members the shell chrome needs. */
export interface StudioShellAccess {
  readonly setShadowHtml: (html: string) => void;
  readonly connectedSignal: () => AbortSignal | undefined;
}

/**
 * The composition root behind `<honua-studio-app>`: builds every controller, wires the hooks between them
 * and owns the policies that span them, such as revoking a former authority when the session changes.
 */
export class StudioEditorRoot {
  readonly composition = new CompositionController(createEmptyCompositionState());
  readonly children: StudioAppChildren;
  readonly authority: EditorAuthority;
  readonly chrome: ShellChrome;
  readonly router: ShellRouter;
  readonly catalog: SourceCatalog;
  readonly drafts: EditorDraftSession;
  readonly release: EditorRelease;
  readonly editor: CompositionEditor;
  readonly designInspector: DesignInspectorHost;
  readonly manualElements: ManualElementsHost;
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
    this.release = new EditorRelease(this.authority, this.drafts, {
      prepareEditorTurn: () => host.prepareEditorTurn(),
      saveCurrentView: (current) => this.#saveCurrentView(current),
    });
    this.editor = this.#createEditor();
    this.manualElements = this.#createManualElements();
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

  /** An editor host (agent adapter or cookie session) owns navigation and the composer. */
  isEditorHost(): boolean {
    return Boolean(this.host.agentSessionAdapter) || this.authority.hasCookieSession;
  }

  syncHostMode(): void {
    const editorHost = this.isEditorHost();
    if (this.host.hasAttribute("data-editor-host") === editorHost) return;
    this.host.toggleAttribute("data-editor-host", editorHost);
    if (editorHost) this.router.stop();
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
    if (!renewsLease) this.chrome.invalidate();
    this.chrome.render();
    // Route rendering releases the editor view. Renew credentials in place so an open editor stays mounted.
    if (renewsLease) {
      this.catalog.revalidate();
      return;
    }
    // Routes receive `auth` as an argument, so the current route renders once more with the new session.
    if (this.host.routingMode === "hash") this.router.startHashRouting();
    else this.router.render();
    // The catalog is bearer-gated, so a new session needs a new catalog.
    this.catalog.refresh();
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
    if (this.host.hasUnsavedStyleChanges || this.manualElements.hasPendingChanges) return true;
    const isIgnored = (element: Element) =>
      this.styleEditor.contains(element) ||
      this.manualElements.contains(element) ||
      Boolean(this.chrome.recipeOutlet()?.contains(element));
    const { shadowRoot } = this.host;
    return (
      hasEditedFormControl(this.host, isIgnored) || Boolean(shadowRoot && hasEditedFormControl(shadowRoot, isIgnored))
    );
  }

  /** Everything the former principal could see or edit goes, including cached source metadata. */
  #revokeAuthority(): void {
    const hadAuthority = this.authority.holdsSession || Boolean(this.drafts.binding);
    this.host.closeDesignInspector();
    this.manualElements.close();
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
    if (status === "signed-out" || status === "expired") {
      this.recipes.resetAuthority();
      this.manualElements.close();
    }
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
    // Re-sending what the server draft already holds is still a draft write: where draft changes need
    // approval, every Save version would be held as a new proposal and never reach the version save.
    // Local-only changes (bookmarks, geolocate, agent viewports) differ from the server body and are written.
    const after = this.#stateAfterCamera(command);
    if (after && this.drafts.binding?.holds(after)) return;
    const outcome = await this.editor.applyQueuedDraftCommands([command]);
    if (!outcome.ok) throw new Error(outcome.reason);
    current();
  }

  /** The state the camera command would produce; a camera within float noise of the stored view leaves it as is. */
  #stateAfterCamera(command: CompositionCommand): CompositionState | undefined {
    const state = this.composition.state;
    try {
      const next = applyCompositionCommand(state, command).state;
      return sameView(state.view, next.view) ? state : next;
    } catch {
      return undefined; // An out-of-range camera goes to the edit path, which reports the refusal.
    }
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
      authError: () => this.authority.resolvedAuth?.getState().error,
      isDesignInspectorOpen: () => this.designInspector.isOpen,
      onToggleManualElements: () => this.manualElements.toggle(),
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
        this.manualElements.close();
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
        this.manualElements.close();
        if (!this.recipes.isAttaching(draftId)) this.recipes.dispose();
      },
      afterMapSwitch: () => this.children.canvas()?.resetExploration(),
      onDraftChange: (identity) =>
        host.dispatchEvent(
          new CustomEvent("honua-studio-draft-change", { bubbles: true, composed: true, detail: identity }),
        ),
      onApprovalChange: (pending) =>
        host.dispatchEvent(
          new CustomEvent("honua-studio-editor-approval-change", {
            bubbles: true,
            composed: true,
            detail: { pendingApproval: pending },
          }),
        ),
    });
  }

  #createManualElements(): ManualElementsHost {
    return new ManualElementsHost({
      ...this.#editingParts(),
      editor: this.editor,
      isConnected: () => this.host.isConnected,
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

// Cameras read back from the map after a reload differ from the stored view by float noise only.
const VIEW_TOLERANCE = 1e-7;

function sameView(a: CompositionView, b: CompositionView): boolean {
  const keys = ["bbox", "center", "zoom", "pitch", "bearing"] as const;
  return keys.every((key) => sameValue(a[key], b[key]));
}

function sameValue(a: number | readonly number[] | undefined, b: number | readonly number[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (typeof a === "number" || typeof b === "number")
    return typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= VIEW_TOLERANCE;
  return (
    a.length === b.length && a.every((value, index) => Math.abs(value - (b[index] ?? Number.NaN)) <= VIEW_TOLERANCE)
  );
}
