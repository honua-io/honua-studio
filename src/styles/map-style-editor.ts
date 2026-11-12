import { canonicalCompositionJson } from "../composition/model.js";
import { MapStyleAppearancePanel, ThematicLegendPreview, labelled } from "./map-style-appearance-panel.js";
import {
  type MapStyleAppearancePatch,
  type MapStyleDocument,
  type MapStyleField,
  type MapStyleLayerOwner,
  THEMATIC_PALETTE,
  bindNewRenderLayerOwners,
  featureLabelState,
  featureLabelStyle,
  isNumericMapStyleField,
  thematicLegend,
  thematicMapStyle,
  validateMapStyleEdit,
  withLayerAppearance,
  withoutFeatureLabels,
} from "./map-style-edit.js";

export type MapStyleEditorScope =
  | { readonly kind: "map-local"; readonly detachesSharedStyles: boolean }
  | {
      readonly kind: "shared-style";
      readonly styleId: string;
      readonly version: number;
      readonly impactHash: string;
      readonly visibleConsumerCount: number;
      readonly impactComplete: boolean;
      readonly canEdit: boolean;
    };

export interface MapStyleEditorOptions {
  readonly container: HTMLElement;
  readonly document: MapStyleDocument;
  readonly assetsUrl: string;
  readonly onPreview: (style: MapStyleDocument | undefined) => void;
  readonly onDirty: (dirty: boolean) => void;
  readonly onSave: (style: MapStyleDocument) => Promise<MapStyleDocument>;
  readonly onDiscard: () => Promise<MapStyleDocument>;
  readonly scope: MapStyleEditorScope;
  readonly layers?: readonly MapStyleLayerOwner[];
  readonly selectedLayerId?: string;
  readonly getFields?: (sourceId: string) => Promise<readonly MapStyleField[]>;
  readonly onSelectLayer?: (layerId: string) => void;
  readonly onClose?: () => Promise<void> | void;
}

function explicitThematicValues(input: string, numeric: boolean): readonly (string | number)[] {
  const lines = input.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 1 || lines.length > 5)
    throw new Error("Provide one to five explicit categories or numeric breaks.");
  if (!numeric) return lines;
  return lines.map((raw) => {
    const line = raw.trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(line) || !Number.isFinite(Number(line)))
      throw new Error("Enter one finite numeric value per line.");
    return Number(line);
  });
}

const FRAME_RELOAD_DEBOUNCE_MS = 150;
const PENDING_THEMATIC_VALUES = "Apply or discard the pending thematic values.";

interface AppliedThematicBinding {
  readonly ownerId: string;
  readonly sourceId: string;
  readonly fieldName: string;
  readonly fieldType: string;
  readonly expression: string;
  valid: boolean;
}

interface ThematicControls {
  readonly owner: HTMLSelectElement;
  readonly field: HTMLSelectElement;
  readonly mode: HTMLSelectElement;
  readonly values: HTMLTextAreaElement;
  readonly apply: HTMLButtonElement;
  readonly labelField: HTMLSelectElement;
  fields: readonly MapStyleField[];
  chosenFieldName?: string;
}

function thematicExpression(style: MapStyleDocument, ownerId: string, sourceId: string): string | undefined {
  const layers = style.layers;
  if (!Array.isArray(layers)) return undefined;
  const layer = layers.find(
    (item) => item && typeof item === "object" && item.id === ownerId && item.source === sourceId,
  );
  if (!layer || typeof layer !== "object") return undefined;
  const key =
    layer.type === "symbol"
      ? "text-color"
      : ["fill", "line", "circle"].includes(String(layer.type))
        ? `${layer.type}-color`
        : undefined;
  if (!key || !layer.paint || typeof layer.paint !== "object") return undefined;
  const expression = (layer.paint as Record<string, unknown>)[key];
  return expression === undefined ? undefined : canonicalCompositionJson(expression);
}

