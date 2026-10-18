import type {
  ImportedProcessDataset,
  LocalProcessWorkspace,
  LocalRunReceipt,
  LocalSourceFile,
  PublishedProcessLayer,
} from "../gp/custom-process-workspace.js";
import { HonuaStudioElementBase } from "./base-element.js";

/** Separate Python/.NET source/fixture lane. Every run is a local sandbox snapshot. */
export class HonuaStudioCustomProcessesElement extends HonuaStudioElementBase {
  public client: LocalProcessWorkspace | undefined;
  #files: readonly LocalSourceFile[] = [];
  #selected: LocalSourceFile | undefined;
  #content = "";
  #receipt: LocalRunReceipt | undefined;
  #dataset: ImportedProcessDataset | undefined;
  #layer: PublishedProcessLayer | undefined;
  #message = "Connect the local sandbox bridge to edit Python or .NET projects.";
  #busy = false;
  #values: Record<string, string> = {};
  protected onConnect(): void {
    this.render();
  }
  protected onDisconnect(): void {}
  render(): void {
    const root = this.shadowRoot;
    if (!root) return;
    root.innerHTML = `<style>:host{display:block;padding:1rem;font:14px system-ui}textarea{display:block;box-sizing:border-box;width:100%;min-height:18rem;font:13px monospace}button,input,select{margin:.4rem}pre{white-space:pre-wrap}label{display:block}</style><h2>Custom Python / .NET</h2><p>Source and fixture bytes are frozen for each run. Restore, build and execution stay in the isolated container. Open the project in your IDE for breakpoints.</p><button data-action="load">Load project</button><select aria-label="Source file"></select><textarea aria-label="Process source" spellcheck="false"></textarea><button data-action="save">Save source</button><button data-action="run">Run immutable snapshot</button><button data-action="refresh">Refresh run</button><button data-action="cancel">Cancel run</button><label>Output artifact<select data-artifact></select></label><label>Dataset table<input data-field="table" /></label><button data-action="import">Import artifact as dataset</button><label>Managed database connection ID<input data-field="connection" /></label><label>Service name<input data-field="service" /></label><label>Layer title<input data-field="layer" /></label><button data-action="publish">Publish imported dataset</button><button data-action="map">Add published layer to map</button><pre role="status"></pre>`;
    const files = root.querySelector<HTMLSelectElement>('select[aria-label="Source file"]')!;
    for (const file of this.#files) {
      const option = document.createElement("option");
      option.value = file.path;
      option.textContent = file.path;
      option.selected = file.path === this.#selected?.path;
      files.append(option);
    }
    files.addEventListener("change", () => {
      if (this.#selected && this.#content !== this.#selected.content) {
        this.#message = "Save the current source before changing files.";
        this.render();
        return;
      }
      this.#selected = this.#files.find((file) => file.path === files.value);
      this.#content = this.#selected?.content ?? "";
      this.render();
    });
    const editor = root.querySelector("textarea")!;
    editor.value = this.#content;
    editor.addEventListener("input", () => {
      this.#content = editor.value;
    });
    const artifacts = root.querySelector<HTMLSelectElement>("[data-artifact]")!;
    for (const artifact of this.#receipt?.artifacts ?? []) {
      const option = document.createElement("option");
      option.value = artifact.path;
      option.textContent = artifact.path;
      artifacts.append(option);
    }
    for (const input of root.querySelectorAll<HTMLInputElement>("input")) {
      input.value = this.#values[input.dataset.field!] ?? "";
      input.addEventListener("input", () => {
        this.#values[input.dataset.field!] = input.value;
      });
    }
    root.querySelector("pre")!.textContent = this.#message;
    for (const button of root.querySelectorAll<HTMLButtonElement>("button")) {
      const action = button.dataset.action!;
      button.disabled =
        !this.client ||
        this.#busy ||
        (action === "save" && !this.#selected) ||
        (["refresh", "cancel"].includes(action) && !this.#receipt) ||
        (action === "import" && this.#receipt?.status !== "succeeded") ||
        (action === "publish" && !this.#dataset) ||
        (action === "map" && !this.#layer);
      button.addEventListener("click", () => {
        void this.#action(action, artifacts.value);
      });
    }
  }
  async #action(action: string, artifact: string): Promise<void> {
    const client = this.client;
    if (!client || this.#busy) return;
    this.#busy = true;
    try {
      if (action === "load") {
        const project = await client.project();
        this.#files = project.files;
        this.#selected = this.#files[0];
        this.#content = this.#selected?.content ?? "";
        this.#message = `Immutable image: ${project.image}\nIDE project: ${project.ideHandoff.workspace}`;
      }
      if (action === "save" && this.#selected) {
        const saved = await client.save(this.#selected, this.#content);
        this.#selected = { ...this.#selected, content: this.#content, sha256: saved.sha256 };
        this.#files = this.#files.map((file) => (file.path === saved.path ? this.#selected! : file));
        this.#message = "Source saved. Run a fresh snapshot to test the correction.";
      }
      if (action === "run") {
        if (this.#selected && this.#content !== this.#selected.content)
          throw new Error("Save source changes before running an immutable snapshot.");
        this.#dataset = undefined;
        this.#layer = undefined;
        this.#receipt = await client.run();
        this.#message = JSON.stringify(this.#receipt, null, 2);
      }
      if (action === "refresh" && this.#receipt) {
        this.#receipt = await client.status(this.#receipt.runId);
        this.#message = JSON.stringify(this.#receipt, null, 2);
      }
      if (action === "cancel" && this.#receipt) {
        this.#receipt = await client.cancel(this.#receipt.runId);
        this.#message = JSON.stringify(this.#receipt, null, 2);
      }
      if (action === "import" && this.#receipt) {
        this.#dataset = await client.importArtifact(this.#receipt, artifact, this.#values.table ?? "");
        this.#message = JSON.stringify(this.#dataset, null, 2);
      }
      if (action === "publish" && this.#dataset) {
        this.#layer = await client.publishDataset(
          this.#dataset,
          this.#values.connection ?? "",
          this.#values.service ?? "",
          this.#values.layer ?? "",
        );
        this.#message = JSON.stringify(this.#layer, null, 2);
      }
      if (action === "map" && this.#layer)
        this.dispatchEvent(
          new CustomEvent("honua-processes-layer-ready", {
            bubbles: true,
            composed: true,
            detail: { layer: this.#layer, dataset: this.#dataset, run: this.#receipt },
          }),
        );
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    } finally {
      this.#busy = false;
      this.render();
    }
  }
}
