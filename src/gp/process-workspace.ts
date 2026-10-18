/** Processes is an editor and adapter to the existing server workflow compiler, never an executor. */
export interface ProcessNode {
  readonly nodeId: string;
  readonly nodeTypeId: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly metadata?: Readonly<Record<string, string>>;
}
export interface ProcessEdge {
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly kind: "Data" | "Control";
  readonly sourcePort?: string;
  readonly targetPort?: string;
}
export interface ProcessGraph {
  readonly schemaVersion: "workflow-package.v1";
  readonly nodes: readonly ProcessNode[];
  readonly edges: readonly ProcessEdge[];
}
export interface ProcessSchema {
  readonly type?: string;
  readonly format?: string;
  readonly unit?: string;
  readonly crs?: string;
  readonly enumValues?: readonly string[];
}
export interface ProcessPort {
  readonly name: string;
  readonly title?: string;
  readonly required?: boolean;
  readonly schema?: ProcessSchema;
}
export interface ProcessNodeDefinition {
  readonly nodeTypeId: string;
  readonly providerId: string;
  readonly title: string;
  readonly description?: string;
  readonly category?: string;
  readonly parameterSchemas: readonly {
    readonly name: string;
    readonly displayName?: string;
    readonly description?: string;
    readonly required: boolean;
    readonly defaultValue?: string | null;
    readonly schema?: ProcessSchema;
  }[];
  readonly inputSchemas?: readonly ProcessPort[];
  readonly outputSchemas?: readonly ProcessPort[];
  readonly eligibilityWarnings?: readonly string[];
}
export interface ProcessRegistry {
  readonly registryVersion: string;
  readonly nodes: readonly ProcessNodeDefinition[];
  readonly warnings?: readonly string[];
}
export interface ProcessDiagnostic {
  readonly nodeId?: string;
  readonly fieldPath?: string;
  readonly code: string;
  readonly message: string;
}
export interface ProcessRun {
  readonly workflowRunId?: string;
  readonly jobId?: string;
  readonly publicationId: string;
  readonly packageId: string;
  readonly packageVersion: number;
}