/** Ephemeral visual buffer over the host's one generation-CAS map draft. */
export class MapStyleEditor {
  readonly #options: MapStyleEditorOptions;
  readonly #frame: HTMLIFrameElement;
  readonly #status: HTMLElement;
  readonly #save: HTMLButtonElement;
  readonly #channel = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  #baseline: MapStyleDocument;
  #candidate: MapStyleDocument;
  #dirty = false;
  #busy = false;
  #invalid: string | undefined;
  readonly #appliedThematics = new Map<string, AppliedThematicBinding>();
  readonly #legend = new ThematicLegendPreview();
  #thematic: ThematicControls | undefined;
  #appearance: MapStyleAppearancePanel | undefined;
  #fieldLoadPending = false;
  #loadTimer: ReturnType<typeof setTimeout> | undefined;
  #selectedOwner: string | undefined;
  #pendingSave: Promise<void> | undefined;
  #disposed = false;
  #fieldLoadEpoch = 0;
  #frameReady = false;
  #frameAuthored = false;
  #refreshFields: (() => Promise<void>) | undefined;
  #flush:
    | {
        id: string;
        resolve: (value: unknown) => void;
        reject: (reason: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  readonly #listener = (event: MessageEvent) => this.#receive(event);

  constructor(options: MapStyleEditorOptions) {
    this.#options = options;
    this.#baseline = structuredClone(options.document);
    this.#candidate = this.#baseline;
    this.#selectedOwner = options.selectedLayerId ?? options.layers?.[0]?.id;
    const notice = document.createElement("p");
    notice.textContent =
      options.scope.kind === "shared-style"
        ? `Shared catalog style ${options.scope.styleId}. ${options.scope.visibleConsumerCount} visible consumers. Saving changes this shared resource after the host reviews its current impact.`
        : options.scope.detachesSharedStyles
          ? "This map only. Saving converts linked shared styles to a local snapshot. Shared catalog styles remain unchanged."
          : "This map only. Save updates the shared map draft; publication remains a separate action.";
    const controls = document.createElement("div");
    this.#save = document.createElement("button");
    this.#save.textContent = options.scope.kind === "shared-style" ? "Review and save shared style" : "Save map style";
    this.#save.disabled = true;
    this.#save.addEventListener("click", () => void this.save());
    const discard = document.createElement("button");
    discard.type = "button";
    discard.textContent = "Discard visual edits";
    discard.addEventListener("click", () => void this.discard().catch((error) => this.#error(error)));
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close style editor";
    close.hidden = !options.onClose;
    close.addEventListener("click", () => {
      void Promise.resolve(options.onClose?.()).catch((error: unknown) => this.#error(error));
    });
    this.#status = document.createElement("p");
    this.#status.setAttribute("role", "status");
    this.#frame = document.createElement("iframe");
    this.#frame.title = "Maputnik visual map style editor";
    this.#frame.setAttribute("sandbox", "allow-scripts");
    this.#frame.referrerPolicy = "no-referrer";
    this.#frame.style.cssText = "width:100%;height:min(650px,70vh);min-height:20rem;border:0;display:block";
    const url = new URL(options.assetsUrl, document.baseURI);
    if (url.origin !== location.origin) throw new Error("Maputnik assets must be pinned on the host origin.");
    url.hash = new URLSearchParams({ channel: this.#channel, parentOrigin: location.origin }).toString();
    this.#frame.src = url.href;
    this.#addControls(controls, { save: this.#save, close, discard });
    const advanced = document.createElement("section");
    advanced.setAttribute("aria-label", "Advanced style editor");
    const advancedHeading = document.createElement("h3");
    advancedHeading.textContent = "Advanced style editor";
    const advancedNote = document.createElement("p");
    advancedNote.textContent =
      "Every render layer, filter, expression and label setting. Edits here share the same unsaved preview and Save.";
    advanced.append(advancedHeading, advancedNote, this.#frame);
    window.addEventListener("message", this.#listener);
    options.container.append(notice, controls, advanced);
  }

  get dirty(): boolean {
    return this.#dirty;
  }
  /** Moves keyboard focus to the editor's first control, so an opened editor is where the user is. */
  focus(): void {
    const controls = this.#options.container.querySelectorAll<HTMLElement>("select, input, textarea, button");
    const visible = (control: HTMLElement) =>
      typeof control.checkVisibility === "function" ? control.checkVisibility() : control.offsetParent !== null;
    [...controls].find((control) => !control.matches(":disabled") && visible(control))?.focus();
  }
  observeSavedDocument(style: MapStyleDocument): void {
    if (this.#dirty || this.#busy) return;
    this.#baseline = structuredClone(style);
    this.#candidate = this.#baseline;
    this.#appliedThematics.clear();
    this.#load();
  }
  public async settled(): Promise<void> {
    await this.#pendingSave;
  }
  /** Re-read actual source fields after the host changes catalog context; never replaces an unsaved style. */
  public async refreshThematicFields(): Promise<void> {
    await this.#refreshFields?.();
  }
  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#loadTimer);
    this.#fieldLoadEpoch++;
    if (this.#flush) {
      clearTimeout(this.#flush.timer);
      this.#flush.reject(new Error("The style editor closed."));
      this.#flush = undefined;
    }
    window.removeEventListener("message", this.#listener);
    this.#frame.remove();
  }
  #maySave(): boolean {
    const scope = this.#options.scope;
    return scope.kind === "map-local" || (scope.canEdit && scope.impactComplete);
  }
  #thematicBlocked(): boolean {
    return (
      this.#appliedThematics.size > 0 &&
      (this.#fieldLoadPending || [...this.#appliedThematics.values()].some((binding) => !binding.valid))
    );
  }
  #pruneAppliedThematics(): void {
    for (const [ownerId, binding] of this.#appliedThematics) {
      if (thematicExpression(this.#candidate, ownerId, binding.sourceId) !== binding.expression)
        this.#appliedThematics.delete(ownerId);
    }
  }
  async #revalidateAppliedThematics(): Promise<void> {
    for (const binding of this.#appliedThematics.values()) {
      const owner = this.#options.layers?.find(
        (candidate) => candidate.id === binding.ownerId && candidate.sourceId === binding.sourceId,
      );
      if (!owner || !this.#options.getFields) throw new Error("The thematic layer is no longer authorized.");
      const fields = await this.#options.getFields(owner.sourceId);
      binding.valid = fields.some((field) => field.name === binding.fieldName && field.type === binding.fieldType);
      if (!binding.valid || this.#disposed)
        throw new Error("A thematic field is no longer available. Choose a current field and reapply or discard.");
    }
  }
  #setDirty(dirty: boolean): void {
    if (this.#dirty !== dirty) {
      this.#dirty = dirty;
      this.#options.onDirty(dirty);
    }
    this.#save.disabled = !dirty || this.#busy || !this.#maySave() || this.#thematicBlocked();
  }
  #load(): void {
    this.#syncAppearance();
    // The scripts-only frame has an opaque origin; exact source + per-frame
    // channel bind this data-only protocol. No credentials or fetch capability.
    this.#frame.contentWindow?.postMessage(
      { type: "honua:style-load", channel: this.#channel, style: this.#candidate },
      "*",
    );
  }
  #receive(event: MessageEvent): void {
    if (event.source !== this.#frame.contentWindow || event.origin !== "null" || event.data?.channel !== this.#channel)
      return;
    const flush = this.#flush;
    if (event.data.type === "honua:style-flushed" && flush && flush.id === event.data.requestId) {
      clearTimeout(flush.timer);
      if (event.data.settled === true) flush.resolve(event.data.style);
      else flush.reject(new Error("Finish or discard the pending visual field before saving."));
      this.#flush = undefined;
      return;
    }
    if (event.data.type === "honua:style-ready") {
      this.#frameReady = true;
      this.#load();
      return;
    }
    if (event.data.type === "honua:style-input") {
      this.#frameAuthored = true;
      this.#setDirty(true);
      this.#invalid = "Finish editing the visual field before saving.";
      this.#save.disabled = !this.#maySave() || this.#thematicBlocked();
      return;
    }
    if (event.data.type !== "honua:style-change" || this.#busy) return;
    this.#frameAuthored = true;
    this.#setDirty(true);
    let candidate: MapStyleDocument;
    try {
      candidate =
        this.#options.scope.kind === "shared-style"
          ? structuredClone(event.data.style)
          : bindNewRenderLayerOwners(this.#baseline, event.data.style, this.#options.layers ?? [], this.#selectedOwner);
    } catch (error) {
      this.#invalid = error instanceof Error ? error.message : String(error);
      this.#status.textContent = this.#invalid;
      this.#save.disabled = true;
      return;
    }
    const errors = validateMapStyleEdit(this.#baseline, candidate);
    const pendingThematic = this.#invalid === PENDING_THEMATIC_VALUES;
    this.#invalid = errors[0] ?? (pendingThematic ? PENDING_THEMATIC_VALUES : undefined);
    if (errors.length) {
      this.#save.disabled = true;
      this.#status.textContent = errors[0];
      return;
    }
    this.#candidate = structuredClone(candidate);
    this.#pruneAppliedThematics();
    this.#syncAppearance();
    this.#setDirty(
      pendingThematic || canonicalCompositionJson(this.#baseline) !== canonicalCompositionJson(this.#candidate),
    );
    if (this.#invalid) this.#save.disabled = true;
    this.#status.textContent = this.#dirty
      ? "Unsaved visual edits. Preview only."
      : "Map style matches the saved draft.";
    this.#options.onPreview(this.#dirty ? this.#candidate : undefined);
  }
  save(): Promise<void> {
    if (this.#pendingSave) return this.#pendingSave;
    const pending = this.#performSave();
    this.#pendingSave = pending;
    void pending.finally(() => {
      if (this.#pendingSave === pending) this.#pendingSave = undefined;
    });
    return pending;
  }
  async #performSave(): Promise<void> {
    if (!this.#dirty || this.#busy) return;
    this.#busy = true;
    this.#save.disabled = true;
    try {
      if (this.#fieldLoadPending && this.#appliedThematics.size)
        throw new Error("Wait for the current thematic field refresh before saving.");
      if ([...this.#appliedThematics.values()].some((binding) => !binding.valid))
        throw new Error("A thematic field is no longer available. Choose a current field and reapply or discard.");
      if (this.#invalid && this.#invalid !== "Finish editing the visual field before saving.")
        throw new Error(this.#invalid);
      this.#loadNow();
      const style = this.#frameReady || this.#frameAuthored ? await this.#flushFrame() : this.#candidate;
      if (!this.#maySave())
        throw new Error("Shared style editing requires complete authorized impact and edit permission.");
      this.#candidate =
        this.#options.scope.kind === "shared-style"
          ? structuredClone(style as MapStyleDocument)
          : bindNewRenderLayerOwners(
              this.#baseline,
              style as MapStyleDocument,
              this.#options.layers ?? [],
              this.#selectedOwner,
            );
      this.#pruneAppliedThematics();
      const errors = validateMapStyleEdit(this.#baseline, this.#candidate);
      if (errors.length) throw new Error(errors[0]);
      await this.#revalidateAppliedThematics();
      if (this.#disposed) throw new Error("The style editor closed before saving.");
      if (this.#fieldLoadPending) throw new Error("Wait for the current thematic field refresh before saving.");
      const observed = await this.#options.onSave(structuredClone(this.#candidate));
      const readbackErrors = validateMapStyleEdit(this.#candidate, observed);
      if (readbackErrors.length) throw new Error(`No valid canonical style readback: ${readbackErrors[0]}`);
      this.#baseline = structuredClone(observed);
      this.#candidate = this.#baseline;
      this.#appliedThematics.clear();
      this.#invalid = undefined;
      this.#load();
      this.#setDirty(false);
      this.#options.onPreview(undefined);
      this.#status.textContent =
        this.#options.scope.kind === "shared-style"
          ? "Shared style saved; canonical readback loaded."
          : "Map style saved to the authorized draft.";
    } catch (error) {
      this.#error(error);
    } finally {
      this.#busy = false;
      this.#frame.contentWindow?.postMessage({ type: "honua:style-unlock", channel: this.#channel }, "*");
      this.#save.disabled = !this.#dirty || Boolean(this.#invalid) || !this.#maySave() || this.#thematicBlocked();
    }
  }
  async discard(): Promise<void> {
    if (this.#busy) throw new Error("Wait for the accepted style write before discarding.");
    this.#busy = true;
    try {
      const observed = await this.#options.onDiscard();
      this.#baseline = structuredClone(observed);
      this.#candidate = this.#baseline;
      this.#appliedThematics.clear();
      this.#invalid = undefined;
      this.#setDirty(false);
      this.#options.onPreview(undefined);
      this.#load();
      this.#status.textContent = "Visual edits discarded; current server draft loaded.";
    } finally {
      this.#busy = false;
    }
  }
  #flushFrame(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.#flush = undefined;
        reject(new Error("The visual editor did not confirm its latest buffer."));
      }, 5000);
      this.#flush = { id, resolve, reject, timer };
      this.#frame.contentWindow?.postMessage({ type: "honua:style-flush", channel: this.#channel, requestId: id }, "*");
    });
  }
  #option(label: string, value: string): HTMLOptionElement {
    const option = document.createElement("option");
    option.textContent = label;
    option.value = value;
    return option;
  }
  #selectedOwnerLayer(): MapStyleLayerOwner | undefined {
    return this.#options.layers?.find((layer) => layer.id === this.#selectedOwner);
  }
  #addControls(
    container: HTMLElement,
    chrome: { save: HTMLButtonElement; close: HTMLButtonElement; discard: HTMLButtonElement },
  ): void {
    const actions = document.createElement("div");
    actions.append(chrome.save, chrome.close, chrome.discard);
    if (!this.#options.layers?.length) {
      container.append(actions, this.#status);
      return;
    }
    const owner = document.createElement("select");
    owner.setAttribute(
      "aria-label",
      this.#options.scope.kind === "shared-style" ? "Catalog layer for styling" : "Map layer for styling",
    );
    for (const layer of this.#options.layers) owner.add(this.#option(layer.title ?? layer.id, layer.id));
    owner.value = this.#selectedOwner ?? "";
    if (this.#options.layers.length === 1) {
      owner.hidden = true;
      const only = document.createElement("p");
      only.textContent = `Layer: ${this.#options.layers[0].title ?? this.#options.layers[0].id}`;
      container.append(only);
    }
    this.#appearance = new MapStyleAppearancePanel((patch) => this.#previewAppearance(patch));
    container.append(owner, this.#appearance.element);
    if (this.#options.getFields) {
      const thematic = this.#thematicControls(owner);
      container.append(labelled("Labels", thematic.labelField), thematic.section);
    } else
      owner.addEventListener("change", () => {
        this.#selectedOwner = owner.value;
        this.#options.onSelectLayer?.(owner.value);
        this.#syncAppearance();
      });
    container.append(actions, this.#status);
    this.#syncAppearance();
  }
  #previewAppearance(patch: MapStyleAppearancePatch): void {
    const owner = this.#selectedOwnerLayer();
    if (!owner) return;
    try {
      this.#acceptPreview(
        withLayerAppearance(this.#candidate, owner, patch),
        "Unsaved appearance preview. Save map style to keep it.",
        { keepsPendingThematic: true },
      );
    } catch (error) {
      this.#error(error);
    }
  }
  /** Shows the selected layer's current styling in the direct controls, labels and legend. */
  #syncAppearance(): void {
    const owner = this.#selectedOwnerLayer();
    if (this.#thematic && owner && !this.#fieldLoadPending) this.#syncLabels(this.#thematic, owner);
    this.#appearance?.sync(this.#candidate, owner);
    this.#legend.render(owner?.id, owner && thematicExpression(this.#candidate, owner.id, owner.sourceId));
  }
  #thematicControls(owner: HTMLSelectElement): { section: HTMLDetailsElement; labelField: HTMLSelectElement } {
    const section = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Color by field";
    const fieldset = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = "Classes";
    const field = document.createElement("select");
    field.setAttribute("aria-label", "Actual source field");
    const mode = document.createElement("select");
    mode.setAttribute("aria-label", "Thematic method");
    mode.add(this.#option("Categories", "categories"));
    mode.add(this.#option("Manual numeric breaks", "breaks"));
    const values = document.createElement("textarea");
    values.setAttribute("aria-label", "Explicit thematic values, one per line");
    values.placeholder = "Residential\nCommercial";
    mode.addEventListener("change", () => {
      values.placeholder = mode.value === "breaks" ? "10\n25\n50" : "Residential\nCommercial";
    });
    const apply = document.createElement("button");
    apply.type = "button";
    apply.textContent = "Preview thematic colors";
    apply.disabled = true;
    const labelField = document.createElement("select");
    labelField.disabled = true;
    const controls: ThematicControls = { owner, field, mode, values, apply, labelField, fields: [] };
    this.#thematic = controls;
    const load = () => this.#reloadThematicFields(controls);
    this.#refreshFields = load;
    owner.addEventListener("change", () => {
      controls.chosenFieldName = undefined;
      void load();
    });
    field.addEventListener("change", () => {
      controls.chosenFieldName = field.value || undefined;
      this.#enableFieldActions(controls);
    });
    values.addEventListener("input", () => {
      this.#setDirty(true);
      this.#invalid = PENDING_THEMATIC_VALUES;
      this.#save.disabled = true;
    });
    apply.addEventListener("click", () => {
      try {
        this.#previewThematic(controls);
      } catch (error) {
        this.#error(error);
      }
    });
    labelField.addEventListener("change", () => {
      try {
        this.#previewFeatureLabels(controls);
      } catch (error) {
        this.#error(error);
      }
    });
    fieldset.append(legend, field, mode, values, apply, this.#legend.element);
    section.append(summary, fieldset);
    void load();
    return { section, labelField };
  }
  #enableFieldActions(controls: ThematicControls): void {
    const ready = controls.fields.some((actual) => actual.name === controls.field.value);
    controls.apply.disabled = !ready;
  }
  async #reloadThematicFields(controls: ThematicControls): Promise<void> {
    if (this.#disposed) return;
    const current = ++this.#fieldLoadEpoch;
    this.#selectedOwner = controls.owner.value;
    this.#options.onSelectLayer?.(controls.owner.value);
    this.#syncAppearance();
    const selected = this.#options.layers?.find((layer) => layer.id === controls.owner.value);
    controls.field.replaceChildren();
    controls.fields = [];
    controls.apply.disabled = true;
    controls.labelField.disabled = true;
    controls.labelField.replaceChildren(this.#option("No labels", ""));
    if (!selected || !this.#options.getFields) return;
    this.#fieldLoadPending = true;
    this.#setDirty(this.#dirty);
    const generation = current;
    try {
      const observed = await this.#options.getFields(selected.sourceId);
      if (this.#disposed || generation !== this.#fieldLoadEpoch || controls.owner.value !== selected.id) return;
      controls.fields = observed;
      for (const actual of observed) {
        controls.field.add(this.#option(`${actual.name} (${actual.type})`, actual.name));
        controls.labelField.add(this.#option(actual.name, actual.name));
      }
      this.#syncLabels(controls, selected);
      const binding = this.#appliedThematics.get(selected.id);
      if (binding && binding.sourceId === selected.sourceId) {
        binding.valid = observed.some(
          (actual) => actual.name === binding.fieldName && actual.type === binding.fieldType,
        );
        if (!binding.valid)
          this.#status.textContent = "The applied thematic field changed. Choose a current field and reapply.";
      }
      if (controls.chosenFieldName !== undefined) {
        if (observed.some((actual) => actual.name === controls.chosenFieldName))
          controls.field.value = controls.chosenFieldName;
        else {
          controls.field.selectedIndex = -1;
          this.#status.textContent = "The selected source field is unavailable. Choose a current described field.";
        }
      } else if (observed.length) controls.chosenFieldName = controls.field.value;
      this.#enableFieldActions(controls);
      this.#frame.contentWindow?.postMessage(
        { type: "honua:style-fields", channel: this.#channel, sourceId: selected.sourceId, fields: observed },
        "*",
      );
    } catch (error) {
      if (!this.#disposed && generation === this.#fieldLoadEpoch) {
        const binding = this.#appliedThematics.get(selected.id);
        if (binding) binding.valid = false;
        this.#error(error);
      }
    } finally {
      if (generation === this.#fieldLoadEpoch) {
        this.#fieldLoadPending = false;
        this.#setDirty(this.#dirty);
      }
    }
  }
  #selectedField(controls: ThematicControls): { owner: MapStyleLayerOwner; field: MapStyleField } {
    if (this.#busy || this.#fieldLoadPending) throw new Error("Wait for the current field refresh.");
    const selected = this.#options.layers?.find((layer) => layer.id === controls.owner.value);
    const actual = controls.fields.find((item) => item.name === controls.field.value);
    if (!selected || !actual) throw new Error("Choose an actual described field.");
    return { owner: selected, field: actual };
  }
  #acceptPreview(next: MapStyleDocument, status: string, { keepsPendingThematic = false } = {}): void {
    const errors = validateMapStyleEdit(this.#baseline, next);
    if (errors.length) throw new Error(errors[0]);
    this.#candidate = next;
    if (!(keepsPendingThematic && this.#invalid === PENDING_THEMATIC_VALUES)) this.#invalid = undefined;
    this.#setDirty(true);
    if (this.#invalid) this.#save.disabled = true;
    this.#options.onPreview(next);
    this.#loadSoon();
    this.#status.textContent = this.#invalid ? `${status} ${this.#invalid}` : status;
  }
  /** Direct controls fire on every slider step; the advanced frame reloads once the gesture pauses. */
  #loadSoon(): void {
    clearTimeout(this.#loadTimer);
    this.#syncAppearance();
    this.#loadTimer = setTimeout(() => this.#loadNow(), FRAME_RELOAD_DEBOUNCE_MS);
  }
  #loadNow(): void {
    if (this.#loadTimer === undefined) return;
    clearTimeout(this.#loadTimer);
    this.#loadTimer = undefined;
    if (!this.#disposed) this.#load();
  }
  #previewThematic(controls: ThematicControls): void {
    const selected = this.#selectedField(controls);
    const numeric = controls.mode.value === "breaks" || isNumericMapStyleField(selected.field);
    const mode = controls.mode.value as "categories" | "breaks";
    const classes = explicitThematicValues(controls.values.value, numeric);
    const next = thematicMapStyle(this.#candidate, selected.owner, selected.field, mode, classes, THEMATIC_PALETTE);
    const expression = thematicExpression(next, selected.owner.id, selected.owner.sourceId);
    if (!expression) throw new Error("The selected layer has no thematic expression.");
    this.#legend.remember(selected.owner.id, expression, thematicLegend(mode, classes));
    this.#acceptPreview(next, "Unsaved thematic preview over the selected actual field.");
    this.#appliedThematics.set(selected.owner.id, {
      ownerId: selected.owner.id,
      sourceId: selected.owner.sourceId,
      fieldName: selected.field.name,
      fieldType: selected.field.type,
      expression,
      valid: true,
    });
    this.#setDirty(true);
  }
  /** A custom label expression stays intact: the picker shows it and only the advanced editor changes it. */
  #syncLabels(controls: ThematicControls, owner: MapStyleLayerOwner): void {
    const state = featureLabelState(this.#candidate, owner);
    controls.labelField.querySelector("option[data-custom]")?.remove();
    if (state.kind === "custom") {
      const custom = this.#option("Custom labels (advanced editor)", "");
      custom.dataset.custom = "";
      controls.labelField.prepend(custom);
      controls.labelField.selectedIndex = 0;
      controls.labelField.disabled = true;
      return;
    }
    controls.labelField.disabled = controls.fields.length === 0;
    controls.labelField.value = state.kind === "field" ? state.field : "";
  }
  #previewFeatureLabels(controls: ThematicControls): void {
    if (this.#busy || this.#fieldLoadPending) throw new Error("Wait for the current field refresh.");
    const owner = this.#options.layers?.find((layer) => layer.id === controls.owner.value);
    if (!owner) throw new Error("Choose a map layer.");
    if (controls.labelField.value === "") {
      this.#acceptPreview(withoutFeatureLabels(this.#candidate, owner), "Unsaved preview without feature labels.", {
        keepsPendingThematic: true,
      });
      return;
    }
    const field = controls.fields.find((item) => item.name === controls.labelField.value);
    if (!field) throw new Error("Choose an actual described field.");
    this.#acceptPreview(
      featureLabelStyle(this.#candidate, owner, field),
      "Unsaved feature labels over the selected actual field.",
      { keepsPendingThematic: true },
    );
  }
  #error(error: unknown): void {
    this.#status.textContent = error instanceof Error ? error.message : String(error);
  }
}
