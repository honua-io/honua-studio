/** Authenticated discovery over the server's MCP layer catalog and Studio content items. */
import { StudioLifecycleClient } from "../lifecycle/lifecycle-client.js";
import { StudioLifecycleSessionExpiredError } from "../lifecycle/lifecycle-errors.js";
import type { StudioContentItemState } from "../lifecycle/lifecycle-types.js";
import { McpClient } from "../mcp/client.js";
import { McpTransportError } from "../mcp/errors.js";

export interface CatalogDataset {
  id: string;
  title: string;
  protocol: string;
  geometryType: string;
  locator?: Readonly<Record<string, unknown>>;
}

export interface StudioPackageSummary {
  id: string;
  family: string;
  state: StudioContentItemState;
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

async function fetchWithAuth(
  url: string,
  auth: TokenSource | undefined,
  forceRefresh: boolean,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (auth) {
    const token = await auth.getAccessToken({ forceRefresh });
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    }
  }
  return fetch(url, { ...init, headers });
}

async function authenticatedFetch(url: string, auth?: TokenSource, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetchWithAuth(url, auth, false, init);
  } catch (error) {
    throw new StudioClientError(`Could not reach the Studio server at ${url}.`, error);
  }
  if (response.status === 401 && auth) {
    // Single refresh-then-retry — never a second attempt after this one.
    try {
      response = await fetchWithAuth(url, auth, true, init);
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
  return response;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 100;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new StudioClientError("Invalid catalog response.");
  return value as Record<string, unknown>;
}

/** Reads real server discovery APIs; missing capabilities remain visible errors. */
export class StudioClient {
  private readonly mcp: McpClient;
  private readonly lifecycle: StudioLifecycleClient;
  private readonly dataBaseUrl: string;

  constructor(
    private readonly baseUrl: string = "/api",
    private readonly auth?: TokenSource,
    mcpBaseUrl = baseUrl.replace(/\/api\/?$/, ""),
  ) {
    this.dataBaseUrl = mcpBaseUrl.replace(/\/$/, "");
    this.mcp = new McpClient({
      baseUrl: this.dataBaseUrl,
      fetchImpl: (url, init) => authenticatedFetch(String(url), this.auth, init),
    });
    this.lifecycle = new StudioLifecycleClient({ baseUrl, auth });
  }

  async health(): Promise<HealthStatus> {
    return (await authenticatedFetch(`${this.baseUrl}/health`)).json() as Promise<HealthStatus>;
  }

  async listCatalog(): Promise<CatalogDataset[]> {
    const datasets: CatalogDataset[] = [];
    const ids = new Set<string>();
    let offset = 0;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await this.mcp.callTool("honua_list_layers", { offset, limit: PAGE_SIZE });
        const text = result.content?.find((block) => block.type === "text")?.text;
        const body = object(result.structuredContent ?? (text ? JSON.parse(text) : undefined));
        if (
          !Array.isArray(body.layers) ||
          body.layers.length > PAGE_SIZE ||
          body.offset !== offset ||
          typeof body.hasMore !== "boolean" ||
          body.layerCount !== body.layers.length
        ) {
          throw new StudioClientError("Invalid layer catalog page.");
        }
        for (const value of body.layers) {
          const layer = object(value);
          if (
            typeof layer.serviceId !== "string" ||
            !layer.serviceId ||
            typeof layer.serviceName !== "string" ||
            !layer.serviceName ||
            !Number.isSafeInteger(layer.layerId) ||
            Number(layer.layerId) < 0 ||
            typeof layer.name !== "string" ||
            typeof layer.geometryType !== "string"
          ) {
            throw new StudioClientError("Invalid layer catalog identity.");
          }
          const id = `${encodeURIComponent(layer.serviceId)}/${layer.layerId}`;
          if (ids.has(id)) throw new StudioClientError("Layer catalog repeated an identity across pages.");
          ids.add(id);
          datasets.push({
            id,
            title: layer.name,
            protocol: "geoservices-feature-service",
            geometryType: layer.geometryType,
            locator: {
              url: `${this.dataBaseUrl}/rest/services/${layer.serviceName.split("/").map(encodeURIComponent).join("/")}/FeatureServer`,
              layerId: layer.layerId,
              serviceId: layer.serviceId,
            },
          });
        }
        if (!body.hasMore) return datasets;
        if (
          !Number.isSafeInteger(body.nextOffset) ||
          Number(body.nextOffset) <= offset ||
          body.nextOffset !== offset + body.layers.length
        ) {
          throw new StudioClientError("Layer catalog pagination did not advance.");
        }
        offset = Number(body.nextOffset);
      }
      throw new StudioClientError("Layer catalog exceeded the bounded page limit.");
    } catch (error) {
      if (error instanceof StudioClientError) throw error;
      if (error instanceof McpTransportError && error.cause instanceof StudioClientError) throw error.cause;
      throw new StudioClientError(
        `Could not load the layer catalog: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }

  async listPackages(): Promise<StudioPackageSummary[]> {
    const packages: StudioPackageSummary[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = await this.lifecycle.listContentItems({ limit: PAGE_SIZE, cursor });
        if (
          !Array.isArray(body.items) ||
          body.items.length > PAGE_SIZE ||
          (body.nextCursor !== null && body.nextCursor !== undefined && typeof body.nextCursor !== "string")
        ) {
          throw new StudioClientError("Invalid content item page.");
        }
        for (const item of body.items) {
          if (
            typeof item.itemId !== "string" ||
            typeof item.packageKey !== "string" ||
            typeof item.family !== "string" ||
            typeof item.updatedAt !== "string" ||
            !["draft", "current", "published"].includes(item.state)
          ) {
            throw new StudioClientError("Invalid content item identity or state.");
          }
          packages.push({
            id: item.itemId,
            family: item.family,
            state: item.state,
            title: item.packageKey,
            updatedAt: item.updatedAt,
          });
        }
        if (!body.nextCursor) return packages;
        if (cursors.has(body.nextCursor)) throw new StudioClientError("Content item pagination repeated a cursor.");
        cursors.add(body.nextCursor);
        cursor = body.nextCursor;
      }
      throw new StudioClientError("Content items exceeded the bounded page limit.");
    } catch (error) {
      if (error instanceof StudioLifecycleSessionExpiredError)
        throw new StudioSessionExpiredError(`${this.baseUrl}/v1/studio/content-items`);
      if (error instanceof StudioClientError) throw error;
      throw new StudioClientError(
        `Could not load Studio content items: ${error instanceof Error ? error.message : String(error)}`,
        error,
      );
    }
  }
}