/** Structural validation complements, and never replaces, server catalog/plan validation. */
export function validateProcessGraph(graph: ProcessGraph, registry: ProcessRegistry): ProcessDiagnostic[] {
  const diagnostics: ProcessDiagnostic[] = [];
  const ids = new Set<string>();
  const catalog = new Map(registry.nodes.map((node) => [node.nodeTypeId, node]));
  for (const node of graph.nodes) {
    if (!node.nodeId || ids.has(node.nodeId))
      diagnostics.push({ nodeId: node.nodeId, code: "NODE_ID", message: "Node IDs must be unique and nonempty." });
    ids.add(node.nodeId);
    const definition = catalog.get(node.nodeTypeId);
    if (
      definition?.providerId !== "geoprocessing.process-catalog" ||
      !node.nodeTypeId.startsWith("process:") ||
      node.nodeTypeId.startsWith("process:custom")
    )
      diagnostics.push({
        nodeId: node.nodeId,
        code: "BUILTIN_ONLY",
        message: "Choose a built-in process from the current server registry. Custom code uses a separate sandbox run.",
      });
  }
  for (const node of graph.nodes) {
    const definition = catalog.get(node.nodeTypeId);
    for (const parameter of definition?.parameterSchemas ?? []) {
      if (
        parameter.required &&
        !node.parameters[parameter.name]?.trim() &&
        !graph.edges.some(
          (edge) => edge.kind === "Data" && edge.targetNodeId === node.nodeId && edge.targetPort === parameter.name,
        )
      )
        diagnostics.push({
          nodeId: node.nodeId,
          fieldPath: `parameters.${parameter.name}`,
          code: "REQUIRED_PARAMETER",
          message: `Supply ${parameter.displayName ?? parameter.name} or connect its input.`,
        });
    }
  }
  const connectedInputs = new Set<string>();
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!ids.has(edge.sourceNodeId) || !ids.has(edge.targetNodeId))
      diagnostics.push({
        nodeId: edge.targetNodeId,
        code: "EDGE_NODE",
        message: "Every edge must reference existing node IDs.",
      });
    if (edge.kind === "Data" && !edge.targetPort)
      diagnostics.push({
        nodeId: edge.targetNodeId,
        code: "EDGE_INPUT",
        message: "A data edge needs a target input key.",
      });
    if (edge.kind === "Data") {
      const source = graph.nodes.find((node) => node.nodeId === edge.sourceNodeId);
      const target = graph.nodes.find((node) => node.nodeId === edge.targetNodeId);
      const output = source && catalog.get(source.nodeTypeId)?.outputSchemas;
      const input = target && catalog.get(target.nodeTypeId)?.inputSchemas;
      const sourcePort = output?.find((port) => port.name === edge.sourcePort);
      const targetPort = input?.find((port) => port.name === edge.targetPort);
      if (output && !sourcePort)
        diagnostics.push({
          nodeId: edge.sourceNodeId,
          fieldPath: `outputs.${edge.sourcePort ?? ""}`,
          code: "OUTPUT_PORT",
          message: "Choose an output port from the current registry.",
        });
      if (input && !targetPort)
        diagnostics.push({
          nodeId: edge.targetNodeId,
          fieldPath: `inputs.${edge.targetPort ?? ""}`,
          code: "INPUT_PORT",
          message: "Choose an input port from the current registry.",
        });
      const key = JSON.stringify([edge.targetNodeId, edge.targetPort]);
      if (connectedInputs.has(key))
        diagnostics.push({
          nodeId: edge.targetNodeId,
          fieldPath: `inputs.${edge.targetPort}`,
          code: "INPUT_CONNECTED",
          message: "An input may have only one data connection.",
        });
      connectedInputs.add(key);
    }
    incoming.set(edge.targetNodeId, [...(incoming.get(edge.targetNodeId) ?? []), edge.sourceNodeId]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): boolean {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const source of incoming.get(id) ?? []) if (!visit(source)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  }
  for (const id of ids)
    if (!visit(id)) {
      diagnostics.push({ nodeId: id, code: "CYCLE", message: "Process graphs must be acyclic." });
      break;
    }
  if (!graph.nodes.length) diagnostics.push({ code: "EMPTY", message: "Add a built-in process node." });
  return diagnostics;
}

/** Immutable graph copies preserve source/node identity across edits, validation and reruns. */
export function snapshotProcessGraph(graph: ProcessGraph): ProcessGraph {
  const snapshot = structuredClone(graph);
  for (const node of snapshot.nodes) {
    Object.freeze(node.parameters);
    Object.freeze(node.metadata);
    Object.freeze(node);
  }
  for (const edge of snapshot.edges) Object.freeze(edge);
  Object.freeze(snapshot.nodes);
  Object.freeze(snapshot.edges);
  return Object.freeze(snapshot);
}

/** Matches actual server paths against exact graph node identities. */
export function normalizeProcessDiagnostics(
  diagnostics: readonly ProcessDiagnostic[],
  graph: ProcessGraph,
): ProcessDiagnostic[] {
  const ids = graph.nodes.map((node) => node.nodeId).sort((a, b) => b.length - a.length);
  return diagnostics.map((diagnostic) => {
    const nodeId = ids.find(
      (id) =>
        diagnostic.nodeId === id ||
        ["graph.nodes", "steps"].some((root) => {
          const prefix = `${root}[${id}]`;
          return diagnostic.fieldPath === prefix || diagnostic.fieldPath?.startsWith(`${prefix}.`);
        }),
    );
    return { ...diagnostic, nodeId };
  });
}

