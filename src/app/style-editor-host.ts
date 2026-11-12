import type { CompositionController } from "../composition/controller.js";
import type { HonuaStudioCanvasElement } from "../elements/studio-canvas-element.js";
import type { MapStyleDocument, MapStyleField } from "../styles/map-style-edit.js";
import { MapStyleEditor, type MapStyleEditorOptions } from "../styles/map-style-editor.js";
import type { CompositionEditor } from "./composition-editor.js";
import { sourceStyleProvider } from "./runtime-clients.js";
import type { ShellChrome } from "./shell-chrome.js";
import type { SourceCatalog } from "./source-catalog.js";
import type { EpochToken } from "./staleness-epoch.js";
import type { StudioAppChildren } from "./studio-app-children.js";
import { EDITOR_AUTHORITY_CHANGED, type EditorAuthority } from "./workspace-authority.js";
import type { EditorDraftIdentity, EditorDraftSession } from "./workspace-draft-session.js";

/** The public `<honua-studio-app>` surface the style editor uses; hosts and tests may wrap these methods. */
export interface StyleEditorHostElement extends EventTarget {
  readonly styleEditorAssetsUrl: string;
  prepareEditorTurn(): Promise<unknown>;
  attachEditorDraft(draftId: string): Promise<void>;
}

export interface StyleEditorHostOptions {
  readonly host: StyleEditorHostElement;
  readonly authority: EditorAuthority;
  readonly drafts: EditorDraftSession;
  readonly catalog: SourceCatalog;
  readonly composition: CompositionController;
  readonly chrome: ShellChrome;
  readonly editor: CompositionEditor;
  readonly children: StudioAppChildren;
}

/** The draft and authority one editor session was opened for. */
interface EditingSession {
  readonly canvas: HonuaStudioCanvasElement;
  readonly generation: EpochToken;
  readonly identity: EditorDraftIdentity;
}

/** The visual map-style editor docked beside the map; edits stay local until saved to the draft. */
export class StyleEditorHost {
  #editor: MapStyleEditor | undefined;
  #panel: HTMLElement | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(private readonly options: StyleEditorHostOptions) {}

  get hasUnsavedChanges(): boolean {
    return this.#editor?.dirty ?? false;
  }

  async settled(): Promise<void> {
    await this.#editor?.settled();
  }

  contains(element: Element): boolean {
    return this.#panel?.contains(element) ?? false;
  }

  async open(selectedLayerId: string | undefined): Promise<void> {
    if (this.#editor) return;
    const { authority, drafts } = this.options;
    await this.options.host.prepareEditorTurn();
    if (!drafts.binding) throw new Error("Attach an authorized map draft before editing its style.");
    const canvas = this.options.children.canvas();
    if (!canvas) throw new Error("Open the map canvas before its style editor.");
    if (!this.options.composition.state.mapSpec) await this.#initializeDraftStyle(canvas);
    const generation = authority.epoch.current;
    const identity = drafts.identity;
    if (!identity) throw new Error("The workspace draft is unavailable.");
    const document = await canvas.editableMapStyle();
    if (!authority.epoch.isCurrent(generation) || identity.draftId !== drafts.identity?.draftId)
      throw new Error("The workspace draft changed while opening the style editor.");
    const session: EditingSession = { canvas, generation, identity };
    const editor = new MapStyleEditor(this.#editorOptions(session, document, selectedLayerId));
    this.#editor = editor;
    this.#unsubscribe = this.options.composition.subscribe(() => {
      if (editor.dirty) return;
      void canvas
        .editableMapStyle()
        .then((style) => {
          if (this.#editor === editor && authority.epoch.isCurrent(generation)) editor.observeSavedDocument(style);
        })
        .catch(() => {});
    });
  }

  async close(): Promise<void> {
    if (this.hasUnsavedChanges) throw new Error("Save or discard visual style edits before leaving.");
    this.dispose();
  }

  /** Route replacement removes the mounted editor. A clean session can close; a dirty one stays put. */
  releaseForNavigation(): boolean {
    if (!this.#editor) return true;
    if (!this.hasUnsavedChanges) {
      this.dispose();
      return true;
    }
    const status = this.#panel?.querySelector<HTMLElement>("[role='status']");
    if (status) status.textContent = "Save or discard visual style edits before leaving.";
    return false;
  }

  async discard(): Promise<void> {
    await this.#editor?.discard();
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#editor?.dispose();
    this.#editor = undefined;
    this.#panel?.remove();
    this.#panel = undefined;
    this.options.chrome.appSlots()?.removeAttribute("data-style-mode");
    this.options.chrome.paintHistory();
    const canvas = this.options.children.canvas();
    if (canvas) canvas.stylePreview = undefined;
    this.#announceDirtyChange({ dirty: false });
  }

  /** A draft without a map style first adopts the canvas's authorized style as its baseline. */
  async #initializeDraftStyle(canvas: HonuaStudioCanvasElement): Promise<void> {
    const { authority, drafts, composition } = this.options;
    const binding = drafts.binding!;
    const epoch = authority.epoch.current;
    await drafts.enqueue(async () => {
      const style = await canvas.editableMapStyle();
      if (!authority.epoch.isCurrent(epoch) || drafts.binding !== binding) throw new Error(EDITOR_AUTHORITY_CHANGED);
      const observed = await binding.initializeStyle(style);
      if (!authority.epoch.isCurrent(epoch) || drafts.binding !== binding) throw new Error(EDITOR_AUTHORITY_CHANGED);
      composition.resetBaseline({
        ...observed,
        pins: composition.state.pins,
        annotations: composition.state.annotations,
      });
      drafts.announce();
    });
  }

  #mountPanel(draftId: string): HTMLElement {
    const panel = window.document.createElement("section");
    panel.setAttribute("aria-label", "Map style editor");
    const lifecycle = this.options.chrome.lifecyclePanel();
    if (lifecycle && this.#lifecycleDisplaysDraft(lifecycle, draftId)) {
      panel.slot = "style-editor";
      lifecycle.append(panel);
    } else {
      this.options.chrome.appSlots()?.prepend(panel);
      this.options.chrome.appSlots()?.setAttribute("data-style-mode", "");
    }
    this.#panel = panel;
    return panel;
  }

