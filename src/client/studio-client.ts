/**
 * Studio server client (honua-studio#3 REQ-003).
 *
 * A deliberately thin fetch wrapper — Phase 0 only needs to prove the two
 * dev-mode wiring paths (fixture / live, see vite.config.ts and
 * scripts/dev-mock.mjs) work end to end. honua-sdk-js#780 will graduate
 * `@honua/sdk-js/studio` into a full typed lifecycle client; this module
 * takes its lifecycle-status vocabulary as a type-only import today so the
 * shapes here already agree with the SDK, without pulling in the SDK's
 * heavier runtime peers (maplibre-gl, cesium, …) that Phase 0 doesn't need.
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

async function getJson<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new StudioClientError(`Could not reach the Studio server at ${url}.`, error);
  }
  if (!response.ok) {
    throw new StudioClientError(`Studio server responded ${response.status} for ${url}.`);
  }
  return (await response.json()) as T;
}

/** Reads catalog/lifecycle data from a honua-server-shaped `/api` root — mock or live, see REQ-003. */
export class StudioClient {
  constructor(private readonly baseUrl: string = "/api") {}

  health(): Promise<HealthStatus> {
    return getJson<HealthStatus>(`${this.baseUrl}/health`);
  }

  async listCatalog(): Promise<CatalogDataset[]> {
    const body = await getJson<{ datasets: CatalogDataset[] }>(`${this.baseUrl}/v1/studio/catalog`);
    return body.datasets;
  }

  async listPackages(): Promise<StudioPackageSummary[]> {
    const body = await getJson<{ packages: StudioPackageSummary[] }>(`${this.baseUrl}/v1/studio/packages`);
    return body.packages;
  }
}
