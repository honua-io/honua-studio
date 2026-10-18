export interface LocalSourceFile {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
}
export interface LocalProjectIdentity {
  readonly projectId: string;
  readonly revision: number;
  readonly sourceDigest: string;
  readonly image: string;
  readonly binding: {
    readonly ownerActorId: string;
    readonly tenantId: string | null;
    readonly environmentId: string;
    readonly workspaceId: string;
  } | null;
}
export interface LocalProject extends LocalProjectIdentity {
  readonly files: readonly LocalSourceFile[];
  readonly ideHandoff?: { readonly kind: string; readonly workspace: string };
}
export interface LocalSnapshot {
  readonly projectId: string;
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly image: string;
  readonly revision: number;
}
export interface LocalRunReceipt {
  readonly projectId: string;
  readonly snapshotId: string;
  readonly image: string;
  readonly runId: string;
  readonly status: "queued" | "running" | "unknown" | "succeeded" | "failed" | "cancelled" | "timed-out";
  readonly snapshotDigest: string;
  readonly diagnostics?: string;
  readonly cancellationRequested?: boolean;
  readonly artifacts?: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[];
}
class LocalProcessRequestError extends Error {
  constructor(readonly status: number) {
    super(
      status === 409
        ? "Project changed or a run is active; observe its actual state before retrying."
        : `Processes returned ${status}.`,
    );
  }
}
export interface ImportedProcessDataset {
  readonly tableName: string;
  readonly physicalTableName: string;
  readonly schema: string;
}
export interface PublishedProcessLayer {
  readonly layerId: number;
  readonly serviceName: string;
  readonly [key: string]: unknown;
}

