import { canonicalCompositionJson } from "../composition/model.js";
import {
  type MapStyleDocument,
  type MapStyleField,
  type MapStyleLayerOwner,
  bindNewRenderLayerOwners,
  isNumericMapStyleField,
  thematicMapStyle,
  validateMapStyleEdit,
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

interface AppliedThematicBinding {
  readonly ownerId: string;
  readonly sourceId: string;
  readonly fieldName: string;
  readonly fieldType: string;
  readonly expression: string;
  valid: boolean;
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
  #fieldLoadPending = false;
  #selectedOwner: string | undefined;
  #pendingSave: Promise<void> | undefined;
  #disposed = false;
  #fieldLoadEpoch = 0;
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
    discard.textContent = "Discard visual edits";
    discard.addEventListener("click", () => void this.discard().catch((error) => this.#error(error)));
    this.#status = document.createElement("p");
    this.#status.setAttribute("role", "status");
    controls.append(this.#save, discard, this.#status);
    this.#frame = document.createElement("iframe");
    this.#frame.title = "Maputnik visual map style editor";
    this.#frame.setAttribute("sandbox", "allow-scripts");
    this.#frame.referrerPolicy = "no-referrer";
    this.#frame.style.cssText = "width:100%;height:650px;border:0;display:block";
    const url = new URL(options.assetsUrl, document.baseURI);
    if (url.origin !== location.origin) throw new Error("Maputnik assets must be pinned on the host origin.");
    url.hash = new URLSearchParams({ channel: this.#channel, parentOrigin: location.origin }).toString();
    this.#frame.src = url.href;
    this.#addThematicControls(controls);
    window.addEventListener("message", this.#listener);
    options.container.append(notice, controls, this.#frame);
  }

  get dirty(): boolean {
    return this.#dirty;
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
    if (event.data.type === "honua:style-input") {
      this.#setDirty(true);
      this.#invalid = "Finish editing the visual field before saving.";
      this.#save.disabled = !this.#maySave() || this.#thematicBlocked();
      return;
    }
    if (event.data.type === "honua:style-ready") {
      this.#load();
      return;
    }
    if (event.data.type !== "honua:style-change" || this.#busy) return;
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
    this.#invalid = errors[0];
    if (errors.length) {
      this.#save.disabled = true;
      this.#status.textContent = errors[0];
      return;
    }
    this.#candidate = structuredClone(candidate);
    this.#pruneAppliedThematics();
    this.#setDirty(canonicalCompositionJson(this.#baseline) !== canonicalCompositionJson(this.#candidate));
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
      const style = await new Promise<unknown>((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          this.#flush = undefined;
          reject(new Error("The visual editor did not confirm its latest buffer."));
        }, 5000);
        this.#flush = { id, resolve, reject, timer };
        this.#frame.contentWindow?.postMessage(
          { type: "honua:style-flush", channel: this.#channel, requestId: id },
          "*",
        );
      });
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
  #option(label: string, value: string): HTMLOptionElement {
    const option = document.createElement("option");
    option.textContent = label;
    option.value = value;
    return option;
  }
  #addThematicControls(container: HTMLElement): void {
    if (!this.#options.layers?.length || !this.#options.getFields) return;
    const owner = document.createElement("select");
    owner.setAttribute(
      "aria-label",
      this.#options.scope.kind === "shared-style" ? "Catalog layer for styling" : "Map layer for styling",
    );
    for (const layer of this.#options.layers) owner.add(this.#option(layer.title ?? layer.id, layer.id));
    owner.value = this.#selectedOwner ?? "";
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
    apply.textContent = "Preview thematic colors";
    apply.disabled = true;
    let fields: readonly MapStyleField[] = [];
    let chosenFieldName: string | undefined;
    const load = async () => {
      if (this.#disposed) return;
      const current = ++this.#fieldLoadEpoch;
      this.#selectedOwner = owner.value;
      this.#options.onSelectLayer?.(owner.value);
      const selected = this.#options.layers?.find((layer) => layer.id === owner.value);
      field.replaceChildren();
      fields = [];
      apply.disabled = true;
      if (!selected) return;
      this.#fieldLoadPending = true;
      this.#setDirty(this.#dirty);
      try {
        const observed = await this.#options.getFields!(selected.sourceId);
        if (this.#disposed || current !== this.#fieldLoadEpoch || owner.value !== selected.id) return;
        fields = observed;
        for (const actual of observed) field.add(this.#option(`${actual.name} (${actual.type})`, actual.name));
        const binding = this.#appliedThematics.get(selected.id);
        if (binding && binding.sourceId === selected.sourceId) {
          binding.valid = observed.some(
            (actual) => actual.name === binding.fieldName && actual.type === binding.fieldType,
          );
          if (!binding.valid)
            this.#status.textContent = "The applied thematic field changed. Choose a current field and reapply.";
        }
        if (chosenFieldName !== undefined) {
          if (observed.some((actual) => actual.name === chosenFieldName)) field.value = chosenFieldName;
          else {
            field.selectedIndex = -1;
            this.#status.textContent = "The selected source field is unavailable. Choose a current described field.";
          }
        } else if (observed.length) chosenFieldName = field.value;
        apply.disabled = !fields.some((actual) => actual.name === field.value);
        this.#frame.contentWindow?.postMessage(
          { type: "honua:style-fields", channel: this.#channel, sourceId: selected.sourceId, fields: observed },
          "*",
        );
      } catch (error) {
        if (!this.#disposed && current === this.#fieldLoadEpoch) {
          const binding = this.#appliedThematics.get(selected.id);
          if (binding) binding.valid = false;
          this.#error(error);
        }
      } finally {
        if (current === this.#fieldLoadEpoch) {
          this.#fieldLoadPending = false;
          this.#setDirty(this.#dirty);
        }
      }
    };
    this.#refreshFields = load;
    owner.addEventListener("change", () => {
      chosenFieldName = undefined;
      void load();
    });
    field.addEventListener("change", () => {
      chosenFieldName = field.value || undefined;
      apply.disabled = !fields.some((actual) => actual.name === field.value);
    });
    values.addEventListener("input", () => {
      this.#setDirty(true);
      this.#invalid = "Apply or discard the pending thematic values.";
      this.#save.disabled = true;
    });
    apply.addEventListener("click", () => {
      try {
        if (this.#busy || this.#fieldLoadPending) throw new Error("Wait for the current field refresh.");
        const selected = this.#options.layers?.find((layer) => layer.id === owner.value);
        const actual = fields.find((item) => item.name === field.value);
        if (!selected || !actual) throw new Error("Choose an actual described field.");
        const next = thematicMapStyle(
          this.#candidate,
          selected,
          actual,
          mode.value as "categories" | "breaks",
          explicitThematicValues(values.value, mode.value === "breaks" || isNumericMapStyleField(actual)),
          ["#eff3ff", "#c6dbef", "#9ecae1", "#6baed6", "#3182bd", "#08519c"],
        );
        const errors = validateMapStyleEdit(this.#baseline, next);
        if (errors.length) throw new Error(errors[0]);
        this.#candidate = next;
        const expression = thematicExpression(next, selected.id, selected.sourceId);
        if (!expression) throw new Error("The selected layer has no thematic expression.");
        this.#appliedThematics.set(selected.id, {
          ownerId: selected.id,
          sourceId: selected.sourceId,
          fieldName: actual.name,
          fieldType: actual.type,
          expression,
          valid: true,
        });
        this.#invalid = undefined;
        this.#setDirty(true);
        this.#options.onPreview(next);
        this.#load();
        this.#status.textContent = "Unsaved thematic preview over the selected actual field.";
      } catch (error) {
        this.#error(error);
      }
    });
    container.append(owner, field, mode, values, apply);
    void load();
  }
  #error(error: unknown): void {
    this.#status.textContent = error instanceof Error ? error.message : String(error);
  }
}
