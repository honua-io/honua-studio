/**
 * Wire types for the Studio `gp` package family's envelope body, plus the
 * async batch-execution job surface (honua-studio#10, REQ-001..005/NFR-001).
 *
 * ## The honesty note (spec `.specifica/studio-v0/spec.md` line 66, REQ-006)
 *
 * honua-server's GP support level is `"limited"` today
 * (`GET /v1/studio/package-families` — see `lifecycle-types.ts`'s
 * `StudioPackageFamilySupportLevel`): validation is **envelope-only**
 * (structural checks on the envelope itself, never the GP body's
 * operation graph/parameter types), and `preview-plan` for a job-backed
 * family is **planning-only** — it reports `requiresJob: true` and the
 * steps a real execution WOULD take, it does not itself run anything. This
 * module's job is to model the shapes those two facts are honest about, not
 * to pretend a deeper validation/preview exists. `src/gp/gp-model.ts`'s
 * `gpValidationCaveat()` is the one place that caveat's user-facing text
 * lives; `<honua-studio-gp-panel>` surfaces it verbatim rather than
 * paraphrasing it away.
 *
 * ## The async job surface (REQ-003)
 *
 * Modeled on `@honua/sdk-js`'s canonical async-operation vocabulary
 * (`examples/geoprocessing-job-runner`, `src/contract/jobs.ts`'s
 * `JobStatus`/`JobSnapshot`/`IJobRun` — OGC API Processes 1.0's
 * `accepted | running | successful | failed | dismissed` status set) rather
 * than inventing a new one: {@link GpJobStatus} is that same five-value
 * union, so a future swap to the real `@honua/sdk-js` job client (once
 * honua-server's GP job endpoints exist for real — see `job-client.ts`'s
 * module doc) is a shape-compatible drop-in, not a rewrite. `submit` ->
 * `status` (poll) -> terminal `result`/`error`, plus `cancel` — the same
 * three-verb surface `IJobRun` exposes as `poll()`/`results()`/`cancel()`.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// GP package envelope body (family "gp")
// ---------------------------------------------------------------------------

/** One data input the GP package consumes — a bound catalog dataset (or another package's output, for a chained analysis). */
export interface GpPackageInput {
  readonly id: string;
  readonly title?: string;
  /** Catalog dataset id, or another `gp` package's output id (`outputId@packageKey`) for a chained input. */
  readonly datasetRef: string;
  readonly geometryType?: string;
  readonly required?: boolean;
}

export type GpParameterType = "number" | "string" | "boolean" | "enum";

/** One user-tunable parameter (e.g. a buffer distance) — re-runnable with a new `value` without re-authoring the package (REQ-005). */
export interface GpPackageParameter {
  readonly id: string;
  readonly title?: string;
  readonly type: GpParameterType;
  readonly value: unknown;
  readonly unit?: string;
  readonly enumValues?: readonly string[];
}

/** One declared output the completed job registers as a new catalog dataset (REQ-004) — never a mutation of an input. */
export interface GpPackageOutput {
  readonly id: string;
  readonly title?: string;
  readonly datasetType?: string;
  readonly geometryType?: string;
}

/** One step of the operation graph (e.g. `buffer`, `intersect`) — ordering/dependency metadata only; this module never executes anything client-side. */
export interface GpPackageStep {
  readonly id: string;
  readonly operation: string;
  readonly dependsOn?: readonly string[];
}

/** The `gp`-family envelope body this app authors and hands to `honua_studio_create_draft`/`update_draft` as `body`. */
export interface GpPackageBody {
  readonly title: string;
  readonly description?: string;
  readonly inputs: readonly GpPackageInput[];
  readonly parameters: readonly GpPackageParameter[];
  readonly outputs: readonly GpPackageOutput[];
  readonly steps: readonly GpPackageStep[];
}

// ---------------------------------------------------------------------------
// Async batch execution job surface (REQ-003) — see the module doc.
// ---------------------------------------------------------------------------

/** OGC API Processes 1.0 status vocabulary — identical to `@honua/sdk-js`'s `JobStatus` (`src/contract/jobs.ts`). */
export type GpJobStatus = "accepted" | "running" | "successful" | "failed" | "dismissed";

export interface GpJobProgress {
  readonly percent?: number;
  readonly message?: string;
  readonly updatedAt?: string;
}

export interface GpJobError {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

/** One registered output — `datasetId` is the id the job's completion registered into the catalog (REQ-004), addressable by the existing composition `addLayer` path. */
export interface GpJobOutputRef {
  readonly outputId: string;
  readonly datasetId: string;
  readonly title?: string;
}

export interface GpJobResult {
  readonly outputs: readonly GpJobOutputRef[];
}

/** Snapshot of a submitted job's state — returned from every {@link import("./job-client.js").GpJobClient} method, matching `IJobRun`'s `poll()`/`cancel()` return shapes. */
export interface GpJobSnapshot {
  readonly jobId: string;
  readonly draftId: string;
  readonly status: GpJobStatus;
  readonly progress?: GpJobProgress;
  /** Present only for terminal `successful` snapshots. */
  readonly result?: GpJobResult;
  /** Present only for terminal `failed` snapshots — surfaced honestly in the UI, never paraphrased. */
  readonly error?: GpJobError;
  /**
   * Mock-server-only introspection field: the parameter overrides this
   * submission ran with (REQ-005's "re-executes with new parameters").
   * Not part of the OGC Processes status vocabulary proper — a real
   * honua-server job status response is not expected to echo this back;
   * present here purely so re-run tests can assert against it without a
   * second round trip.
   */
  readonly parameters?: Readonly<Record<string, unknown>>;
}

/** Input to {@link import("./job-client.js").GpJobClient.submit} — THE HUMAN GATE (REQ-006/REQ-009 discipline). */
export interface GpJobSubmitInput {
  readonly draftId: string;
  /** The confirmed preview-plan'd version, when submitting a saved version rather than the live draft (REQ-005 re-run path). */
  readonly versionId?: string;
  /** Parameter value overrides for this run — REQ-005's "re-runnable with new parameters"; omitted fields fall back to the package's authored values. */
  readonly parameters?: Readonly<Record<string, unknown>>;
  /** Test-only: forces this run to the deterministic failure path (`job-client.ts`'s `StudioGpJobClient` / `mock-server.mjs`'s fixture job store) so "failures surface diagnostics honestly" is exercisable without a flaky real failure. */
  readonly simulateFailure?: boolean;
}

/** `true` for every status {@link import("./job-client.js").GpJobClient.status} will never transition out of. */
export function isGpJobTerminal(status: GpJobStatus): boolean {
  return status === "successful" || status === "failed" || status === "dismissed";
}
