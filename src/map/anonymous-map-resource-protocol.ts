import type { HonuaStyleSpecification } from "@honua/sdk-js/style";
import type { AddProtocolAction, RequestParameters, ResourceType } from "maplibre-gl";
import type { SourceProtocolRegistry } from "./authenticated-source-protocol.js";

export interface AnonymousMapResourceOptions {
  readonly documentUrl: string;
  readonly style: HonuaStyleSpecification;
  readonly onError?: (error: Error) => void;
  readonly fetchImpl?: typeof fetch;
}

const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
let nextProtocol = 0;

function networkUrl(value: string, documentUrl: string): URL | undefined {
  try {
    const url = new URL(value, documentUrl);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : undefined;
  } catch {
    return undefined;
  }
}

/** The published style grants anonymous reads only to its declared resource origins and the host origin. */
function declaredOrigins(style: HonuaStyleSpecification, documentUrl: string): ReadonlySet<string> {
  const origins = new Set([new URL(documentUrl).origin]);
  const add = (value: unknown) => {
    if (typeof value === "string") {
      const url = networkUrl(value, documentUrl);
      if (url) origins.add(url.origin);
    }
  };
  for (const source of Object.values(style.sources)) {
    const resource = source as Readonly<Record<string, unknown>>;
    add(resource.url);
    if (Array.isArray(resource.tiles)) resource.tiles.forEach(add);
    if (Array.isArray(resource.urls)) resource.urls.forEach(add);
    if (typeof resource.data === "string") add(resource.data);
  }
  add(style.glyphs);
  if (Array.isArray(style.sprite)) for (const entry of style.sprite) add(entry.url);
  else add(style.sprite);
  return origins;
}

async function boundedBody(response: Response, signal: AbortSignal): Promise<ArrayBuffer> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESOURCE_BYTES) throw new Error("Map asset exceeds the size limit.");
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESOURCE_BYTES) throw new Error("Map asset exceeds the size limit.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

/** MapLibre custom protocol for published tile/style assets. It never reads the auth session. */
export function installAnonymousMapResourceProtocol(
  registry: SourceProtocolRegistry,
  options: AnonymousMapResourceOptions,
): { readonly transformRequest: (url: string, resourceType?: ResourceType) => RequestParameters; dispose(): void } {
  const scheme = `honua-public-${++nextProtocol}`;
  const prefix = `${scheme}://`;
  const origins = declaredOrigins(options.style, options.documentUrl);
  const pending = new Set<AbortController>();
  let disposed = false;
  const handler: AddProtocolAction = async (request, controller) => {
    try {
      if (disposed) throw new Error("Map asset transport is disposed.");
      controller.signal.throwIfAborted();
      if (!request.url.startsWith(prefix)) throw new Error("Invalid map asset protocol.");
      const url = networkUrl(decodeURIComponent(request.url.slice(prefix.length)), options.documentUrl);
      if (!url || !origins.has(url.origin)) throw new Error("Map asset origin is not declared by the style.");
      pending.add(controller);
      const response = await (options.fetchImpl ?? fetch)(url.href, {
        method: "GET",
        headers: {},
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (!response.ok || response.redirected) throw new Error(`Map asset request failed (${response.status}).`);
      const buffer = await boundedBody(response, controller.signal);
      if (disposed) throw new Error("Map asset transport is disposed.");
      const json =
        /(?:^|\/|\+)json(?:;|$)/i.test(response.headers.get("content-type") ?? "") || /\.json$/i.test(url.pathname);
      return { data: json ? JSON.parse(new TextDecoder().decode(buffer)) : buffer };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!controller.signal.aborted && !disposed) options.onError?.(failure);
      throw failure;
    } finally {
      pending.delete(controller);
    }
  };
  registry.addProtocol(scheme, handler);
  const transformRequest = (url: string): RequestParameters => {
    if (/^(?:data:|blob:)/i.test(url) || url.startsWith(prefix)) return { url };
    const target = networkUrl(url, options.documentUrl);
    // Unknown network origins still enter this handler and fail closed; they
    // never fall back to MapLibre's native fetch with ambient credentials.
    return { url: `${prefix}${encodeURIComponent(target?.href ?? url)}` };
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
