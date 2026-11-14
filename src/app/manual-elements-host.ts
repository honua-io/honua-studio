import type { CompositionController } from "../composition/controller.js";
import type { CompositionEditor } from "./composition-editor.js";
import type { EditorAuthority } from "./editor-authority.js";
import type { EditorDraftSession } from "./editor-draft-session.js";
import { ManualElementsPanel } from "./manual-elements-panel.js";
import type { ShellChrome } from "./shell-chrome.js";

interface ManualElementsHostOptions {
  readonly authority: EditorAuthority;
  readonly drafts: EditorDraftSession;
  readonly composition: CompositionController;
  readonly editor: CompositionEditor;
  readonly chrome: ShellChrome;
  readonly isConnected: () => boolean;
}

const TOGGLE = "manual-elements-toggle";

/** Revokes forms when the active draft, session or connected editor changes. */
export class ManualElementsHost {
  #panel: ManualElementsPanel | undefined;
  #container: HTMLElement | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(private readonly options: ManualElementsHostOptions) {}

  get hasPendingChanges(): boolean {
    return this.#panel?.hasPendingChanges ?? false;
  }

  contains(element: Element): boolean {
    return this.#container?.contains(element) ?? false;
  }

  toggle(): void {
    if (this.#panel) {
      this.close();
      this.options.chrome.focus(TOGGLE);
      return;
    }
    if (!this.options.isConnected()) return;
    const { authority, drafts, chrome, composition, editor } = this.options;
    const generation = authority.epoch.current;
    const activeMap = drafts.activeMap.current;
    const container = document.createElement("section");
    container.id = "manual-elements-panel";
    chrome.appSlots()?.before(container);
    this.#container = container;
    const isCurrent = () =>
      this.#container === container &&
      this.options.isConnected() &&
      authority.epoch.isCurrent(generation) &&
      drafts.activeMap.isCurrent(activeMap);
    this.#panel = new ManualElementsPanel(container, {
      state: () => composition.state,
      dispatch: (commands) => editor.dispatch(commands, { isCurrent }),
      close: () => {
        this.close();
        chrome.focus(TOGGLE);
      },
    });
    this.#unsubscribe = composition.subscribe(() => this.#panel?.refresh());
    chrome.markExpanded(TOGGLE);
  }

  close(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#panel?.dispose();
    this.#panel = undefined;
    this.#container?.remove();
    this.#container = undefined;
    this.options.chrome.markCollapsed(TOGGLE);
  }
}
