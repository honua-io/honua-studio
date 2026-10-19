import { createHonuaAdminClient } from "@honua/sdk-js/control-plane";

export interface ImportedProcessDataset {
  readonly tableName: string;
  readonly physicalTableName: string;
  readonly schema: string;
}
export interface ProcessImportReceipt {
  readonly status: "unknown" | "pending" | "completed" | "failed" | "cancelled" | "unsupported";
  readonly jobId?: string;
  readonly uploadId?: string;
  readonly dataset?: ImportedProcessDataset;
  readonly message?: string;
  readonly cancellationRequested?: boolean;
}
export interface ArtifactImportSource {
  readonly projectId: string;
  readonly snapshotDigest: string;
  readonly runId: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly tableName: string;
}
interface RetainedImport {
  readonly uploadId: string;
  readonly jobId?: string;
  readonly source: ArtifactImportSource;
}
export interface ImportAuthority {
  readonly key: string;
  readonly scope: string;
  readonly raw: string | null;
}

export function importedDataset(value: Record<string, unknown>): ImportedProcessDataset | undefined {
  const keys = ["tableName", "physicalTableName", "schema"] as const;
  if (
    keys.some(
      (key) =>
        typeof value[key] !== "string" ||
        !value[key] ||
        String(value[key]).length > 256 ||
        [...String(value[key])].some((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || (code >= 127 && code <= 159);
        }),
    )
  )
    return undefined;
  return {
    tableName: value.tableName as string,
    physicalTableName: value.physicalTableName as string,
    schema: value.schema as string,
  };
}

