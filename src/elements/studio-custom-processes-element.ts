import type {
  ImportedProcessDataset,
  LocalProcessWorkspace,
  LocalProjectIdentity,
  LocalRunReceipt,
  LocalSourceFile,
  PublishedProcessLayer,
} from "../gp/custom-process-workspace.js";
import { HonuaStudioElementBase } from "./base-element.js";

/** Separate Python/.NET source/fixture lane. Every run is a local sandbox snapshot. */
export class HonuaStudioCustomProcessesElement extends HonuaStudioElementBase {
  #client: LocalProcessWorkspace | undefined;
  #project: LocalProjectIdentity | undefined;
  #pendingAction: Promise<void> = Promise.resolve();
  public get client(): LocalProcessWorkspace | undefined {
    return this.#client;
  }
  public set client(client: LocalProcessWorkspace | undefined) {
    if (client === this.#client) return;
    this.#client = client;
    this.#project = undefined;
    this.#files = [];
    this.#selected = undefined;
    this.#content = "";
    this.#receipt = undefined;
    this.#dataset = undefined;
    this.#layer = undefined;
    this.#values = {};
    if (this.isConnected) this.render();
  }
  public async prepareWorkspaceTask(): Promise<{ projectId: string; revision: number; sourceDigest: string }> {
    await this.#pendingAction;
    if (!this.#project || !this.client || this.#dirty())
      throw new Error("Load the actual project and save source before capturing a turn.");
    const client = this.client;
    const project = this.#project;
    const observed = await client.identity();
    this.#assertClient(client);
    if (this.#dirty() || !this.#matches(observed, project))
      throw new Error("The actual project changed; refresh it before capturing a turn.");
    return { projectId: observed.projectId, revision: observed.revision, sourceDigest: observed.sourceDigest };
  }
  public async attachWorkspaceTask(reference: {
    projectId: string;
    revision: number;
    sourceDigest: string;
  }): Promise<boolean> {
    await this.#pendingAction;
    if (!this.client || this.#dirty()) return false;
    const client = this.client;
    const text = this.#content;
    const project = await client.project();
    if (client !== this.client || this.#dirty() || this.#content !== text || !this.#matches(project, reference))
      return false;
    this.#project = project;
    this.#files = project.files;
    this.#selected = this.#files.find((file) => file.path === this.#selected?.path) ?? this.#files[0];
    this.#content = this.#selected?.content ?? "";
    this.#announceTask();
    this.render();
    return true;
  }
  public async refreshWorkspaceTask(): Promise<boolean> {
    await this.#pendingAction;
    if (!this.client || !this.#project) return false;
    const client = this.client;
    const observed = await client.identity();
    if (client !== this.client || !observed.binding) return false;
    if (this.#dirty()) {
      if (!this.#matches(this.#project, observed)) {
        this.#message =
          "Project source changed outside this editor. Unsaved text is preserved; review the current revision before saving or running.";
        this.render();
      }
      return false;
    }
    return this.attachWorkspaceTask(observed);
  }
  #assertClient(client: LocalProcessWorkspace): void {
    if (client !== this.client) throw new Error("The local workspace session changed.");
  }
  #matches(
    left: { projectId: string; revision: number; sourceDigest: string },
    right: { projectId: string; revision: number; sourceDigest: string },
  ): boolean {
    return (
      left.projectId === right.projectId && left.revision === right.revision && left.sourceDigest === right.sourceDigest
    );
  }
  #dirty(): boolean {
    return Boolean(this.#selected && this.#content !== this.#selected.content);
  }
  #announceTask(): void {
    const project = this.#project;
    this.dispatchEvent(
      new CustomEvent("honua-local-process-task-change", {
        bubbles: true,
        composed: true,
        detail:
          project && !this.#dirty()
            ? { projectId: project.projectId, revision: project.revision, sourceDigest: project.sourceDigest }
            : undefined,
      }),
    );
  }
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
      this.#announceTask();
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
        this.#pendingAction = this.#action(action, artifacts.value);
      });
    }
  }
  async #action(action: string, artifact: string): Promise<void> {
    const client = this.client;
    if (!client || this.#busy) return;
    this.#busy = true;
    try {
      if (action === "load") {
        if (this.#dirty()) throw new Error("Save the current source before loading another project.");
        await client.bind();
        this.#assertClient(client);
        const project = await client.project();
        this.#assertClient(client);
        this.#project = project;
        this.#files = project.files;
        this.#selected = this.#files[0];
        this.#content = this.#selected?.content ?? "";
        this.#message = `Immutable image: ${project.image}\nIDE project: ${project.ideHandoff?.workspace ?? "Use the paired project in your IDE"}`;
        this.#announceTask();
      }
      if (action === "save" && this.#selected) {
        const content = this.#content;
        const saved = await client.save(this.#selected, content, this.#project);
        this.#assertClient(client);
        this.#selected = { ...this.#selected, content, sha256: saved.sha256 };
        if (this.#project)
          this.#project = { ...this.#project, revision: saved.revision, sourceDigest: saved.sourceDigest };
        this.#files = this.#files.map((file) => (file.path === saved.path ? this.#selected! : file));
        this.#message = "Source saved. Run a fresh snapshot to test the correction.";
        this.#announceTask();
      }
      if (action === "run") {
        if (this.#selected && this.#content !== this.#selected.content)
          throw new Error("Save source changes before running an immutable snapshot.");
        this.#dataset = undefined;
        this.#layer = undefined;
        const receipt = await client.run(this.#project);
        this.#assertClient(client);
        this.#receipt = receipt;
        this.#message = JSON.stringify(this.#receipt, null, 2);
      }
      if (action === "refresh" && this.#receipt) {
        const receipt = await client.status(this.#receipt.runId);
        this.#assertClient(client);
        this.#receipt = receipt;
        this.#message = JSON.stringify(this.#receipt, null, 2);
      }
      if (action === "cancel" && this.#receipt) {
        const receipt = await client.cancel(this.#receipt.runId);
        this.#assertClient(client);
        this.#receipt = receipt;
        this.#message = JSON.stringify(this.#receipt, null, 2);
      }
      if (action === "import" && this.#receipt) {
        const dataset = await client.importArtifact(this.#receipt, artifact, this.#values.table ?? "");
        this.#assertClient(client);
        this.#dataset = dataset;
        this.#message = JSON.stringify(this.#dataset, null, 2);
      }
      if (action === "publish" && this.#dataset) {
        const layer = await client.publishDataset(
          this.#dataset,
          this.#values.connection ?? "",
          this.#values.service ?? "",
          this.#values.layer ?? "",
        );
        this.#assertClient(client);
        this.#layer = layer;
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
