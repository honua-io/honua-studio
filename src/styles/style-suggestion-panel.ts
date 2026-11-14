/**
 * The style-editor surface for authorized style suggestions: a request action for the selected
 * composed layer, the advisory preview the controller renders, and Apply/Discard. Selectors are
 * stable `data-testid`s so host journeys can drive it.
 */
import type { CompositionController } from "../composition/controller.js";
import type { CompositionSourceDescriptor } from "../map/source-resolution.js";
import type { MapStyleDocument } from "./map-style-edit.js";
import { type StyleSuggestionHost, hostStyleSuggestionTransport } from "./style-suggestion-transport.js";
import { LayerStyleSuggestion, type StyleSuggestionDispatch } from "./style-suggestion.js";

const NO_LAYER = "Select a map layer to request a style suggestion.";
const MAP_CHANGED = "The map changed since the suggestion. Request a new one.";

export interface StyleSuggestionPanelOptions {
  readonly controller: CompositionController;
  readonly catalog: () => readonly CompositionSourceDescriptor[];
  readonly host: StyleSuggestionHost;
  readonly layerId: string | undefined;
  readonly dispatch: StyleSuggestionDispatch;
  readonly onPreview: (style: MapStyleDocument | undefined) => void;
  /** Why a request cannot start now (for example unsaved visual edits), or undefined. */
  readonly blockedReason?: () => string | undefined;
}

export class StyleSuggestionPanel {
  readonly element: HTMLElement;
  readonly #options: StyleSuggestionPanelOptions;
  readonly #request: HTMLButtonElement;
  readonly #apply: HTMLButtonElement;
  readonly #discard: HTMLButtonElement;
  readonly #status: HTMLElement;
  readonly #actions: HTMLElement;
  readonly #suggestion: LayerStyleSuggestion | undefined;
  readonly #unavailable: string | undefined;
  #busy = false;
  #guidance = false;
  /** Bumped by every discard or retarget, so an in-flight request's late outcome cannot overwrite it. */
  #epoch = 0;
  #disposed = false;