/** Durable job references contain no credentials; every observation uses the current host transport. */
export class ArtifactImportTracker {
  constructor(
    private readonly options: {
      readonly scope: () => string;
      readonly storage: Pick<Storage, "getItem" | "setItem">;
      readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
    },
  ) {}
  #key(): string {
    return `honua.processes.artifact-import:${this.options.scope()}`;
  }
  capture(): ImportAuthority {
    const scope = this.options.scope();
    const key = this.#key();
    return { scope, key, raw: this.options.storage.getItem(key) };
  }
  assertAuthority(authority: ImportAuthority): void {
    if (authority.scope !== this.options.scope() || authority.key !== this.#key())
      throw new Error("The import workspace changed during the request.");
    if (this.options.storage.getItem(authority.key) !== authority.raw)
      throw new Error("The saved import job changed during the request. Resume its current reference.");
  }
  #read(authority: ImportAuthority): RetainedImport | undefined {
    this.assertAuthority(authority);
    const raw = authority.raw;
    if (!raw) return undefined;
    if (raw.length > 8192) throw new Error("The saved import reference is invalid.");
    const retained = JSON.parse(raw) as RetainedImport;
    if (
      typeof retained.uploadId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(retained.uploadId) ||
      (retained.jobId !== undefined &&
        (typeof retained.jobId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(retained.jobId))) ||
      !retained.source ||
      typeof retained.source !== "object"
    )
      throw new Error("The saved import reference is invalid.");
    return retained;
  }
  #write(authority: ImportAuthority, record: RetainedImport): ImportAuthority {
    this.assertAuthority(authority);
    const raw = JSON.stringify(record);
    this.options.storage.setItem(authority.key, raw);
    return { ...authority, raw };
  }
  reserve(source: ArtifactImportSource, authority: ImportAuthority): ImportAuthority {
    return this.#write(authority, { uploadId: crypto.randomUUID(), source });
  }
  uploadId(authority: ImportAuthority): string {
    const record = this.#read(authority);
    if (!record) throw new Error("No retained upload intent.");
    return record.uploadId;
  }
  uncertainUpload(authority: ImportAuthority): ProcessImportReceipt {
    const record = this.#read(authority);
    if (!record || record.jobId) throw new Error("The saved upload intent changed.");
    return {
      status: "unknown",
      uploadId: record.uploadId,
      message:
        "Upload acceptance is unknown. Its saved upload reference has been retained; do not upload it again until the server confirms the original outcome.",
    };
  }
  completeSynchronous(authority: ImportAuthority): void {
    this.assertAuthority(authority);
    this.options.storage.setItem(authority.key, "");
  }
  #admin() {
    // The generated SDK owns route/method construction. Its logical origin is
    // intercepted here; all requests go through the existing authenticated BFF.
    return createHonuaAdminClient({
      baseUrl: "https://honua.invalid",
      fetchFn: async (input, init) => {
        const url = new URL(String(input));
        if (
          url.origin !== "https://honua.invalid" ||
          !url.pathname.startsWith("/api/v1/admin/") ||
          url.search ||
          url.hash
        )
          throw new Error("Invalid import operation route.");
        return this.options.fetch(url.pathname.slice("/api/v1/".length), init);
      },
    });
  }
  start(jobId: string, source: ArtifactImportSource, authority = this.capture()): ProcessImportReceipt {
    if (typeof jobId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId))
      throw new Error("Import returned no valid job identity.");
    const previous = this.#read(authority);
    this.#write(authority, { jobId, source, uploadId: previous?.uploadId ?? crypto.randomUUID() });
    return { status: "pending", jobId, message: "Import queued. Its saved job can be resumed after reopening." };
  }
  async reconcile(source: ArtifactImportSource, authority = this.capture()): Promise<ProcessImportReceipt | undefined> {
    const retained = this.#read(authority);
    if (!retained) return undefined;
    const observed = await this.#status(authority, retained);
    if (observed.status === "unknown") return observed;
    if (observed.status === "pending") {
      if (JSON.stringify(retained.source) !== JSON.stringify(source))
        throw new Error("Finish or cancel the pending import before importing another artifact.");
      return observed;
    }
    if (observed.status === "completed" && JSON.stringify(retained.source) === JSON.stringify(source)) return observed;
    return undefined;
  }
  async resume(signal?: AbortSignal): Promise<ProcessImportReceipt | undefined> {
    const authority = this.capture();
    const retained = this.#read(authority);
    return retained ? this.#status(authority, retained, signal) : undefined;
  }
  async #status(
    authority: ImportAuthority,
    retained: RetainedImport,
    signal?: AbortSignal,
  ): Promise<ProcessImportReceipt> {
    this.assertAuthority(authority);
    if (!retained.jobId) return this.uncertainUpload(authority);
    const result = await this.#admin().call("getImportJobStatus", { path: { jobId: retained.jobId }, signal });
    this.assertAuthority(authority);
    const response = result.data as Record<string, unknown>;
    const value = (response.data ?? response) as Record<string, unknown>;
    if (value.jobId !== retained.jobId) throw new Error("Import status returned a different job identity.");
    const jobId = retained.jobId;
    switch (value.status) {
      case "Queued":
      case "Processing":
        return { status: "pending", jobId, message: `Import ${String(value.status).toLowerCase()}.` };
      case "Completed": {
        const dataset = importedDataset(value);
        return {
          status: "completed",
          jobId,
          ...(dataset
            ? { dataset }
            : {
                message:
                  "Import completed, but no committed dataset identity was returned. Refresh its status before publishing.",
              }),
        };
      }
      case "Failed":
        return { status: "failed", jobId, message: "Import failed. Review the server job before retrying." };
      case "Cancelled":
        return { status: "cancelled", jobId, message: "Import cancelled." };
      default:
        throw new Error("Import status is not recognized; its saved job has been retained.");
    }
  }
  async cancel(): Promise<ProcessImportReceipt | undefined> {
    const authority = this.capture();
    const retained = this.#read(authority);
    if (!retained) return undefined;
    if (!retained.jobId) return this.#status(authority, retained);
    const result = await this.#admin().call("cancelImportJob", { path: { jobId: retained.jobId } });
    this.assertAuthority(authority);
    const response = result.data as unknown as Record<string, unknown>;
    const value = (response.data ?? response) as Record<string, unknown>;
    if (value.jobId !== retained.jobId) throw new Error("Import cancellation returned a different job identity.");
    const observed = await this.#status(authority, retained);
    return observed.status === "pending"
      ? {
          ...observed,
          cancellationRequested: true,
          message: "Import cancellation requested; waiting for its actual terminal status.",
        }
      : observed;
  }
}