  #lifecycleDisplaysDraft(lifecycle: HTMLElement, draftId: string): boolean {
    return (
      lifecycle.getAttribute("draft-id") === draftId &&
      Boolean(lifecycle.shadowRoot?.querySelector("slot[name='style-editor']")) &&
      this.#isDisplayed(lifecycle)
    );
  }

  #isDisplayed(start: HTMLElement): boolean {
    let node: Node | null = start;
    while (node) {
      if (node instanceof HTMLElement && node.hidden) return false;
      const parent: Node | null = node.parentNode;
      node = parent instanceof ShadowRoot ? parent.host : parent;
    }
    return true;
  }

  #editorOptions(
    session: EditingSession,
    document: MapStyleDocument,
    selectedLayerId: string | undefined,
  ): MapStyleEditorOptions {
    const { state } = this.options.composition;
    return {
      container: this.#mountPanel(session.identity.draftId),
      document,
      assetsUrl: this.options.host.styleEditorAssetsUrl,
      scope: {
        kind: "map-local",
        detachesSharedStyles: state.layers.some(
          (layer) =>
            layer.styleRef &&
            state.styleRefs?.find((ref) => ref.styleId === layer.styleRef?.styleId)?.body === undefined,
        ),
      },
      layers: state.layers.map((layer) => ({ id: layer.id, sourceId: layer.sourceId, title: layer.title })),
      selectedLayerId,
      getFields: (sourceId) => this.#describeFields(session, sourceId),
      onPreview: (style) => {
        session.canvas.stylePreview = style;
      },
      onDirty: (dirty) => {
        this.options.chrome.paintHistory();
        this.#announceDirtyChange({ dirty });
      },
      onSave: (style) => this.#save(session, style),
      onDiscard: () => this.#reloadDraft(session),
      onClose: async () => {
        await this.close();
        this.options.chrome.focusStyleEditorReturn();
      },
    };
  }

  async #describeFields(session: EditingSession, sourceId: string): Promise<readonly MapStyleField[]> {
    const source = this.options.catalog.find(sourceId);
    if (!source) throw new Error("Refresh the authorized source catalog before selecting thematic fields.");
    const { authority } = this.options;
    const provider = sourceStyleProvider({
      baseUrl: session.canvas.sourceAuthBaseUrl,
      getAuth: () => authority.auth,
      signal: AbortSignal.timeout(8000),
    });
    const fields = await provider.describeSource(source);
    authority.epoch.assertCurrent(session.generation, EDITOR_AUTHORITY_CHANGED);
    return fields;
  }

  async #save(session: EditingSession, style: MapStyleDocument): Promise<MapStyleDocument> {
    const { authority, drafts } = this.options;
    if (!authority.epoch.isCurrent(session.generation) || session.identity.draftId !== drafts.identity?.draftId)
      throw new Error(`${EDITOR_AUTHORITY_CHANGED} Reopen the visual editor.`);
    const result = await this.options.editor.dispatch([{ name: "setMapStyle", mapSpec: style }]);
    if (!result.ok) throw new Error(result.reason);
    authority.epoch.assertCurrent(session.generation, EDITOR_AUTHORITY_CHANGED);
    return session.canvas.editableMapStyle();
  }

  /** Explicit discard permits an authoritative refresh; no stale buffer is written. */
  async #reloadDraft(session: EditingSession): Promise<MapStyleDocument> {
    const { authority, drafts } = this.options;
    session.canvas.stylePreview = undefined;
    const id = drafts.identity?.draftId;
    if (!id || !authority.epoch.isCurrent(session.generation)) throw new Error(EDITOR_AUTHORITY_CHANGED);
    const editor = this.#editor;
    this.#editor = undefined;
    try {
      await this.options.host.attachEditorDraft(id);
    } finally {
      if (authority.epoch.isCurrent(session.generation)) this.#editor = editor;
      else editor?.dispose();
    }
    authority.epoch.assertCurrent(session.generation, EDITOR_AUTHORITY_CHANGED);
    return session.canvas.editableMapStyle();
  }

  #announceDirtyChange(detail: { readonly dirty: boolean }): void {
    this.options.host.dispatchEvent(
      new CustomEvent("honua-studio-style-dirty-change", { detail, bubbles: true, composed: true }),
    );
  }
}