  constructor(options: StyleSuggestionPanelOptions) {
    this.#options = options;
    const section = document.createElement("section");
    section.setAttribute("aria-label", "Style suggestion");
    section.setAttribute("data-testid", "style-suggestion");
    const heading = document.createElement("h3");
    heading.textContent = "Style suggestion";
    const note = document.createElement("p");
    note.textContent = "Suggestions are advisory. The map changes only when you apply one.";
    this.#request = button("Suggest a style", "style-suggestion-request");
    this.#status = document.createElement("p");
    this.#status.setAttribute("role", "status");
    this.#status.setAttribute("data-testid", "style-suggestion-status");
    const preview = document.createElement("div");
    preview.setAttribute("data-testid", "style-suggestion-preview");
    this.#apply = button("Apply suggestion", "style-suggestion-apply");
    this.#discard = button("Discard suggestion", "style-suggestion-discard");
    this.#actions = document.createElement("div");
    this.#actions.append(this.#apply, this.#discard);
    this.#actions.hidden = true;
    section.append(heading, note, this.#request, this.#status, preview, this.#actions);
    this.element = section;

    const resolved = hostStyleSuggestionTransport(options.host);
    if (resolved.ok) {
      this.#suggestion = new LayerStyleSuggestion({
        controller: options.controller,
        catalog: options.catalog,
        principalId: resolved.principalId,
        environmentId: resolved.environmentId,
        transport: resolved.transport,
        dispatch: options.dispatch,
        onPreview: options.onPreview,
        container: preview,
        layerId: options.layerId ?? "",
      });
    } else {
      this.#unavailable = resolved.reason;
    }
    this.#request.addEventListener("click", () => void this.request());
    this.#apply.addEventListener("click", () => void this.apply().then(() => this.#restoreFocus()));
    this.#discard.addEventListener("click", () => {
      this.discard();
      this.#restoreFocus();
    });
    this.refresh();
  }

  /** True while a suggestion preview is displayed. */
  get previewing(): boolean {
    return this.#suggestion?.pending ?? false;
  }

  async request(): Promise<void> {
    const suggestion = this.#suggestion;
    if (!suggestion || this.#busy || this.#disposed) return;
    const blocked = this.#options.blockedReason?.();
    if (blocked) return this.#say(blocked, true);
    this.#setBusy(true);
    this.#say("Requesting a style suggestion…");
    const epoch = this.#epoch;
    try {
      const result = await suggestion.request();
      if (this.#disposed || epoch !== this.#epoch) return;
      this.#say(result.ok ? "Previewing the suggestion. Apply it to the map draft or discard it." : result.reason);
    } finally {
      this.#setBusy(false);
    }
  }

  async apply(): Promise<void> {
    const suggestion = this.#suggestion;
    if (!suggestion || this.#busy || this.#disposed) return;
    this.#setBusy(true);
    try {
      const result = await suggestion.apply();
      if (this.#disposed) return;
      this.#say(result.ok ? "Applied the suggestion to the map draft." : result.reason);
    } finally {
      this.#setBusy(false);
    }
  }

  /** Drops a displayed or in-flight suggestion; the message explains why when something was dropped. */
  discard(message = "Discarded the suggestion."): void {
    if (!this.#suggestion || this.#disposed) return;
    const dropped = this.#suggestion.pending || this.#busy;
    this.#epoch += 1;
    this.#suggestion.discard();
    if (dropped) this.#say(message);
    this.refresh();
  }

  /** Follows the style editor's selected layer; any displayed or in-flight suggestion is dropped. */
  retarget(layerId: string): void {
    if (!this.#suggestion || this.#disposed || layerId === this.#suggestion.layerId) return;
    this.#epoch += 1;
    this.#suggestion.retarget(layerId);
    this.#guidance = false;
    this.#say("");
    this.refresh();
  }

  /** Re-reads eligibility after a map, catalog or editor change. */
  refresh(): void {
    if (this.#disposed) return;
    this.#actions.hidden = !this.previewing;
    if (!this.#suggestion) {
      this.#request.hidden = true;
      this.#say(this.#unavailable ?? "", true);
      return;
    }
    if (this.#busy) return;
    if (this.previewing && !this.#suggestion.isCurrent()) {
      this.#epoch += 1;
      this.#suggestion.discard();
      this.#actions.hidden = true;
      this.#say(MAP_CHANGED);
    }
    const eligibility = this.#suggestion.layerId
      ? this.#suggestion.eligibility()
      : ({ ok: false, reason: NO_LAYER } as const);
    this.#request.hidden = !eligibility.ok;
    const blocked = eligibility.ok ? this.#options.blockedReason?.() : undefined;
    this.#request.disabled = Boolean(blocked);
    if (!eligibility.ok) this.#say(eligibility.reason, true);
    else if (blocked) this.#say(blocked, true);
    else if (this.#guidance) this.#say("");
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#suggestion?.discard();
    this.#disposed = true;
    this.element.remove();
  }

  /** Apply and Discard hide their own buttons; keep keyboard focus in the surface. */
  #restoreFocus(): void {
    if (this.#disposed || !this.#actions.hidden) return;
    if (!this.#request.hidden && !this.#request.disabled) {
      this.#request.focus();
      return;
    }
    this.#status.tabIndex = -1;
    this.#status.focus();
  }

  #setBusy(busy: boolean): void {
    this.#busy = busy;
    this.#request.disabled = busy;
    this.#apply.disabled = busy;
    this.#discard.disabled = busy;
    if (!busy) this.refresh();
  }

  #say(text: string, guidance = false): void {
    this.#status.textContent = text;
    this.#guidance = guidance && text.length > 0;
  }
}

function button(label: string, testId: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.setAttribute("data-testid", testId);
  return element;
}
