import type { AddProtocolAction, RequestTransformFunction } from "maplibre-gl";
import type { AuthSession } from "../auth/types.js";

export interface SourceProtocolRegistry {
  addProtocol(name: string, handler: AddProtocolAction): void;
  removeProtocol(name: string): void;
}

export interface AuthenticatedSourceOptions {
  readonly sourceBaseUrl: string;
  /** Older host catalogs resolve feature routes beneath this API root verbatim. */
  readonly legacySourceBaseUrl?: string;
  readonly documentUrl: string;
  readonly getAuth: () => Pick<AuthSession, "getAccessToken" | "fetchRequest"> | undefined;
  readonly onError?: (error: Error) => void;
  readonly fetchImpl?: typeof fetch;
}

let nextProtocol = 0;

/** Credentials belong only to bounded Honua feature endpoints under the configured deployment root. */
export function trustedSourceUrl(
  url: string,
  sourceBaseUrl: string,
  documentUrl: string,
  legacySourceBaseUrl?: string,
): URL | undefined {
  try {
    const target = new URL(url, documentUrl);
    if (!/^https?:$/.test(target.protocol) || target.username || target.password) return;
    // Proxies may decode a path before the router does. Never forward credentials
    // through encoded separators or a percent escape that permits another decode.
    if (/%(?:2f|5c|25)/i.test(target.pathname)) return;
    const roots = [{ value: sourceBaseUrl || "/", stripApi: true }];
    if (legacySourceBaseUrl !== undefined) roots.push({ value: legacySourceBaseUrl, stripApi: false });
    for (const root of roots) {
      const base = new URL(root.value, documentUrl);
      if (!/^https?:$/.test(base.protocol) || target.origin !== base.origin) continue;
      const prefix = (root.stripApi ? base.pathname.replace(/\/api\/?$/, "") : base.pathname).replace(/\/$/, "");
      if (!target.pathname.startsWith(`${prefix}/`)) continue;
      const route = target.pathname.slice(prefix.length);
      if (
        /^\/rest\/services\/(?:[^/]+\/)+FeatureServer\/\d+\/query$/.test(route) ||
        /^\/ogc\/features\/collections\/[^/]+\/items$/.test(route)
      )
        return target;
    }
  } catch {
    // Malformed or non-network URLs are never credential destinations.
  }
  return undefined;
}

/** Shared credential boundary for the map and data widgets; signed URLs and durable state stay token-free. */
export async function fetchAuthenticatedFeatureCollection(
  url: string,
  options: AuthenticatedSourceOptions,
  signal: AbortSignal,
  label = "Map source",
): Promise<Record<string, unknown>> {
  const target = trustedSourceUrl(url, options.sourceBaseUrl, options.documentUrl, options.legacySourceBaseUrl);
  if (!target) throw new Error(`${label} is outside the trusted Honua feature endpoints.`);
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    const auth = options.getAuth();
    const token = await auth?.getAccessToken(attempt === 1 ? { forceRefresh: true } : undefined);
    signal.throwIfAborted();
    if (auth !== options.getAuth())
      throw new Error(`The Studio session changed during the ${label.toLowerCase()} request.`);
    const response = await (options.fetchImpl ?? auth?.fetchRequest ?? fetch)(target.href, {
      method: "GET",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    if (response.redirected) throw new Error(`${label} redirects are not allowed.`);
    const body: unknown = response.ok ? await response.json() : undefined;
    signal.throwIfAborted();
    if (auth !== options.getAuth())
      throw new Error(`The Studio session changed during the ${label.toLowerCase()} request.`);
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
    const error = record?.error as { code?: unknown } | undefined;
    if (response.status === 401 || error?.code === 499) {
      if (attempt === 0 && auth) continue;
      throw new Error(`The Studio session cannot authorize this ${label.toLowerCase()}.`);
    }
    if (!response.ok) throw new Error(`${label} request failed (${response.status}).`);
    if (record?.type !== "FeatureCollection" || !Array.isArray(record.features)) {
      throw new Error(`${label} did not return a GeoJSON FeatureCollection.`);
    }
    return record;
  }
  throw new Error(`${label} authorization failed.`);
}

/** Per-map async transport: credentials never enter a style, durable URL, or worker message. */
export function installAuthenticatedSourceProtocol(
  registry: SourceProtocolRegistry,
  options: AuthenticatedSourceOptions,
) {
  const scheme = `honua-session-${++nextProtocol}`;
  const prefix = `${scheme}://`;
  const pending = new Set<AbortController>();
  let disposed = false;
  const handler: AddProtocolAction = async (request, controller) => {
    try {
      if (disposed) throw new Error("Map source transport is disposed.");
      controller.signal.throwIfAborted();
      if (!request.url.startsWith(prefix)) throw new Error("Invalid map source protocol.");
      const target = trustedSourceUrl(
        decodeURIComponent(request.url.slice(prefix.length)),
        options.sourceBaseUrl,
        options.documentUrl,
        options.legacySourceBaseUrl,
      );
      if (!target) throw new Error("Map source is outside the trusted Honua feature endpoints.");
      pending.add(controller);
      const data = await fetchAuthenticatedFeatureCollection(target.href, options, controller.signal);
      if (disposed) throw new Error("Map source transport is disposed.");
      return { data };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!controller.signal.aborted && !disposed) options.onError?.(failure);
      throw failure;
    } finally {
      pending.delete(controller);
    }
  };
  registry.addProtocol(scheme, handler);
  const transformRequest: RequestTransformFunction = (url, resourceType) => {
    const trusted =
      resourceType === "Source" &&
      trustedSourceUrl(url, options.sourceBaseUrl, options.documentUrl, options.legacySourceBaseUrl);
    return { url: trusted ? `${prefix}${encodeURIComponent(trusted.href)}` : url };
  };
  return {
    transformRequest,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of pending) controller.abort();
      pending.clear();
      registry.removeProtocol(scheme);
    },
  };
}
