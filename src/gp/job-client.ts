/**
 * The async batch-execution job surface (honua-studio#10 REQ-003) — a
 * structural {@link GpJobClient} interface plus {@link StudioGpJobClient}, a
 * thin fetch wrapper against `mock-server.mjs`'s fixture job store, built
 * the same way `lifecycle/lifecycle-client.ts` is: no schema-validation
 * dependency, bearer-attached via the same `TokenSource` shape every other
 * client in this app uses, one `#request` helper decoding the same
 * `ApiResponse<T>` envelope the REST lifecycle API uses.
 *
 * ## The seam (read before wiring this to a real honua-server)
 *
 * The reason this is not an SDK client is upstream of the SDK:
 * honua-server does not yet expose a real GP batch-execution job endpoint —
 * REQ-003 asks for "the server's async job surface (OGC API
 * Processes-compatible)", and `gp-types.ts`'s module doc explains why this
 * module's status vocabulary is already shaped to match: it mirrors
 * `@honua/sdk-js`'s `IJobRun`/`JobStatus` contract
 * (`src/contract/jobs.ts`, exercised end to end by
 * `examples/geoprocessing-job-runner`) field-for-field. `mock-server.mjs`'s
 * `/v1/studio/gp-jobs` routes are this app's OWN fixture stand-in for that
 * not-yet-real server surface, deliberately kept structurally compatible
 * (`submit` -> `status` polling -> terminal `result`/`error`, plus `cancel`)
 * so swapping `StudioGpJobClient` for a real client — whether a future
 * honua-server REST endpoint or `@honua/sdk-js`'s own
 * `HonuaProcessRunner`/`GeospatialGrpcProcessClient` adapter — only ever
 * requires a new class satisfying {@link GpJobClient}, never a caller-side
 * rewrite (every call site in this app — `src/elements/studio-gp-panel-element.ts`
 * — programs against the interface, not this class).
 *
 * ## THE HUMAN GATE (spec REQ-009 discipline extended to GP execution)
 *
 * {@link GpJobClient.submit} is the ONLY method that starts billed,
 * server-side batch compute. Per the issue's build item 3 ("EXECUTION of a
 * GP job is a human action after a confirmed preview plan — the agent can
 * author and validate the package and propose execution, but the run button
 * is the human's"), `submit()` must ONLY ever be called from a
 * human-confirmed UI interaction — `studio-gp-panel-element.ts`'s
 * typed-confirmation dialog handler, itself wired to nothing but a `click`
 * listener on that element's own shadow-DOM button. No file under
 * `src/mcp/**`, `src/chat/**`, or `src/composition/**` — the entire
 * agent-reachable surface — may call `submit()` or import this module at
 * all. See `test/gp/human-gate.test.ts`, which asserts this both statically
 * (mirroring `test/lifecycle/human-gate.test.ts` exactly) and at runtime
 * (driving the agent's authoring path end to end against the real mock
 * server and observing the gp-jobs store stays empty).
 *
 * @module
 */
import type { GpJobSnapshot, GpJobSubmitInput } from "./gp-types.js";

/** The minimal token surface this client depends on — matches `lifecycle-client.ts`'s/`mcp/client.ts`'s `TokenSource`, satisfied by `AuthSession`. */
export interface TokenSource {
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string | undefined>;
}

/**
 * Structural async-job surface for GP batch execution. See the module doc's
 * "THE HUMAN GATE" section before adding a new call site for `submit`.
 */
export interface GpJobClient {
  /** THE HUMAN GATE — see the module doc. Starts batch execution. */
  submit(input: GpJobSubmitInput): Promise<GpJobSnapshot>;
  /** One status poll — caller-driven, never an internally-scheduled timer (NFR-001: deterministic, no timers). */
  status(jobId: string): Promise<GpJobSnapshot>;
  /** Idempotent. Returns the resulting snapshot — typically `dismissed`, but a job that already reached a terminal state returns that original terminal snapshot unchanged (mirrors `@honua/sdk-js`'s `IJobRun.cancel()` doc). */
  cancel(jobId: string): Promise<GpJobSnapshot>;
}

