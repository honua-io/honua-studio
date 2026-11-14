import type { CompositionCommand } from "../composition/commands.js";
import type { CompositionState } from "../composition/model.js";
import type { HonuaStudioCommandOutcome } from "../elements/types.js";

const ELEMENTS = {
  table: "Data table",
  chart: "Category chart",
  legend: "Legend",
  toc: "Layer list",
  navigation: "Navigation",
  scale: "Scale",
  fullscreen: "Fullscreen",
  measure: "Measure distance",
  attribution: "Attribution",
  basemapSwitcher: "Basemap switcher",
} as const;
type ElementKind = keyof typeof ELEMENTS;

export interface ManualElementsOptions {
  readonly state: () => CompositionState;
  readonly dispatch: (commands: readonly CompositionCommand[]) => Promise<HonuaStudioCommandOutcome>;
  readonly close: () => void;
}

/** Forms author the same commands as the agent; the editor owns persistence, validation and history. */
export class ManualElementsPanel {
  readonly #form = document.createElement("form");
  readonly #kind = document.createElement("select");
  readonly #title = document.createElement("input");
  readonly #source = document.createElement("select");
  readonly #field = document.createElement("input");
  readonly #status = document.createElement("p");
  readonly #list = document.createElement("ul");
  readonly #submit = document.createElement("button");
  #dirty = false;
  #busy = false;
  #disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly options: ManualElementsOptions,
  ) {
    container.classList.add("manual-elements-panel", "hn-panel");
    container.setAttribute("aria-label", "Add widgets and controls");
    const heading = document.createElement("h2");
    heading.textContent = "Widgets and controls";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    close.addEventListener("click", options.close);
    this.#buildForm();
    container.append(heading, close, this.#form, this.#status, this.#list);
    this.#bindForm();
    this.refresh();
    this.#kind.focus();
  }

  #buildForm(): void {
    for (const [kind, title] of Object.entries(ELEMENTS)) this.#kind.add(new Option(title, kind));
    this.#kind.name = "kind";
    this.#title.name = "title";
    this.#source.name = "source";
    this.#field.name = "field";
    this.#field.placeholder = "For example, zoning_code";
    this.#submit.type = "submit";
    this.#submit.textContent = "Add element";
    this.#status.setAttribute("role", "status");
    this.#form.append(
      this.#label("Element", this.#kind),
      this.#label("Title (optional)", this.#title),
      this.#label("Data layer", this.#source),
      this.#label("Category field", this.#field),
      this.#submit,
    );
  }

  #bindForm(): void {
    this.#form.addEventListener("input", () => {
      this.#dirty = true;
    });
    this.#form.addEventListener("change", () => {
      this.#dirty = true;
    });
    this.#kind.addEventListener("change", () => this.refresh());
    this.#form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#add();
    });
  }

  get hasPendingChanges(): boolean {
    return this.#dirty;
  }

  refresh(): void {
    if (this.#disposed) return;
    const state = this.options.state();
    const selected = this.#source.value;
    this.#source.replaceChildren(new Option("Choose a layer", ""));
    for (const layer of state.layers) this.#source.add(new Option(layer.title ?? layer.id, layer.id));
    this.#source.value = selected;
    const data = this.#kind.value === "table" || this.#kind.value === "chart";
    this.#source.parentElement!.hidden = !data;
    this.#source.disabled = !data || this.#busy;
    this.#field.parentElement!.hidden = this.#kind.value !== "chart";
    this.#field.disabled = this.#kind.value !== "chart" || this.#busy;
    this.#source.required = data;
    this.#field.required = this.#kind.value === "chart";
    this.#submit.disabled = this.#busy;
    this.#kind.disabled = this.#busy;
    this.#title.disabled = this.#busy;
    this.#list.replaceChildren();
    for (const widget of state.widgets) this.#item(widget, "widget");
    for (const control of state.controls) this.#item(control, "control");
  }

  dispose(): void {
    this.#disposed = true;
    this.container.replaceChildren();
  }

  #label(text: string, input: HTMLElement): HTMLLabelElement {
    const label = document.createElement("label");
    label.append(document.createTextNode(text), input);
    return label;
  }

  #item(
    element: { readonly id: string; readonly kind: string; readonly title?: string },
    type: "widget" | "control",
  ): void {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `Remove ${element.title ?? element.kind}`;
    button.disabled = this.#busy;
    button.addEventListener("click", () => {
      void this.#run({
        name: type === "widget" ? "removeWidget" : "removeControl",
        target: { kind: type === "widget" ? "component" : "control", id: element.id },
      });
    });
    item.append(button);
    this.#list.append(item);
  }

  async #add(): Promise<void> {
    if (this.#busy || this.#disposed || !this.#form.reportValidity()) return;
    const kind = this.#kind.value as ElementKind;
    if (kind === "chart" && !this.#field.value.trim()) {
      this.#status.textContent = "Enter a category field.";
      return;
    }
    const id = `manual-${crypto.randomUUID()}`;
    const title = this.#title.value.trim() || ELEMENTS[kind];
    if (kind === "table" || kind === "chart") {
      if (!this.options.state().layers.some((layer) => layer.id === this.#source.value)) {
        this.#status.textContent = "Choose a layer still present in this map.";
        return;
      }
      await this.#run({
        name: "addWidget",
        widget: {
          id,
          kind,
          title,
          sourceId: this.#source.value,
          config: kind === "chart" ? { groupBy: this.#field.value.trim(), chartType: "bar" } : {},
        },
      });
    } else if (kind === "legend" || kind === "toc") {
      await this.#run({ name: "addWidget", widget: { id, kind, title } });
    } else {
      await this.#run({ name: "addControl", control: { id, kind, title } });
    }
  }

  async #run(command: CompositionCommand): Promise<void> {
    if (this.#busy || this.#disposed) return;
    this.#busy = true;
    this.refresh();
    this.#status.textContent = "Saving…";
    try {
      const result = await this.options.dispatch([command]);
      if (result.ok && (command.name === "addWidget" || command.name === "addControl")) this.#dirty = false;
      if (!this.#disposed)
        this.#status.textContent = result.ok ? "Saved. Use Undo to reverse this edit." : result.reason;
    } catch (error) {
      if (!this.#disposed) this.#status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      this.#busy = false;
      this.refresh();
    }
  }
}
