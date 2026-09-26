/**
 * Studio server client (honua-studio#3 REQ-003, honua-studio#4 REQ-001).
 *
 * A deliberately thin fetch wrapper over three endpoints that are **not**
 * the Studio package lifecycle API: `GET /health`,
 * `GET /v1/studio/catalog`, and `GET /v1/studio/packages`. That is why this
 * is not `@honua/sdk-js/studio`'s `HonuaStudioLifecycleClient` — that client
 * covers `/v1/studio/package-drafts` and `/v1/studio/content-items`, and has
 * no method for any of these three. The shell's boot path (catalog listing,
 * health probe, package summaries) predates and sits beside the lifecycle
 * API rather than inside it.
 *
 * The lifecycle-status vocabulary *is* the SDK's, as a type-only import, so
 * a package summary here and a package elsewhere agree on what `status`
 * means — without pulling the SDK's heavier runtime peers (maplibre-gl,
 * cesium, …) into the boot path.
 *
 * Every request carries the current session's bearer token (attached via
 * `getAccessToken`, decoupled from the concrete `AuthSession` type so this
 * module stays test-friendly). A 401 triggers exactly one
 * refresh-then-retry — never an unbounded loop — and a second 401 surfaces
 * as {@link StudioSessionExpiredError} rather than a generic fetch error, so
 * callers can distinguish "sign in again" from "the server is down".
 */
import type { HonuaStudioPackageStatus } from "@honua/sdk-js/studio";

export interface CatalogDataset {
  id: string;
  title: string;
  protocol: string;
  geometryType: string;
}

export interface StudioPackageSummary {
  id: string;
  family: string;
  format: string;
  status: HonuaStudioPackageStatus;
  title: string;
  updatedAt: string;
}

export interface HealthStatus {
  status: string;
  mode: string;
}

export class StudioClientError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "StudioClientError";
  }
}

/** Thrown when a request 401s even after a forced-refresh retry — the caller should prompt sign-in. */
export class StudioSessionExpiredError extends StudioClientError {
  constructor(url: string) {
    super(`Your session has expired. Sign in again to reach ${url}.`);
    this.name = "StudioSessionExpiredError";
  }
}

/** The minimal token surface `StudioClient` depends on — `AuthSession` satisfies this. */
export interface TokenSource {
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string | undefined>;
}

async function fetchWithAuth(url: string, auth: TokenSource | undefined, forceRefresh: boolean): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (auth) {
    const token = await auth.getAccessToken({ forceRefresh });
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
  }
  return fetch(url, { headers });
}

async function getJson<T>(url: string, auth?: TokenSource): Promise<T> {
  let response: Response;
  try {
    response = await fetchWithAuth(url, auth, false);
  } catch (error) {
    throw new StudioClientError(`Could not reach the Studio server at ${url}.`, error);
  }
  if (response.status === 401 && auth) {
    // Single refresh-then-retry — never a second attempt after this one.
    try {
      response = await fetchWithAuth(url, auth, true);
    } catch (error) {
      throw new StudioClientError(`Could not reach the Studio server at ${url}.`, error);
    }
  }
  if (response.status === 401) {
    throw new StudioSessionExpiredError(url);
  }
  if (!response.ok) {
    throw new StudioClientError(`Studio server responded ${response.status} for ${url}.`);
  }
  return (await response.json()) as T;
}

/** Reads catalog/lifecycle data from a honua-server-shaped `/api` root — mock or live, see REQ-003. */
export class StudioClient {
  constructor(
    private readonly baseUrl: string = "/api",
    private readonly auth?: TokenSource,
  ) {}

  health(): Promise<HealthStatus> {
    return getJson<HealthStatus>(`${this.baseUrl}/health`);
  }

  async listCatalog(): Promise<CatalogDataset[]> {
    const body = await getJson<{ datasets: CatalogDataset[] }>(`${this.baseUrl}/v1/studio/catalog`, this.auth);
    return body.datasets;
  }

  async listPackages(): Promise<StudioPackageSummary[]> {
    const body = await getJson<{ packages: StudioPackageSummary[] }>(`${this.baseUrl}/v1/studio/packages`, this.auth);
    return body.packages;
  }
}