export type GpJobClientErrorCode = "not-found" | "validation" | "internal" | "session-expired" | "unknown";

export class GpJobClientError extends Error {
  public readonly code: GpJobClientErrorCode;
  public readonly status: number | undefined;

  public constructor(code: GpJobClientErrorCode, message: string, status?: number) {
    super(message);
    this.name = "GpJobClientError";
    this.code = code;
    this.status = status;
  }
}

export function isGpJobNotFound(error: unknown): error is GpJobClientError {
  return error instanceof GpJobClientError && error.code === "not-found";
}

export interface StudioGpJobClientOptions {
  /** Defaults to `"/api"` (matches every other client in this app) — requests go to `${baseUrl}/v1/studio/gp-jobs...`. */
  baseUrl?: string;
  auth?: TokenSource;
  /** Override for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

interface StudioApiResponse<T> {
  readonly success: true;
  readonly data: T;
  readonly timestamp: string;
}

interface StudioProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
}

function isProblemDetails(value: unknown): value is StudioProblemDetails {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).title === "string" &&
    typeof (value as Record<string, unknown>).status === "number"
  );
}

/** Fetch-wrapper implementation of {@link GpJobClient} against `mock-server.mjs`'s `/v1/studio/gp-jobs` fixture routes — see the module doc's "the seam" section. */
export class StudioGpJobClient implements GpJobClient {
  readonly #baseUrl: string;
  readonly #auth: TokenSource | undefined;
  readonly #fetchImpl: typeof fetch;

  public constructor(options: StudioGpJobClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? "/api").replace(/\/$/, "");
    this.#auth = options.auth;
    this.#fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  public submit(input: GpJobSubmitInput): Promise<GpJobSnapshot> {
    return this.#request("POST", "/gp-jobs", input);
  }

  public status(jobId: string): Promise<GpJobSnapshot> {
    return this.#request("GET", `/gp-jobs/${encodeURIComponent(jobId)}`);
  }

  public cancel(jobId: string): Promise<GpJobSnapshot> {
    return this.#request("POST", `/gp-jobs/${encodeURIComponent(jobId)}/cancel`);
  }

  async #fetchWithAuth(path: string, method: string, body: unknown, forceRefresh: boolean): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.#auth) {
      const token = await this.#auth.getAccessToken({ forceRefresh });
      if (token) headers.authorization = `Bearer ${token}`;
    }
    return this.#fetchImpl(`${this.#baseUrl}/v1/studio${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.#baseUrl}/v1/studio${path}`;
    let response: Response;
    try {
      response = await this.#fetchWithAuth(path, method, body, false);
    } catch {
      throw new GpJobClientError("unknown", `Could not reach the Studio GP job API at ${url}.`, undefined);
    }
    if (response.status === 401 && this.#auth) {
      try {
        response = await this.#fetchWithAuth(path, method, body, true);
      } catch {
        throw new GpJobClientError("unknown", `Could not reach the Studio GP job API at ${url}.`, undefined);
      }
    }
    if (response.status === 401) {
      throw new GpJobClientError("session-expired", `Your session has expired. Sign in again to reach ${url}.`, 401);
    }
    if (!response.ok) {
      throw await this.#buildError(response);
    }
    const text = await response.text();
    if (!text) return undefined as T;
    const envelope = JSON.parse(text) as StudioApiResponse<T> | { data?: T };
    return (envelope as StudioApiResponse<T>).data as T;
  }

  async #buildError(response: Response): Promise<GpJobClientError> {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    const problem = isProblemDetails(parsed) ? parsed : undefined;
    const message = problem?.detail ?? problem?.title ?? `Studio GP job API responded ${response.status}.`;
    const code: GpJobClientErrorCode =
      response.status === 404 ? "not-found" : response.status === 400 ? "validation" : "internal";
    return new GpJobClientError(code, message, response.status);
  }
}
