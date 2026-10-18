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
export interface ProcessRegistry {
  readonly registryVersion: string;
  readonly nodes: readonly {
    readonly nodeTypeId: string;
    readonly providerId: string;
    readonly title: string;
    readonly parameterSchemas: readonly { readonly name: string; readonly required: boolean }[];
  }[];
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
  ): Promise<{ packageId: string; version: number; validation: unknown; graph: ProcessGraph }> {
    const snapshot = snapshotProcessGraph(graph);
    const diagnostics = validateProcessGraph(snapshot, await this.registry());
    if (diagnostics.length)
      throw new Error(diagnostics.map((item) => `${item.nodeId ?? "graph"}: ${item.message}`).join("\n"));
    const saved = await this.#request<{ packageId: string }>("POST", "console/workflow-packages", {
      name,
      graph: snapshot,
    });
    const version = await this.#request<{ version: number }>(
      "POST",
      `console/workflow-packages/${encodeURIComponent(saved.packageId)}/versions`,
    );
    const validation = await this.#request<{ isValid: boolean; failures?: readonly ProcessDiagnostic[] }>(
      "POST",
      `console/workflow-packages/${encodeURIComponent(saved.packageId)}/versions/${version.version}/validate`,
    );
    if (!validation.isValid) throw new Error(JSON.stringify(validation.failures ?? validation));
    return { packageId: saved.packageId, version: version.version, validation, graph: snapshot };
  }
  /** Persist a command reference before submission; ambiguous acceptance must reuse it. */
  reserveCommand(packageId: string, version: number): { commandId: string; reconcileOnly: boolean } {
    const storage = this.options.commandStorage ?? globalThis.localStorage;
    if (!storage) throw new Error("Durable command storage is required before submitting a run.");
    const key = `honua.processes.command:${this.options.environmentId}:${packageId}:${version}`;
    const prior = storage.getItem(key);
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
    return this.#request("POST", `console/workflow-publications/${encodeURIComponent(publicationId)}/runs`, {
      idempotencyKey: commandId,
      reconcileOnly: wasAttempted,
    });
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
