export interface LocalSourceFile {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
}
export interface LocalRunReceipt {
  readonly runId: string;
  readonly status: "queued" | "succeeded" | "failed" | "cancelled" | "timed-out";
  readonly snapshotDigest: string;
  readonly diagnostics?: string;
  readonly artifacts?: readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[];
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
  constructor(
    private readonly options: {
      readonly csrfToken: string;
      readonly environmentId: string;
      readonly fetchImpl?: typeof fetch;
    },
  ) {}
  async #fetch(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("X-Honua-Environment", this.options.environmentId);
    if ((init?.method ?? "GET") !== "GET") headers.set("X-CSRF-Token", this.options.csrfToken);
    const response = await (this.options.fetchImpl ?? fetch)(`/api/processes/${path}`, {
      ...init,
      headers,
      credentials: "same-origin",
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        response.status === 409 ? "Source changed; reload before saving." : `Processes returned ${response.status}.`,
      );
    return response;
  }
  async #json<T>(path: string, init?: RequestInit): Promise<T> {
    const value = (await (await this.#fetch(path, init)).json()) as { data?: T };
    return (value.data ?? value) as T;
  }
  project(): Promise<{
    files: readonly LocalSourceFile[];
    image: string;
    ideHandoff: { kind: string; workspace: string };
  }> {
    return this.#json("local/project");
  }
  save(file: LocalSourceFile, content: string): Promise<{ path: string; sha256: string }> {
    return this.#json(`local/sources/${file.path.split("/").map(encodeURIComponent).join("/")}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "If-Match": file.sha256 },
      body: JSON.stringify({ content }),
    });
  }
  run(): Promise<LocalRunReceipt> {
    return this.#json("local/runs", { method: "POST" });
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
