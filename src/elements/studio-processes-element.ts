import {
  type ProcessDiagnostic,
  type ProcessGraph,
  type ProcessNodeDefinition,
  type ProcessRegistry,
  type ProcessRun,
  ProcessValidationError,
  type ServerProcessWorkspace,
  validateProcessGraph,
} from "../gp/process-workspace.js";
import { HonuaStudioElementBase } from "./base-element.js";

export interface ProcessSourcePicker {
  list(): Promise<readonly { id: string; title: string }[]>;
  resolve(sourceId: string): Promise<{ processLayerId?: number; unavailableReason?: string }>;
}

/** Edits the canonical workflow graph; compilation and execution remain server-owned. */
export class HonuaStudioProcessesElement extends HonuaStudioElementBase {
  #client: ServerProcessWorkspace | undefined;
  #sourcePicker: ProcessSourcePicker | undefined;
  #sourcePickGeneration = 0;
  public get sourcePicker(): ProcessSourcePicker | undefined {
    return this.#sourcePicker;
  }
  public set sourcePicker(value: ProcessSourcePicker | undefined) {
    if (value !== this.#sourcePicker) this.#sourcePickGeneration++;
    this.#sourcePicker = value;
    if (this.isConnected) this.render();
  }
  #attachmentGeneration = 0;
  #clientGeneration = 0;
  public get client(): ServerProcessWorkspace | undefined {
    return this.#client;
  }
  public set client(client: ServerProcessWorkspace | undefined) {
    if (client !== this.#client) {
      this.#attachmentGeneration++;
      this.#clientGeneration++;
      this.#prepared = undefined;
      this.#run = undefined;
      this.#registry = undefined;
    }
    this.#client = client;
    if (this.isConnected) this.render();
  }
  #graph: ProcessGraph = { schemaVersion: "workflow-package.v1", nodes: [], edges: [] };
  #graphText = JSON.stringify(this.#graph, null, 2);
  #dirty = false;
  #advancedPending = false;
  #advancedOpen = false;
  #selected: string | undefined;
  #registry: ProcessRegistry | undefined;
  #diagnostics: readonly ProcessDiagnostic[] = [];
  #pendingAction: Promise<void> = Promise.resolve();
  #prepared: Awaited<ReturnType<ServerProcessWorkspace["prepare"]>> | undefined;
  #run: ProcessRun | undefined;
  #busy = false;
  #message = "Load the server registry to add built-in process nodes.";

  public get graph(): ProcessGraph {
    return structuredClone(this.#graph);
  }
  public set graph(graph: ProcessGraph) {
    this.#attachmentGeneration++;
    this.#graph = structuredClone(graph);
    this.#graphText = JSON.stringify(this.#graph, null, 2);
    this.#dirty = false;
    this.#advancedPending = false;
    this.#prepared = undefined;
    this.render();
  }
  public async prepareWorkspaceTask(): Promise<{ packageId: string; version: number; contentHash: string }> {
    await this.#pendingAction;
    if (this.#dirty || !this.#prepared) throw new Error("Save and validate the current graph before capturing a turn.");
    return {
      packageId: this.#prepared.packageId,
      version: this.#prepared.version,
      contentHash: this.#prepared.contentHash,
    };
  }
  public async attachWorkspaceTask(task: {
    packageId: string;
    version: number;
    contentHash: string;
  }): Promise<boolean> {
    const generation = ++this.#attachmentGeneration;
    const client = this.client;
    await this.#pendingAction;
    if (generation !== this.#attachmentGeneration || this.#dirty || !client || client !== this.client) return false;
    const text = this.#graphText;
    const prepared = await client.readVersion(task.packageId, task.version, task.contentHash);
    if (generation !== this.#attachmentGeneration || client !== this.client || this.#dirty || this.#graphText !== text)
      return false;
    this.#prepared = prepared;
    this.#graph = structuredClone(prepared.graph);
    this.#graphText = JSON.stringify(this.#graph, null, 2);
    this.#advancedPending = false;
    this.#selected = this.#graph.nodes[0]?.nodeId;
    this.#diagnostics = [];
    this.render();
    return true;
  }
  protected onConnect(): void {
    this.render();
  }
  protected onDisconnect(): void {}

  #definition(type: string): ProcessNodeDefinition | undefined {
    return this.#registry?.nodes.find((node) => node.nodeTypeId === type);
  }
  #change(graph: ProcessGraph, rerender = true): void {
    if (this.#advancedPending) {
      this.#message = "Apply or restore advanced JSON before editing visually.";
      this.render();
      return;
    }
    this.#attachmentGeneration++;
    this.#graph = graph;
    this.#graphText = JSON.stringify(graph, null, 2);
    this.#dirty = true;
    this.#advancedPending = false;
    this.#prepared = undefined;
    this.#diagnostics = this.#registry ? validateProcessGraph(graph, this.#registry) : [];
    this.dispatchEvent(new CustomEvent("honua-process-graph-change", { bubbles: true, composed: true }));
    if (rerender) this.render();
  }
  #button(parent: HTMLElement, label: string, handler: () => void, disabled = false): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = disabled || this.#busy;
    button.addEventListener("click", handler);
    parent.append(button);
    return button;
  }
  #text(parent: HTMLElement, tag: string, text: string): HTMLElement {
    const element = document.createElement(tag);
    element.textContent = text;
    parent.append(element);
    return element;
  }
  #select(parent: HTMLElement, title: string, values: readonly { value: string; label: string }[]): HTMLSelectElement {
    const label = document.createElement("label");
    label.append(document.createTextNode(title));
    const select = document.createElement("select");
    select.setAttribute("aria-label", title);
    for (const value of values) {
      const option = document.createElement("option");
      option.value = value.value;
      option.textContent = value.label;
      select.append(option);
    }
    label.append(select);
    parent.append(label);
    select.disabled = this.#busy || this.#advancedPending;
    return select;
  }
  render(): void {
    const root = this.shadowRoot;
    if (!root) return;
    root.innerHTML = `<style>:host{display:block;color:var(--hn-text,#18252d);font:14px system-ui}*{box-sizing:border-box}h2,h3{margin:.5rem 0}button,select,input,textarea{font:inherit}button{padding:.45rem .7rem;cursor:pointer}button:disabled{cursor:default}label{display:grid;gap:.25rem;margin:.6rem 0}input,select,textarea{width:100%;padding:.45rem;border:1px solid #9cafad;border-radius:4px;background:var(--hn-surface,#fff);color:inherit}.workspace{display:grid;grid-template-columns:minmax(190px,1fr) minmax(250px,2fr) minmax(220px,1fr);gap:1rem}.panel{padding:1rem;border:1px solid #b7c9c4;border-radius:8px;min-width:0}.palette button{display:block;width:100%;text-align:left;margin:.5rem 0}.nodes{display:flex;flex-wrap:wrap;align-items:flex-start;gap:.75rem;list-style:none;padding:0}.node{border:2px solid #a4bfba;border-radius:8px;padding:.75rem;min-width:180px;max-width:100%;background:var(--hn-surface,#fff)}.node[aria-current=true]{border-color:#146658}.node[data-error=true]{border-color:#b43c31}.node button{font-weight:600;width:100%}.ports{display:flex;justify-content:space-between;gap:1rem;font-size:.85rem}.ports ul{padding-left:1rem}.toolbar{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}.connections li{margin:.5rem 0;overflow-wrap:anywhere}.connections button{margin-left:.5rem}.diagnostics{color:#a52c22}.diagnostics button{text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere}textarea{min-height:18rem;font:13px monospace}.hint{font-size:.85rem;color:var(--hn-muted,#45615b)}@media(max-width:1000px){.workspace{grid-template-columns:1fr}.palette button{display:inline-block;width:auto;margin-right:.5rem}}</style><h2>Processes</h2><p>Connect built-in nodes, configure their inputs, then validate and run an immutable server snapshot. Custom Python and .NET projects use the separate code workspace.</p><div class="toolbar"></div><div class="workspace"><section class="panel palette" aria-label="Process palette"><h3>Add a process</h3></section><section class="panel" aria-label="Process graph"><h3>Graph</h3><ul class="nodes" aria-label="Process nodes"></ul><h3>Connections</h3><ul class="connections"></ul><div class="connect"></div></section><section class="panel inspector" aria-label="Node configuration"><h3>Configure node</h3></section></div><section class="diagnostics" aria-label="Graph diagnostics"></section><pre role="status" aria-live="polite"></pre><details class="advanced"><summary>Advanced graph JSON</summary><label>Graph nodes, source identities and port edges<textarea aria-label="Process graph" spellcheck="false"></textarea></label><div class="advanced-actions"></div></details>`;
    const toolbar = root.querySelector<HTMLElement>(".toolbar")!;
    for (const [action, label] of [
      ["registry", "Load registry"],
      ["prepare", "Save and validate snapshot"],
      ["run", "Run validated snapshot"],
      ["status", "Refresh run"],
      ["cancel", "Cancel run"],
    ]) {
      const button = this.#button(
        toolbar,
        label!,
        () => {
          this.#pendingAction = this.#action(action!);
        },
        !this.client ||
          (action === "run" && (!this.#prepared || this.#dirty)) ||
          (["status", "cancel"].includes(action!) && !this.#run),
      );
      button.dataset.action = action;
    }
    const palette = root.querySelector<HTMLElement>(".palette")!;
    const available =
      this.#registry?.nodes.filter(
        (node) =>
          node.providerId === "geoprocessing.process-catalog" &&
          node.nodeTypeId.startsWith("process:") &&
          !node.nodeTypeId.startsWith("process:custom"),
      ) ?? [];
    if (!available.length) this.#text(palette, "p", "Load the current server registry to see available processes.");
    for (const definition of available) {
      const button = this.#button(
        palette,
        definition.title,
        () => {
          const nodeId = `node-${crypto.randomUUID()}`;
          const parameters = Object.fromEntries(
            definition.parameterSchemas
              .filter((parameter) => parameter.defaultValue != null)
              .map((parameter) => [parameter.name, parameter.defaultValue!]),
          );
          this.#selected = nodeId;
          this.#change({
            ...this.#graph,
            nodes: [...this.#graph.nodes, { nodeId, nodeTypeId: definition.nodeTypeId, parameters }],
          });
        },
        this.#advancedPending,
      );
      button.title = [definition.category, definition.description].filter(Boolean).join(": ");
    }
    for (const warning of this.#registry?.warnings ?? []) this.#text(palette, "p", warning);
    this.#renderNodes(root.querySelector<HTMLElement>(".nodes")!);
    this.#renderConnections(
      root.querySelector<HTMLElement>(".connections")!,
      root.querySelector<HTMLElement>(".connect")!,
    );
    this.#renderInspector(root.querySelector<HTMLElement>(".inspector")!);
    const diagnostics = root.querySelector<HTMLElement>(".diagnostics")!;
    for (const diagnostic of this.#diagnostics)
      this.#button(
        diagnostics,
        `${diagnostic.nodeId ?? "Graph"}${diagnostic.fieldPath ? ` / ${diagnostic.fieldPath}` : ""}: ${diagnostic.message}`,
        () => {
          this.#selected = diagnostic.nodeId;
          this.render();
        },
      );
    root.querySelector("pre")!.textContent = this.#message;
    const advanced = root.querySelector<HTMLDetailsElement>("details")!;
    advanced.open = this.#advancedOpen;
    advanced.addEventListener("toggle", () => {
      this.#advancedOpen = advanced.open;
      if (advanced.open && !this.#advancedPending) root.querySelector("textarea")!.value = this.#graphText;
    });
    const editor = root.querySelector("textarea")!;
    editor.value = this.#graphText;
    editor.disabled = this.#busy;
    editor.addEventListener("input", () => {
      this.#graphText = editor.value;
      this.#dirty = true;
      this.#advancedPending = true;
      this.#prepared = undefined;
      const run = root.querySelector<HTMLButtonElement>('[data-action="run"]');
      if (run) run.disabled = true;
      this.dispatchEvent(new CustomEvent("honua-process-graph-change", { bubbles: true, composed: true }));
    });
    const advancedActions = root.querySelector<HTMLElement>(".advanced-actions")!;
    this.#button(advancedActions, "Apply JSON to visual graph", () => {
      try {
        const graph = this.#parseGraph();
        this.#advancedPending = false;
        this.#change(graph);
        this.#message = "Graph updated; save and validate before running.";
      } catch (error) {
        this.#message = error instanceof Error ? error.message : String(error);
      }
      this.render();
    });
    this.#button(advancedActions, "Restore visual graph JSON", () => {
      this.#graphText = JSON.stringify(this.#graph, null, 2);
      this.#advancedPending = false;
      this.render();
    });
  }
  #renderNodes(parent: HTMLElement): void {
    if (!this.#graph.nodes.length) this.#text(parent, "li", "Add a process from the palette to start.");
    for (const node of this.#graph.nodes) {
      const definition = this.#definition(node.nodeTypeId);
      const card = this.#text(parent, "li", "");
      card.className = "node";
      card.setAttribute("aria-current", String(node.nodeId === this.#selected));
      card.dataset.error = String(this.#diagnostics.some((item) => item.nodeId === node.nodeId));
      this.#button(card, definition?.title ?? node.nodeTypeId, () => {
        this.#selected = node.nodeId;
        this.render();
      });
      this.#text(card, "small", node.nodeId);
      const ports = this.#text(card, "div", "");
      ports.className = "ports";
      for (const [label, values] of [
        ["Inputs", definition?.inputSchemas ?? []],
        ["Outputs", definition?.outputSchemas ?? []],
      ] as const) {
        const column = this.#text(ports, "div", label);
        const list = this.#text(column, "ul", "");
        for (const port of values)
          this.#text(list, "li", `${port.title ?? port.name}${port.required ? " *" : ""} (${port.name})`);
        if (!values.length) this.#text(list, "li", "None");
      }
    }
  }
  #renderConnections(list: HTMLElement, form: HTMLElement): void {
    for (const [index, edge] of this.#graph.edges.entries()) {
      const item = this.#text(
        list,
        "li",
        `${edge.sourceNodeId}${edge.sourcePort ? `.${edge.sourcePort}` : ""} → ${edge.targetNodeId}${edge.targetPort ? `.${edge.targetPort}` : ""} (${edge.kind})`,
      );
      this.#button(
        item,
        "Remove connection",
        () => this.#change({ ...this.#graph, edges: this.#graph.edges.filter((_, position) => position !== index) }),
        this.#advancedPending,
      );
    }
    if (this.#graph.nodes.length < 2) return;
    const nodes = this.#graph.nodes.map((node) => ({
      value: node.nodeId,
      label: `${this.#definition(node.nodeTypeId)?.title ?? node.nodeTypeId} · ${node.nodeId}`,
    }));
    const source = this.#select(form, "From node", nodes);
    const target = this.#select(form, "To node", nodes);
    target.selectedIndex = 1;
    const kind = this.#select(form, "Connection kind", [
      { value: "Data", label: "Data output to input" },
      { value: "Control", label: "Run after completion" },
    ]);
    const output = this.#select(form, "Output port", []);
    const input = this.#select(form, "Input port", []);
    const update = () => {
      for (const [select, id, portKind] of [
        [output, source.value, "outputSchemas"],
        [input, target.value, "inputSchemas"],
      ] as const) {
        select.replaceChildren();
        const node = this.#graph.nodes.find((entry) => entry.nodeId === id);
        for (const port of node ? (this.#definition(node.nodeTypeId)?.[portKind] ?? []) : []) {
          const option = document.createElement("option");
          option.value = port.name;
          option.textContent = `${port.title ?? port.name} (${port.name})`;
          select.append(option);
        }
        select.disabled = this.#busy || this.#advancedPending || kind.value === "Control";
      }
    };
    source.addEventListener("change", update);
    target.addEventListener("change", update);
    kind.addEventListener("change", update);
    update();
    this.#button(
      form,
      "Connect nodes",
      () => {
        if (this.#advancedPending) {
          this.#message = "Apply or restore advanced JSON before editing visually.";
          this.render();
          return;
        }
        if (source.value === target.value || (kind.value === "Data" && (!output.value || !input.value))) {
          this.#message = "Choose different nodes and both data ports.";
          this.render();
          return;
        }
        const edge = {
          sourceNodeId: source.value,
          targetNodeId: target.value,
          kind: kind.value as "Data" | "Control",
          ...(kind.value === "Data" ? { sourcePort: output.value, targetPort: input.value } : {}),
        };
        const graph = { ...this.#graph, edges: [...this.#graph.edges, edge] };
        const diagnostics = this.#registry ? validateProcessGraph(graph, this.#registry) : [];
        if (diagnostics.some((item) => item.code === "CYCLE")) {
          this.#diagnostics = diagnostics;
          this.#message = "Connection would create a cycle.";
          this.render();
          return;
        }
        this.#change(graph);
      },
      this.#advancedPending,
    );
  }
  #renderSourcePicker(parent: HTMLElement, nodeId: string, parameterName: string): void {
    const picker = this.#sourcePicker;
    if (!picker) {
      this.#text(
        parent,
        "small",
        "Published source selection requires an authorized host binding. The value is a storage layer ID, not a service layer index.",
      ).className = "hint";
      return;
    }
    const group = document.createElement("div");
    parent.append(group);
    this.#button(
      group,
      "Choose published source",
      () => {
        const epoch = ++this.#sourcePickGeneration;
        const client = this.client;
        const text = this.#graphText;
        const current = () =>
          epoch === this.#sourcePickGeneration &&
          picker === this.#sourcePicker &&
          client === this.client &&
          text === this.#graphText &&
          this.#selected === nodeId &&
          group.isConnected;
        const report = (error: unknown) => {
          if (current()) this.#text(group, "small", error instanceof Error ? error.message : String(error));
        };
        group.textContent = "Loading authorized sources…";
        void picker
          .list()
          .then((sources) => {
            if (!current()) return;
            if (sources.length > 1000 || new Set(sources.map((source) => source.id)).size !== sources.length)
              throw new Error("The source choices are not a bounded unique catalog.");
            group.textContent = "";
            const select = document.createElement("select");
            select.setAttribute("aria-label", `Published source · ${nodeId} · ${parameterName}`);
            for (const source of [{ id: "", title: "Select an actual published source" }, ...sources]) {
              const option = document.createElement("option");
              option.value = source.id;
              option.textContent = source.title;
              select.append(option);
            }
            group.append(select);
            select.addEventListener("change", () => {
              const sourceId = select.value;
              if (!sourceId || !current()) return;
              select.disabled = true;
              void picker
                .resolve(sourceId)
                .then((result) => {
                  if (!current()) return;
                  if (
                    !Number.isSafeInteger(result.processLayerId) ||
                    Number(result.processLayerId) <= 0 ||
                    Number(result.processLayerId) > 2147483647
                  )
                    throw new Error(
                      result.unavailableReason ?? "This source has no supported canonical process binding.",
                    );
                  const node = this.#graph.nodes.find((entry) => entry.nodeId === nodeId);
                  if (!node) return;
                  this.#message = `Selected ${sources.find((source) => source.id === sourceId)?.title ?? sourceId} using its verified process binding.`;
                  this.#change({
                    ...this.#graph,
                    nodes: this.#graph.nodes.map((entry) =>
                      entry.nodeId === nodeId
                        ? {
                            ...node,
                            parameters: { ...node.parameters, [parameterName]: String(result.processLayerId) },
                          }
                        : entry,
                    ),
                  });
                })
                .catch(report)
                .finally(() => {
                  if (current()) select.disabled = false;
                });
            });
          })
          .catch(report);
      },
      !this.client || this.#advancedPending,
    );
  }

  #renderInspector(parent: HTMLElement): void {
    const node = this.#graph.nodes.find((entry) => entry.nodeId === this.#selected);
    if (!node) {
      this.#text(parent, "p", "Select a node to configure its parameters and source identities.");
      return;
    }
    const definition = this.#definition(node.nodeTypeId);
    this.#text(parent, "strong", definition?.title ?? node.nodeTypeId);
    this.#text(parent, "p", definition?.description ?? "Load the registry to configure this node.");
    for (const warning of definition?.eligibilityWarnings ?? []) this.#text(parent, "p", warning);
    for (const parameter of definition?.parameterSchemas ?? []) {
      const label = this.#text(
        parent,
        "label",
        `${parameter.displayName ?? parameter.name}${parameter.required ? " *" : ""}`,
      );
      const allowed = parameter.schema?.enumValues ?? [];
      const field = allowed.length ? document.createElement("select") : document.createElement("input");
      if (field instanceof HTMLSelectElement) {
        for (const value of ["", ...allowed]) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value || "Choose a value";
          field.append(option);
        }
      } else {
        const type = parameter.schema?.type?.toLowerCase();
        field.type = ["wholenumber", "decimalnumber"].includes(type ?? "") ? "number" : "text";
        if (field.type === "number") field.step = type === "wholenumber" ? "1" : "any";
      }
      field.setAttribute("aria-label", `${parameter.displayName ?? parameter.name} · ${node.nodeId}`);
      field.value = node.parameters[parameter.name] ?? "";
      field.disabled = this.#busy || this.#advancedPending;
      field.required = parameter.required;
      field.addEventListener("input", () => {
        if (this.#advancedPending) return;
        const current = this.#graph.nodes.find((item) => item.nodeId === node.nodeId)!;
        const parameters = { ...current.parameters };
        if (field.value === "") delete parameters[parameter.name];
        else parameters[parameter.name] = field.value;
        this.#change(
          {
            ...this.#graph,
            nodes: this.#graph.nodes.map((item) => (item.nodeId === node.nodeId ? { ...current, parameters } : item)),
          },
          false,
        );
        const run = this.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="run"]');
        if (run) run.disabled = true;
      });
      field.addEventListener("change", () => this.render());
      label.append(field);
      this.#text(
        label,
        "small",
        [parameter.description, parameter.schema?.format, parameter.schema?.unit, parameter.schema?.crs]
          .filter(Boolean)
          .join(" · "),
      ).className = "hint";
      if (parameter.schema?.format === "layer-id") this.#renderSourcePicker(label, node.nodeId, parameter.name);
      for (const diagnostic of this.#diagnostics.filter(
        (item) => item.nodeId === node.nodeId && item.fieldPath?.includes(parameter.name),
      ))
        this.#text(label, "small", diagnostic.message).className = "diagnostics";
    }
    const known = new Set(definition?.parameterSchemas.map((item) => item.name));
    const unknown = Object.keys(node.parameters).filter((name) => !known.has(name));
    if (unknown.length)
      this.#text(parent, "p", `Additional parameters retained in advanced JSON: ${unknown.join(", ")}`);
    this.#button(
      parent,
      "Remove node",
      () => {
        this.#selected = undefined;
        this.#change({
          ...this.#graph,
          nodes: this.#graph.nodes.filter((item) => item.nodeId !== node.nodeId),
          edges: this.#graph.edges.filter(
            (edge) => edge.sourceNodeId !== node.nodeId && edge.targetNodeId !== node.nodeId,
          ),
        });
      },
      this.#advancedPending,
    );
  }
  #parseGraph(): ProcessGraph {
    const graph = JSON.parse(this.#graphText) as ProcessGraph;
    if (
      graph.schemaVersion !== "workflow-package.v1" ||
      !Array.isArray(graph.nodes) ||
      !Array.isArray(graph.edges) ||
      graph.nodes.some(
        (node) =>
          typeof node.nodeId !== "string" ||
          typeof node.nodeTypeId !== "string" ||
          !node.parameters ||
          typeof node.parameters !== "object" ||
          Array.isArray(node.parameters) ||
          Object.values(node.parameters).some((value) => typeof value !== "string"),
      ) ||
      graph.edges.some(
        (edge) =>
          !["Data", "Control"].includes(edge.kind) ||
          typeof edge.sourceNodeId !== "string" ||
          typeof edge.targetNodeId !== "string",
      )
    )
      throw new Error(
        "Expected a workflow-package.v1 graph with string parameter values and canonical node/port edges.",
      );
    return graph;
  }
  async #action(action: string): Promise<void> {
    const client = this.client;
    if (!client || this.#busy) return;
    const authority = this.#clientGeneration;
    const current = () => {
      if (client !== this.client || authority !== this.#clientGeneration)
        throw new Error("The Processes host authority changed.");
    };
    this.#busy = true;
    this.render();
    try {
      if (action === "registry") {
        const registry = await client.registry();
        current();
        this.#registry = registry;
        this.#diagnostics = validateProcessGraph(this.#graph, this.#registry);
        this.#message = `Registry ${this.#registry.registryVersion} loaded.`;
      }
      if (action === "prepare") {
        this.#attachmentGeneration++;
        const graph = this.#parseGraph();
        const text = this.#graphText;
        const prepared = await client.prepare("Processes", graph);
        current();
        if (this.#graphText === text) {
          this.#graph = graph;
          this.#prepared = prepared;
          this.#dirty = false;
          this.#advancedPending = false;
          this.#diagnostics = [];
        }
        this.#message = `Validated snapshot ${prepared.packageId} v${prepared.version}\n${prepared.contentHash}`;
      }
      if (action === "run" && this.#prepared && !this.#dirty) {
        const command = client.reserveCommand(this.#prepared.packageId, this.#prepared.version);
        const run = await client.run(
          this.#prepared.packageId,
          this.#prepared.version,
          command.commandId,
          command.reconcileOnly,
        );
        current();
        this.#run = run;
        this.#message = JSON.stringify(this.#run, null, 2);
      }
      if ((action === "status" || action === "cancel") && this.#run) {
        const result = await (action === "status" ? client.status(this.#run) : client.cancel(this.#run));
        current();
        this.#message = JSON.stringify(result, null, 2);
      }
    } catch (error) {
      if (client !== this.client || authority !== this.#clientGeneration) return;
      if (error instanceof ProcessValidationError) this.#diagnostics = error.diagnostics;
      this.#message = error instanceof Error ? error.message : String(error);
    } finally {
      this.#busy = false;
      this.render();
    }
  }
}