export class ProcessValidationError extends Error {
  constructor(readonly diagnostics: readonly ProcessDiagnostic[]) {
    super(diagnostics.map((item) => `${item.nodeId ?? "graph"}: ${item.message}`).join("\n"));
  }
}

export class ProcessServerError extends Error {
  constructor(readonly status: number) {
    super(`Processes server returned ${status}.`);
  }
}

export class ServerProcessWorkspace {
  readonly #attempted = new Set<string>();
  constructor(
    private readonly options: {
      readonly environmentId: string;
      readonly csrfToken: string;
      readonly fetchImpl?: typeof fetch;
      readonly commandStorage?: Pick<Storage, "getItem" | "setItem">;
    },
  ) {}

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers = new Headers({ accept: "application/json", "X-Honua-Environment": this.options.environmentId });
    if (method !== "GET") {
      headers.set("X-CSRF-Token", this.options.csrfToken);
      headers.set("content-type", "application/json");
    }
    const response = await (this.options.fetchImpl ?? fetch)(`/api/processes/${path}`, {
      method,
      headers,
      credentials: "same-origin",
      redirect: "error",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new ProcessServerError(response.status);
    const envelope = (await response.json()) as { success?: boolean; data?: T };
    if (envelope.success === false) throw new Error("Processes server refused the request.");
    return (envelope.data ?? envelope) as T;
  }
  registry(): Promise<ProcessRegistry> {
    return this.#request("GET", "console/workflow-node-registry");
  }

  /** Save, freeze and validate through the existing server compiler. Run is a separate explicit action. */
  async prepare(
    name: string,
    graph: ProcessGraph,
  ): Promise<{ packageId: string; version: number; contentHash: string; validation: unknown; graph: ProcessGraph }> {
    const snapshot = snapshotProcessGraph(graph);
    const diagnostics = validateProcessGraph(snapshot, await this.registry());
    if (diagnostics.length) throw new ProcessValidationError(diagnostics);
    const saved = await this.#request<{ packageId: string }>("POST", "console/workflow-packages", {
      name,
      graph: snapshot,
    });
    const version = await this.#request<{ version: number; packageId: string; packageHash: string }>(
      "POST",
      `console/workflow-packages/${encodeURIComponent(saved.packageId)}/versions`,
    );
    const validation = await this.#request<{ isValid: boolean; failures?: readonly ProcessDiagnostic[] }>(
      "POST",
      `console/workflow-packages/${encodeURIComponent(saved.packageId)}/versions/${version.version}/validate`,
    );
    if (!validation.isValid)
      throw new ProcessValidationError(
        normalizeProcessDiagnostics(
          validation.failures ?? [{ code: "VALIDATION", message: "Server validation refused this graph." }],
          snapshot,
        ),
      );
    if (version.packageId !== saved.packageId || !/^[a-f0-9]{64}$/.test(version.packageHash))
      throw new Error("Server returned no verified immutable package hash.");
    return {
      packageId: saved.packageId,
      version: version.version,
      contentHash: version.packageHash,
      validation,
      graph: snapshot,
    };
  }
  async readVersion(
    packageId: string,
    version: number,
    contentHash: string,
  ): Promise<{ packageId: string; version: number; contentHash: string; graph: ProcessGraph; validation: unknown }> {
    const observed = await this.#request<{
      packageId: string;
      version: number;
      packageHash: string;
      graph: ProcessGraph;
      validation: unknown;
    }>("GET", `console/workflow-packages/${encodeURIComponent(packageId)}/versions/${version}`);
    if (
      observed.packageId !== packageId ||
      observed.version !== version ||
      observed.packageHash !== contentHash ||
      !/^[a-f0-9]{64}$/.test(contentHash)
    )
      throw new Error("The immutable workflow package reference does not match.");
    return {
      packageId,
      version,
      contentHash,
      graph: snapshotProcessGraph(observed.graph),
      validation: observed.validation,
    };
  }

  /** Persist a command reference before submission; ambiguous acceptance must reuse it. */
  reserveCommand(packageId: string, version: number): { commandId: string; reconcileOnly: boolean } {
    const storage = this.options.commandStorage ?? globalThis.localStorage;
    if (!storage) throw new Error("Durable command storage is required before submitting a run.");
    const key = `honua.processes.command:${this.options.environmentId}:${packageId}:${version}`;
    const retained = storage.getItem(key);
    const prior = retained && !retained.startsWith("accepted:") ? retained : null;
    const commandId = prior ?? crypto.randomUUID();
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(commandId)) throw new Error("Invalid retained process command.");
    storage.setItem(key, commandId);
    return { commandId, reconcileOnly: prior !== null };
  }

  async run(packageId: string, version: number, commandId: string, reconcileOnly = false): Promise<ProcessRun> {
    if (!Number.isSafeInteger(version) || version < 1 || !commandId)
      throw new Error("Run requires an immutable version and command ID.");
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(commandId)) throw new Error("Use a bounded command identity.");
    const publicationId = `wfp-${commandId}`;
    const wasAttempted = reconcileOnly || this.#attempted.has(commandId);
    if (wasAttempted) {
      const existing = await this.#request<{
        items: readonly { publicationId: string; packageId: string; packageVersion: number; target: string }[];
      }>("GET", "console/workflow-publications");
      const publication = existing.items.find((item) => item.publicationId === publicationId);
      if (
        !publication ||
        publication.packageId !== packageId ||
        publication.packageVersion !== version ||
        publication.target !== "Job"
      )
        throw new Error("Command acceptance is unknown or belongs to another package. No new run was submitted.");
    }
    try {
      await this.#request(
        "POST",
        `console/workflow-packages/${encodeURIComponent(packageId)}/versions/${version}/publish`,
        { target: "Job", publicationId },
      );
    } catch (error) {
      if (!(error instanceof ProcessServerError) || error.status !== 409) throw error;
      const publications = await this.#request<{
        items: readonly { publicationId: string; packageId: string; packageVersion: number; target: string }[];
      }>("GET", "console/workflow-publications");
      const observed = publications.items.find((item) => item.publicationId === publicationId);
      if (
        !observed ||
        observed.packageId !== packageId ||
        observed.packageVersion !== version ||
        observed.target !== "Job"
      )
        throw new Error("The command publication identity is bound to another immutable package.");
    }
    // Record the attempt BEFORE sending. A missing reply is reconciled, never blindly rerun.
    this.#attempted.add(commandId);
    const run = await this.#request<ProcessRun>(
      "POST",
      `console/workflow-publications/${encodeURIComponent(publicationId)}/runs`,
      {
        idempotencyKey: commandId,
        reconcileOnly: wasAttempted,
      },
    );
    if (
      run.publicationId !== publicationId ||
      run.packageId !== packageId ||
      run.packageVersion !== version ||
      !(run.workflowRunId || run.jobId)
    )
      throw new Error("Server returned no matching operation receipt.");
    const storage = this.options.commandStorage ?? globalThis.localStorage;
    const key = `honua.processes.command:${this.options.environmentId}:${packageId}:${version}`;
    // Preserve the accepted receipt before permitting an intentional subsequent run.
    if (storage?.getItem(key) === commandId) storage.setItem(key, `accepted:${JSON.stringify({ commandId, run })}`);
    return run;
  }

  status(run: ProcessRun): Promise<unknown> {
    const id = run.workflowRunId ?? run.jobId;
    if (!id) throw new Error("Server returned no operation identity.");
    return this.#request("GET", `admin/operations/${encodeURIComponent(id)}`);
  }
  cancel(run: ProcessRun): Promise<unknown> {
    const id = run.workflowRunId ?? run.jobId;
    if (!id) throw new Error("Server returned no operation identity.");
    return this.#request("POST", `admin/operations/${encodeURIComponent(id)}/cancel`);
  }
}
