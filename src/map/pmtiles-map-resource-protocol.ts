import type { AddProtocolAction, RequestParameters } from "maplibre-gl";
import { PMTiles, Protocol, type Source } from "pmtiles";
import { readBoundedMapAssetBody } from "./anonymous-map-resource-protocol.js";
import type { SourceProtocolRegistry } from "./authenticated-source-protocol.js";

const MAX_RANGE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVES = 64;
let nextProtocol = 0;

export interface PmtilesMapResourceOptions {
  readonly fetchImpl?: typeof fetch;
  readonly onError?: (error: Error) => void;
  readonly deniedResourceUrls?: ReadonlySet<string>;
}

/** A PMTiles Source keeps upstream archive parsing while enforcing Studio's anonymous read boundary. */
export function createAnonymousPmtilesSource(
  url: string,
  lifetime: AbortSignal,
  options: PmtilesMapResourceOptions = {},
): Source {
  const parsed = new URL(url);
  if (
    !/^https?:$/.test(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    options.deniedResourceUrls?.has(parsed.href)
  )
    throw new Error("Invalid public PMTiles archive URL.");
  return {
    getKey: () => url,
    async getBytes(offset, length, passedSignal, etag) {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 1 ||
        length > MAX_RANGE_BYTES ||
        !Number.isSafeInteger(offset + length)
      )
        throw new Error("PMTiles range exceeds the size limit.");
      const signal = passedSignal ? AbortSignal.any([lifetime, passedSignal]) : lifetime;
      signal.throwIfAborted();
      const response = await (options.fetchImpl ?? fetch)(url, {
        method: "GET",
        headers: { Range: `bytes=${offset}-${offset + length - 1}` },
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal,
      });
      const range = response.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
      const start = Number(range?.[1]);
      const end = Number(range?.[2]);
      const total = Number(range?.[3]);
      if (
        response.status !== 206 ||
        response.redirected ||
        !range ||
        ![start, end, total].every(Number.isSafeInteger) ||
        start !== offset ||
        end < start ||
        end >= total ||
        end - start + 1 > length ||
        (end !== offset + length - 1 && end !== total - 1)
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("PMTiles server did not return the requested byte range.");
      }
      const responseEtag = response.headers.get("etag") ?? undefined;
      // Fail closed on a replaced archive; never combine directories and tile data from different versions.
      if (etag && responseEtag !== etag) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("PMTiles archive changed during the read.");
      }
      const data = await readBoundedMapAssetBody(response, signal, end - start + 1);
      if (data.byteLength !== end - start + 1) throw new Error("PMTiles range body is incomplete.");
      return {
        data,
        etag: responseEtag,
        cacheControl: response.headers.get("cache-control") ?? undefined,
        expires: response.headers.get("expires") ?? undefined,
      };
    },
  };
}

/** Per-map registration isolates caches and aborts all archive reads when the map is removed. */
export function installPmtilesMapResourceProtocol(
  registry: SourceProtocolRegistry,
  options: PmtilesMapResourceOptions = {},
) {
  const scheme = `honua-pmtiles-${++nextProtocol}`;
  const prefix = `${scheme}://`;
  const lifetime = new AbortController();
  const protocol = new Protocol({ metadata: true });
  let registered = false;
  const handler: AddProtocolAction = async (request, controller) => {
    try {
      lifetime.signal.throwIfAborted();
      controller.signal.throwIfAborted();
      if (!request.url.startsWith(prefix)) throw new Error("Invalid PMTiles protocol.");
      const canonical = `pmtiles://${request.url.slice(prefix.length)}`;
      // Match the upstream protocol's archive key (TileJSON includes a tile-type extension) before invoking it, so it can never create its default FetchSource.
      const match = canonical.match(/^pmtiles:\/\/(.+)\/(\d+)\/(\d+)\/(\d+)(?:\.(?:mvt|mlt|png|jpg|webp|avif))?$/);
      const archive = request.type === "json" ? canonical.slice(10) : match?.[1];
      if (!archive) throw new Error("Invalid PMTiles tile URL.");
      if (!protocol.get(archive)) {
        if (protocol.tiles.size >= MAX_ARCHIVES) throw new Error("Too many PMTiles archives in one map.");
        protocol.add(new PMTiles(createAnonymousPmtilesSource(archive, lifetime.signal, options)));
      }
      const result = await protocol.tilev4({ url: canonical, type: request.type }, controller);
      lifetime.signal.throwIfAborted();
      // Keep derived tile requests on this map's transport even if MapLibre bypasses transformRequest.
      if (request.type === "json") {
        const data = result.data as { tiles?: string[] };
        return { ...result, data: { ...data, tiles: data.tiles?.map((url) => url.replace(/^pmtiles:\/\//, prefix)) } };
      }
      if (!(result.data instanceof Uint8Array)) throw new Error("Invalid PMTiles tile data.");
      return { ...result, data: new Uint8Array(result.data).buffer };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!controller.signal.aborted && !lifetime.signal.aborted) options.onError?.(failure);
      throw failure;
    }
  };
  return {
    transformRequest(url: string): RequestParameters | undefined {
      if (!url.startsWith("pmtiles://") && !url.startsWith(prefix)) return undefined;
      if (lifetime.signal.aborted) throw new Error("PMTiles transport is disposed.");
      if (!registered) {
        registry.addProtocol(scheme, handler);
        registered = true;
      }
      return { url: url.startsWith(prefix) ? url : `${prefix}${url.slice(10)}` };
    },
    dispose() {
      lifetime.abort();
      protocol.tiles.clear();
      if (registered) registry.removeProtocol(scheme);
      registered = false;
    },
  };
}