/** Separate custom-code lane: filesystem edits + sandbox fixtures, followed by ordinary server import. */
export class LocalProcessWorkspace {
  #identity: LocalProjectIdentity | undefined;
  constructor(
    private readonly options: {
      readonly csrfToken: string;
      readonly principalId?: string;
      readonly environmentId: string;
      readonly workspaceId: () => string;
      readonly commandStorage?: Pick<Storage, "getItem" | "setItem">;
      readonly fetchImpl?: typeof fetch;
    },
  ) {}
  async #fetch(path: string, init?: RequestInit): Promise<Response> {
    const workspaceId = this.options.workspaceId();
    if (
      !workspaceId ||
      workspaceId !== workspaceId.trim() ||
      workspaceId.length > 256 ||
      [...workspaceId].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      throw new Error("An actual workspace is required.");
    const headers = new Headers(init?.headers);
    headers.set("X-Honua-Workspace", workspaceId);
    headers.set("X-Honua-Environment", this.options.environmentId);
    if (this.options.principalId) headers.set("X-Honua-Session-Partition", this.options.principalId);
    if ((init?.method ?? "GET") !== "GET") headers.set("X-CSRF-Token", this.options.csrfToken);
    const response = await (this.options.fetchImpl ?? fetch)(`/api/processes/${path}`, {
      ...init,
      headers,
      credentials: "same-origin",
      redirect: "error",
    });
    if (workspaceId !== this.options.workspaceId()) throw new Error("The workspace changed during the request.");
    if (!response.ok) throw new LocalProcessRequestError(response.status);
    return response;
  }
  async #json<T>(path: string, init?: RequestInit): Promise<T> {
    const value = (await (await this.#fetch(path, init)).json()) as { data?: T };
    return (value.data ?? value) as T;
  }
  #observe(identity: LocalProjectIdentity, accept = true): LocalProjectIdentity {
    if (
      !/^[a-f0-9]{32}$/.test(identity.projectId) ||
      !Number.isSafeInteger(identity.revision) ||
      identity.revision < 1 ||
      !/^[a-f0-9]{64}$/.test(identity.sourceDigest) ||
      !/^sha256:[a-f0-9]{64}$/.test(identity.image) ||
      (identity.binding && identity.binding.workspaceId !== this.options.workspaceId())
    )
      throw new Error("Invalid observed local project identity.");
    if (accept) this.#identity = identity.binding ? identity : undefined;
    return identity;
  }
  async identity(): Promise<LocalProjectIdentity> {
    return this.#observe(await this.#json("local/project/identity"), false);
  }
  async bind(): Promise<LocalProjectIdentity> {
    const observed = await this.identity();
    return this.#observe(
      await this.#json("local/project/bind", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: observed.projectId }),
      }),
    );
  }
  async project(): Promise<LocalProject> {
    const project = await this.#json<LocalProject>("local/project");
    this.#observe(project);
    if (!project.binding) throw new Error("Bind the configured project before reading source.");
    return project;
  }
  async save(
    file: LocalSourceFile,
    content: string,
    expectedProject?: Pick<LocalProjectIdentity, "projectId" | "revision" | "sourceDigest">,
  ): Promise<{ path: string; sha256: string; projectId: string; revision: number; sourceDigest: string }> {
    const identity = this.#identity;
    if (!identity) throw new Error("Load a bound local project before editing.");
    this.#expectedProject(identity, expectedProject);
    const saved = await this.#json<{
      path: string;
      sha256: string;
      projectId: string;
      revision: number;
      sourceDigest: string;
    }>(`local/sources/${file.path.split("/").map(encodeURIComponent).join("/")}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "If-Match": file.sha256 },
      body: JSON.stringify({ projectId: identity.projectId, expectedRevision: identity.revision, content }),
    });
    if (
      saved.projectId !== identity.projectId ||
      saved.path !== file.path ||
      !/^[a-f0-9]{64}$/.test(saved.sha256) ||
      saved.revision < identity.revision
    )
      throw new Error("Source save returned no matching revision receipt.");
    this.#observe({ ...identity, revision: saved.revision, sourceDigest: saved.sourceDigest });
    return saved;
  }
  async run(
    expectedProject?: Pick<LocalProjectIdentity, "projectId" | "revision" | "sourceDigest">,
  ): Promise<LocalRunReceipt> {
    const identity = this.#identity;
    if (!identity?.binding) throw new Error("Load a bound local project before capturing a snapshot.");
    this.#expectedProject(identity, expectedProject);
    const storage = this.options.commandStorage ?? globalThis.localStorage;
    if (!storage) throw new Error("Durable command storage is required before submitting a local run.");
    const key = `honua.local-process.command:${this.options.environmentId}:${this.options.workspaceId()}:${identity.binding.ownerActorId}:${identity.projectId}:${identity.sourceDigest}`;
    const retained = storage.getItem(key);
    let pending: { commandId: string; snapshot: LocalSnapshot };
    if (retained && !retained.startsWith("accepted:")) {
      pending = JSON.parse(retained) as typeof pending;
      if (!/^[a-zA-Z0-9-]{1,80}$/.test(pending.commandId)) throw new Error("Invalid retained local command identity.");
      try {
        const observed = await this.#json<LocalRunReceipt>(`local/commands/${encodeURIComponent(pending.commandId)}`);
        this.#verifyRun(observed, pending.snapshot);
        if (observed.status !== "unknown")
          storage.setItem(key, `accepted:${JSON.stringify({ ...pending, run: observed })}`);
        return observed;
      } catch (error) {
        if (!(error instanceof LocalProcessRequestError) || error.status !== 404) throw error;
      }
    } else {
      const snapshot = await this.#json<LocalSnapshot>("local/snapshots", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: identity.projectId,
          expectedRevision: identity.revision,
          sourceDigest: identity.sourceDigest,
        }),
      });
      if (
        snapshot.projectId !== identity.projectId ||
        snapshot.revision !== identity.revision ||
        snapshot.snapshotDigest !== identity.sourceDigest ||
        snapshot.image !== identity.image ||
        !/^[a-f0-9]{32}$/.test(snapshot.snapshotId)
      )
        throw new Error("Server returned no matching immutable snapshot.");
      pending = { commandId: crypto.randomUUID(), snapshot };
      storage.setItem(key, JSON.stringify(pending));
    }
    if (
      pending.snapshot.projectId !== identity.projectId ||
      pending.snapshot.snapshotDigest !== identity.sourceDigest ||
      pending.snapshot.image !== identity.image
    )
      throw new Error("The retained command belongs to different source or runtime bytes.");
    const receipt = await this.#json<LocalRunReceipt>("local/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: pending.snapshot.projectId,
        snapshotId: pending.snapshot.snapshotId,
        snapshotDigest: pending.snapshot.snapshotDigest,
        commandId: pending.commandId,
      }),
    });
    this.#verifyRun(receipt, pending.snapshot);
    if (receipt.status !== "unknown") storage.setItem(key, `accepted:${JSON.stringify({ ...pending, run: receipt })}`);
    return receipt;
  }
  #expectedProject(
    identity: LocalProjectIdentity,
    expected: Pick<LocalProjectIdentity, "projectId" | "revision" | "sourceDigest"> | undefined,
  ): void {
    if (
      expected &&
      (identity.projectId !== expected.projectId ||
        identity.revision !== expected.revision ||
        identity.sourceDigest !== expected.sourceDigest)
    )
      throw new Error("The observed project changed; reload it before editing or running.");
  }
  #verifyRun(receipt: LocalRunReceipt, snapshot: LocalSnapshot): void {
    if (
      receipt.projectId !== snapshot.projectId ||
      receipt.snapshotId !== snapshot.snapshotId ||
      receipt.snapshotDigest !== snapshot.snapshotDigest ||
      receipt.image !== snapshot.image ||
      !/^[a-f0-9]{32}$/.test(receipt.runId)
    )
      throw new Error("Server returned no matching local run receipt.");
  }
  status(runId: string): Promise<LocalRunReceipt> {
    return this.#json(`local/runs/${encodeURIComponent(runId)}`);
  }
  cancel(runId: string): Promise<LocalRunReceipt> {
    return this.#json(`local/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
  }

  /** File artifacts become datasets only after the normal import reports success. */
  async importArtifact(
    receipt: LocalRunReceipt,
    artifactPath: string,
    tableName: string,
  ): Promise<ImportedProcessDataset> {
    if (receipt.status !== "succeeded") throw new Error("Only successful run artifacts may be imported.");
    const artifact = receipt.artifacts?.find((item) => item.path === artifactPath);
    if (!artifact || !/\.(?:geojson|json|gpkg|fgb|parquet|csv)$/i.test(artifact.path))
      throw new Error("Select a supported geospatial artifact.");
    const content = await (
      await this.#fetch(
        `local/runs/${encodeURIComponent(receipt.runId)}/artifacts/${artifactPath.split("/").map(encodeURIComponent).join("/")}`,
      )
    ).arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", content)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (content.byteLength !== artifact.bytes || digest !== artifact.sha256)
      throw new Error("Artifact content no longer matches the immutable receipt.");
    const form = new FormData();
    form.set("File", new Blob([content]), artifactPath.split("/").at(-1)!);
    form.set("TableName", tableName);
    const imported = await this.#json<{
      success?: boolean;
      tableName?: string;
      physicalTableName?: string;
      schema?: string;
      jobId?: string;
    }>("admin/import/upload", { method: "POST", body: form });
    if (imported.jobId)
      throw new Error(`Import continues as job ${imported.jobId}. Observe that job before publishing the dataset.`);
    if (!imported.success || !imported.tableName || !imported.physicalTableName || !imported.schema)
      throw new Error("Import did not return a verified dataset identity.");
    return { tableName: imported.tableName, physicalTableName: imported.physicalTableName, schema: imported.schema };
  }
  /** Publishing uses the returned physical dataset identity; no layer is fabricated from a filename. */
  async publishDataset(
    dataset: ImportedProcessDataset,
    connectionId: string,
    serviceName: string,
    layerName: string,
  ): Promise<PublishedProcessLayer> {
    const layer = await this.#json<PublishedProcessLayer>(
      `admin/connections/${encodeURIComponent(connectionId)}/layers`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schema: dataset.schema,
          table: dataset.physicalTableName,
          layerName,
          serviceName,
          enabled: true,
        }),
      },
    );
    if (!Number.isInteger(layer.layerId) || !layer.serviceName)
      throw new Error("Publication is pending or did not return a verified layer identity.");
    return layer;
  }
}
