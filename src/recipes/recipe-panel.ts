import type { CatalogDataset } from "../client/studio-client.js";
import {
  EXPLORE_DATASET_RECIPE,
  type ExploreDatasetInput,
  type ExploreDatasetMetadata,
  categoryFields,
  compileExploreDataset,
} from "./explore-dataset.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface RecipePanelOptions {
  readonly listSources: (signal: AbortSignal) => Promise<readonly CatalogDataset[]>;
  readonly describeSource: (id: string, signal: AbortSignal) => Promise<ExploreDatasetMetadata>;
  readonly create: (input: ExploreDatasetInput, submissionId: string) => Promise<{ draftId: string }>;
  readonly close: () => void;
  readonly startAnother?: () => void;
  readonly canChangeInputs?: (submissionId: string) => boolean;
}

/** Small authoring form. Preview/discovery never changes the composition or creates a draft. */
export class RecipePanel {
  #submissionId = crypto.randomUUID();
  #request: AbortController | undefined;
  #sequence = 0;
  #disposed = false;
  #metadata: ExploreDatasetMetadata | undefined;
  #submitted: ExploreDatasetInput | undefined;
  #busy = false;
  #accepted = false;

  public constructor(
    readonly element: HTMLElement,
    private readonly options: RecipePanelOptions,
  ) {
    element.innerHTML = `
      <section class="hn-panel recipe-panel" aria-labelledby="recipe-heading" data-testid="recipe-panel">
        <h2 id="recipe-heading">${EXPLORE_DATASET_RECIPE.title}</h2>
        <p>${EXPLORE_DATASET_RECIPE.purpose}</p>
        <figure aria-label="Illustrative recipe preview" class="recipe-preview">
          <div class="recipe-preview-map">2D map · selected dataset</div>
          <div>Category filter → map + table</div><div>Table · chosen columns · feature selection</div>
          <figcaption>${EXPLORE_DATASET_RECIPE.preview.caption}</figcaption>
        </figure>
        <details open><summary>Required data and capabilities</summary>
          <ul>${EXPLORE_DATASET_RECIPE.requirements.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul>
          <p>Uses the existing widget grid. Category options and displayed rows are bounded samples; they are not a complete dataset summary.</p>
        </details>
        <form data-testid="recipe-form">
          <label>Package key <input name="packageKey" required maxlength="200" pattern="[A-Za-z0-9._-]+" data-testid="recipe-package-key"></label>
          <label>Authorized dataset <select name="sourceId" required data-testid="recipe-source"><option value="">Loading authorized sources…</option></select></label>
          <label>Category field <select name="categoryField" required data-testid="recipe-category" disabled><option value="">Choose a dataset first</option></select></label>
          <fieldset data-testid="recipe-columns" disabled><legend>Table columns (choose 1–8)</legend><div data-columns></div></fieldset>
          <p role="status" aria-live="polite" data-testid="recipe-status">Loading sources…</p>
          <button type="submit" class="hn-btn" data-testid="recipe-create" disabled>Create editable draft</button>
          <button type="button" class="hn-btn" data-testid="recipe-close">Cancel</button>
          <button type="button" class="hn-btn" data-testid="recipe-new" hidden>Start another app</button>
        </form>
      </section>`;
    this.#find<HTMLFormElement>("recipe-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#create();
    });
    this.#find<HTMLSelectElement>("recipe-source").addEventListener("change", () => {
      void this.#describe();
    });
    this.#find<HTMLButtonElement>("recipe-close").addEventListener("click", () => {
      this.cancelDiscovery();
      options.close();
    });
    this.#find<HTMLButtonElement>("recipe-new").addEventListener("click", () => options.startAnother?.());
    void this.#list();
  }

  #find<T extends HTMLElement>(id: string): T {
    return this.element.querySelector<T>(`[data-testid="${id}"]`)!;
  }
  #status(message: string): void {
    this.#find("recipe-status").textContent = message;
  }

  cancelDiscovery(): void {
    this.#request?.abort();
    this.#sequence++;
  }

  public dispose(): void {
    this.#disposed = true;
    this.cancelDiscovery();
    this.element.replaceChildren();
  }

  public resume(): void {
    if (!this.#submitted && !this.#metadata && (!this.#request || this.#request.signal.aborted)) void this.#list();
    const key = this.#find<HTMLInputElement>("recipe-package-key");
    if (!key.disabled) key.focus();
    else this.element.querySelector<HTMLButtonElement>("button:not([disabled]):not([hidden])")?.focus();
  }

  async #list(): Promise<void> {
    this.cancelDiscovery();
    const sequence = this.#sequence;
    const request = new AbortController();
    this.#request = request;
    try {
      const sources = await this.options.listSources(request.signal);
      if (this.#disposed || request.signal.aborted || sequence !== this.#sequence) return;
      this.#find<HTMLSelectElement>("recipe-source").innerHTML =
        `<option value="">Choose a dataset</option>${sources.map((source) => `<option value="${escapeHtml(source.id)}">${escapeHtml(source.title)} · ${escapeHtml(source.geometryType)}</option>`).join("")}`;
      this.#status(
        sources.length
          ? "Choose a dataset to verify geometry, fields and read access."
          : "No authorized datasets are available. Publish a vector dataset or request access, then reopen this form.",
      );
    } catch (error) {
      if (this.#disposed || request.signal.aborted || sequence !== this.#sequence) return;
      this.#status(
        `Source discovery failed: ${error instanceof Error ? error.message : String(error)} Reopen this form to retry.`,
      );
    }
  }

  async #describe(): Promise<void> {
    this.cancelDiscovery();
    const sequence = this.#sequence;
    const request = new AbortController();
    this.#request = request;
    this.#metadata = undefined;
    const sourceId = this.#find<HTMLSelectElement>("recipe-source").value;
    const category = this.#find<HTMLSelectElement>("recipe-category");
    category.disabled = true;
    category.innerHTML = `<option value="">Verifying source…</option>`;
    this.#find<HTMLFieldSetElement>("recipe-columns").disabled = true;
    this.element.querySelector("[data-columns]")!.replaceChildren();
    this.#find<HTMLButtonElement>("recipe-create").disabled = true;
    if (!sourceId) {
      this.#status("Choose a dataset.");
      return;
    }
    this.#status("Verifying actual geometry, schema and up to 100 readable records…");
    try {
      const metadata = await this.options.describeSource(sourceId, request.signal);
      if (this.#disposed || request.signal.aborted || sequence !== this.#sequence) return;
      if (metadata.source.id !== sourceId) throw new Error("The source response does not match your selection.");
      const categories = categoryFields(metadata);
      if (!categories.length)
        throw new Error("No string category field has values in the first 100 records. Choose another dataset.");
      this.#metadata = metadata;
      category.innerHTML = `<option value="">Choose a category</option>${categories.map((field) => `<option value="${escapeHtml(field.name)}">${escapeHtml(field.name)}</option>`).join("")}`;
      category.disabled = false;
      this.element.querySelector("[data-columns]")!.innerHTML = metadata.fields
        .map(
          (field) =>
            `<label><input type="checkbox" name="tableFields" value="${escapeHtml(field.name)}"> ${escapeHtml(field.name)}</label>`,
        )
        .join("");
      this.#find<HTMLFieldSetElement>("recipe-columns").disabled = false;
      this.#find<HTMLButtonElement>("recipe-create").disabled = false;
      this.#status(
        `Verified ${metadata.rows.length} readable records${metadata.truncated ? " (bounded sample)" : ""}. Choose a category and 1–8 columns. Creation rechecks source access.`,
      );
    } catch (error) {
      if (this.#disposed || request.signal.aborted || sequence !== this.#sequence) return;
      this.#status(`Cannot use this dataset: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #create(): Promise<void> {
    if (this.#busy || this.#accepted || !this.#metadata) return;
    const input: ExploreDatasetInput = this.#submitted ?? {
      recipeId: EXPLORE_DATASET_RECIPE.id,
      recipeVersion: EXPLORE_DATASET_RECIPE.version,
      packageKey: this.#find<HTMLInputElement>("recipe-package-key").value.trim(),
      sourceId: this.#metadata.source.id,
      categoryField: this.#find<HTMLSelectElement>("recipe-category").value,
      tableFields: Array.from(
        this.element.querySelectorAll<HTMLInputElement>('input[name="tableFields"]:checked'),
        (entry) => entry.value,
      ),
    };
    if (input.tableFields.length < 1 || input.tableFields.length > 8) {
      this.#status("Choose 1–8 table columns.");
      return;
    }
    try {
      compileExploreDataset(input, this.#metadata);
    } catch (error) {
      this.#status(error instanceof Error ? error.message : String(error));
      return;
    }
    this.#submitted = input;
    this.#busy = true;
    for (const entry of this.element.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLFieldSetElement
    >("input, select, button, fieldset"))
      entry.disabled = entry.dataset.testid !== "recipe-close";
    this.#find("recipe-close").textContent = "Close picker";
    this.#status(
      "Creating the editable draft. Close picker stops attachment; any accepted server draft is retained for explicit retry.",
    );
    try {
      const identity = await this.options.create(input, this.#submissionId);
      if (this.#disposed) return;
      this.#accepted = true;
      this.#status(
        `Created draft ${identity.draftId}. Refine the map, table and filter through the normal visual editor or conversation. Save and publish through the workspace lifecycle.`,
      );
      this.#find("recipe-create").textContent = "Draft created";
      const another = this.#find<HTMLButtonElement>("recipe-new");
      another.hidden = !this.options.startAnother;
      another.disabled = false;
    } catch (error) {
      if (this.#disposed) return;
      const create = this.#find<HTMLButtonElement>("recipe-create");
      if (this.options.canChangeInputs?.(this.#submissionId)) {
        this.#submitted = undefined;
        this.#submissionId = crypto.randomUUID();
        for (const entry of this.element.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLFieldSetElement>(
          "input, select, fieldset",
        ))
          entry.disabled = false;
        create.textContent = "Create editable draft";
        this.#status(
          `${error instanceof Error ? error.message : String(error)} No creation was submitted. Change the inputs or retry.`,
        );
      } else {
        this.#status(
          `${error instanceof Error ? error.message : String(error)} Retry keeps this submission's inputs and identity.`,
        );
        create.textContent = "Retry original submission";
      }
      create.disabled = false;
    } finally {
      this.#busy = false;
      if (!this.#disposed) {
        const close = this.#find<HTMLButtonElement>("recipe-close");
        close.disabled = false;
        close.textContent = "Close";
      }
    }
  }
}
