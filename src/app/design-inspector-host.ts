import type { CompositionController } from "../composition/controller.js";
import type { CompositionState } from "../composition/model.js";
import type { DesignInspectorPanel } from "../design/design-inspector-panel.js";
import type { DesignConsumer } from "../design/design-inventory.js";
import type { HonuaStudioCanvasElement } from "../elements/studio-canvas-element.js";
import { runtimeMcpBaseUrl } from "../runtime-config.js";
import type { MapStyleField } from "../styles/map-style-edit.js";
import { sourceStyleProvider } from "./runtime-clients.js";
import type { ShellChrome } from "./shell-chrome.js";
import type { SourceCatalog } from "./source-catalog.js";
import { type EpochToken, StalenessEpoch } from "./staleness-epoch.js";
import type { StudioAppChildren } from "./studio-app-children.js";
import type { WorkspaceAuthority } from "./workspace-authority.js";
import type { WorkspaceDraftSession } from "./workspace-draft-session.js";

export type DesignRelationship = { readonly interactionId: string; readonly ownerRef: string };

/** The public `<honua-studio-app>` surface the inspector reports through. */
export interface DesignInspectorHostElement extends EventTarget {
  readonly isConnected: boolean;
  closeDesignInspector(): void;
}

export interface DesignInspectorHostOptions {
  readonly host: DesignInspectorHostElement;
  readonly authority: WorkspaceAuthority;
  readonly drafts: WorkspaceDraftSession;
  readonly catalog: SourceCatalog;
  readonly composition: CompositionController;
  readonly chrome: ShellChrome;
  readonly children: StudioAppChildren;
}

/** What the panel was opened for; a source description from another draft or authority is refused. */
interface InspectorScope {
  readonly generation: EpochToken;
  readonly draftId: string | undefined;
  readonly canvas: HonuaStudioCanvasElement | undefined;
}

const TOGGLE = "design-inspector-toggle";

/** The embedded data-and-interactions inspector beside the map, and the relationship it selected. */
export class DesignInspectorHost {
  #panel: DesignInspectorPanel | undefined;
  #container: HTMLElement | undefined;
  #opening = new StalenessEpoch();
  #relationship: DesignRelationship | undefined;
  #relationshipState: CompositionState | undefined;
  #relationshipSelection: readonly unknown[] | undefined;

  constructor(private readonly options: DesignInspectorHostOptions) {}

  get isOpen(): boolean {
    return Boolean(this.#panel);
  }

  /** The relationship chosen in the inspector, while the selection and state it was chosen for still hold. */
  get selectedRelationship(): DesignRelationship | undefined {
    const { composition } = this.options;
    const relationship = this.#relationship;
    if (
      !relationship ||
      this.#relationshipSelection !== composition.selection ||
      this.#relationshipState !== composition.state ||
      !composition.state.interactions.some((entry) => entry.id === relationship.interactionId)
    )
      return undefined;
    const owner = composition.selection[0];
    const ref =
      owner && owner.kind !== "feature"
        ? `${owner.kind === "component" ? "widget" : owner.kind}:${owner.id}`
        : undefined;
    return ref === relationship.ownerRef ? { ...relationship } : undefined;
  }

  async open(): Promise<void> {
    if (this.#panel) return;
    const { authority, drafts } = this.options;
    const opening = this.#opening.next();
    const generation = authority.epoch.current;
    const draftId = drafts.identity?.draftId;
    const { DesignInspectorPanel: Panel } = await import("../design/design-inspector-panel.js");
    if (
      !this.options.host.isConnected ||
      !this.#opening.isCurrent(opening) ||
      !authority.epoch.isCurrent(generation) ||
      draftId !== drafts.identity?.draftId
    )
      return;
    const container = document.createElement("div");
    container.id = "design-inspector-panel";
    this.options.chrome.appSlots()?.before(container);
    this.#container = container;
    const scope: InspectorScope = { generation, draftId, canvas: this.options.children.canvas() };
    this.#panel = new Panel({
      container,
      controller: this.options.composition,
      canvas: scope.canvas,
      describeSource: (sourceId, signal) => this.#describeSource(scope, sourceId, signal),
      select: (consumer, interactionId) => this.#select(consumer, interactionId),
      close: () => {
        this.options.host.closeDesignInspector();
        this.options.chrome.focus(TOGGLE);
      },
    });
    this.options.chrome.setExpanded(TOGGLE, true);
    container.querySelector<HTMLButtonElement>("button")?.focus();
  }

  close(): void {
    this.#opening.next();
    this.#panel?.dispose();
    this.#panel = undefined;
    this.#container?.remove();
    this.#container = undefined;
    this.#relationship = undefined;
    this.#relationshipState = undefined;
    this.#relationshipSelection = undefined;
    this.options.chrome.setExpanded(TOGGLE, false);
  }

  async #describeSource(
    scope: InspectorScope,
    sourceId: string,
    signal: AbortSignal,
  ): Promise<readonly MapStyleField[]> {
    const { authority, drafts } = this.options;
    if (authority.auth.getState().status !== "fresh") throw new Error("Sign in to describe authorized source fields.");
    const source = this.options.catalog.find(sourceId);
    if (!source)
      throw new Error("Source is absent from the authorized catalog. Refresh source access before describing fields.");
    const baseUrl = scope.canvas?.sourceAuthBaseUrl ?? runtimeMcpBaseUrl();
    const provider = sourceStyleProvider({ baseUrl, getAuth: () => authority.auth, signal });
    const fields = await provider.describeSource(source);
    signal.throwIfAborted();
    if (!authority.epoch.isCurrent(scope.generation) || scope.draftId !== drafts.identity?.draftId)
      throw new Error("The workspace draft or authority changed.");
    return fields;
  }

  #select(consumer: DesignConsumer, interactionId: string | undefined): void {
    const { composition } = this.options;
    this.#relationship =
      interactionId && composition.state.interactions.some((entry) => entry.id === interactionId)
        ? { interactionId, ownerRef: consumer.ref }
        : undefined;
    this.#relationshipState = composition.state;
    composition.select([consumer.target]);
    this.#relationshipSelection = composition.selection;
    const relationship = this.selectedRelationship;
    this.options.host.dispatchEvent(
      new CustomEvent("honua-studio-selection-change", {
        bubbles: true,
        composed: true,
        detail: { targets: [consumer.target], ...(relationship ? { relationship } : {}) },
      }),
    );
  }
}
