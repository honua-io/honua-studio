import type { ProcessGraph, ProcessRun, ServerProcessWorkspace } from "../gp/process-workspace.js";
import { HonuaStudioElementBase } from "./base-element.js";

/** Built-in DAG authoring. Runtime compilation and execution belong to honua-server. */
export class HonuaStudioProcessesElement extends HonuaStudioElementBase {
  public client: ServerProcessWorkspace | undefined;
  #graph: ProcessGraph = { schemaVersion: "workflow-package.v1", nodes: [], edges: [] };
  #prepared: Awaited<ReturnType<ServerProcessWorkspace["prepare"]>> | undefined;
  #run: ProcessRun | undefined;
  #busy = false;
  #message = "Connect an authenticated Processes host to load the built-in registry.";
  public get graph(): ProcessGraph {
    return structuredClone(this.#graph);
  }
  public set graph(graph: ProcessGraph) {
    this.#graph = structuredClone(graph);
    this.#prepared = undefined;
    this.render();
  }
  protected onConnect(): void {
    this.render();
  }
  protected onDisconnect(): void {}
  render(): void {
    const root = this.shadowRoot;
    if (!root) return;
    root.innerHTML = `<style>:host{display:block;padding:1rem;font:14px system-ui;color:var(--hn-text,#18252d)}textarea{box-sizing:border-box;width:100%;min-height:20rem;font:13px monospace}button{margin:.5rem .5rem .5rem 0}pre{white-space:pre-wrap}fieldset{border:1px solid #b7c9c4}</style><h2>Processes</h2><p>Built-in process nodes run through the server workflow compiler and job engine. Python and .NET projects use a separate local sandbox and IDE.</p><fieldset><legend>Built-in graph</legend><label>Graph nodes, source identities and port edges<textarea aria-label="Process graph" spellcheck="false"></textarea></label><button data-action="registry">Load registry</button><button data-action="prepare">Save and validate snapshot</button><button data-action="run">Run validated snapshot</button><button data-action="status">Refresh run</button><button data-action="cancel">Cancel run</button></fieldset><pre role="status"></pre>`;
    const editor = root.querySelector("textarea")!;
    editor.value = JSON.stringify(this.#graph, null, 2);
    editor.addEventListener("input", () => {
      this.#prepared = undefined;
      const run = root.querySelector<HTMLButtonElement>('[data-action="run"]');
      if (run) run.disabled = true;
    });
    root.querySelector("pre")!.textContent = this.#message;
    for (const button of root.querySelectorAll<HTMLButtonElement>("button")) {
      button.disabled =
        this.#busy ||
        !this.client ||
        (button.dataset.action === "run" && !this.#prepared) ||
        (["status", "cancel"].includes(button.dataset.action ?? "") && !this.#run);
      button.addEventListener("click", () => {
        void this.#action(button.dataset.action!, editor.value);
      });
    }
  }
  async #action(action: string, graphText: string): Promise<void> {
    const client = this.client;
    if (!client || this.#busy) return;
    this.#busy = true;
    try {
      if (action === "registry") this.#message = JSON.stringify(await client.registry(), null, 2);
      if (action === "prepare") {
        this.#graph = JSON.parse(graphText) as ProcessGraph;
        this.#prepared = await client.prepare("Processes", this.#graph);
        this.#message = JSON.stringify(this.#prepared.validation, null, 2);
      }
      if (action === "run" && this.#prepared) {
        const command = client.reserveCommand(this.#prepared.packageId, this.#prepared.version);
        this.#run = await client.run(
          this.#prepared.packageId,
          this.#prepared.version,
          command.commandId,
          command.reconcileOnly,
        );
        this.#message = JSON.stringify(this.#run, null, 2);
      }
      if (action === "status" && this.#run) this.#message = JSON.stringify(await client.status(this.#run), null, 2);
      if (action === "cancel" && this.#run) this.#message = JSON.stringify(await client.cancel(this.#run), null, 2);
    } catch (error) {
      this.#message = error instanceof Error ? error.message : String(error);
    } finally {
      this.#busy = false;
      this.render();
    }
  }
}
