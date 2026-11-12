import { HonuaClient } from "@honua/sdk-js";
import { loadHonuaFeatureServiceGeoJson } from "@honua/sdk-js/map";
import { type AuthenticatedSourceOptions, trustedSourceUrl } from "./authenticated-source-protocol.js";
import { parseFeatureResponseBody, readBoundedFeatureBody } from "./bounded-feature-response.js";

/** Uses the SDK's canonical feature query/paging and geometry conversion. */
export async function loadPagedFeatureSource(
  target: URL,
  options: AuthenticatedSourceOptions,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!trustedSourceUrl(target.href, options.sourceBaseUrl, options.documentUrl, options.legacySourceBaseUrl))
    throw new Error("The paged source is outside the authorized deployment.");
  const match = target.pathname.match(/^(.*)(\/rest\/services\/(?:[^/]+\/)+FeatureServer\/\d+)\/query$/);
  if (!match) throw new Error("Expected an authorized FeatureServer query URL.");
  const root = target.origin + match[1];
  const layerPath = match[2]!;
  const authority = options.getAuth();
  let pages = 0;
  let incomplete = false;
  let metadataObserved = false;
  let rateLimited: number | false | undefined;
  const client = new HonuaClient({
    baseUrl: root,
    preferBinary: false,
    fetchFn: async (input, init) => {
      signal.throwIfAborted();
      if (authority !== options.getAuth()) throw new Error("The Studio source authority changed.");
      if (input instanceof Request) throw new Error("The SDK source adapter requires an explicit URL.");
      const url = new URL(String(input), root);
      if (
        url.origin !== target.origin ||
        ![`${match[1]}${layerPath}`, `${match[1]}${layerPath}/query`].includes(url.pathname) ||
        (init?.method ?? "GET").toUpperCase() !== "GET"
      )
        throw new Error("The SDK source adapter requested an unsupported route or method.");
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = await authority?.getAccessToken(attempt === 1 ? { forceRefresh: true } : undefined);
        signal.throwIfAborted();
        if (authority !== options.getAuth()) throw new Error("The Studio source authority changed.");
        const headers = new Headers(init?.headers);
        headers.delete("authorization");
        headers.delete("x-api-key");
        if (token) headers.set("Authorization", `Bearer ${token}`);
        const response = await (options.fetchImpl ?? authority?.fetchRequest ?? fetch)(url.href, {
          ...init,
          headers,
          signal,
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
        });
        if (response.redirected || authority !== options.getAuth()) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error("The Studio source authority changed or redirected.");
        }
        const bytes = await readBoundedFeatureBody(response, signal, () => authority === options.getAuth());
        const body = response.ok
          ? (parseFeatureResponseBody(bytes) as {
              error?: { code?: unknown; retryAfterSeconds?: unknown };
              exceededTransferLimit?: boolean;
              features?: unknown[];
            })
          : undefined;
        signal.throwIfAborted();
        if (authority !== options.getAuth()) throw new Error("The Studio source authority changed.");
        if (response.status === 401 || body?.error?.code === 499) {
          if (attempt === 0 && authority) continue;
          throw new Error("The Studio session cannot authorize this source query.");
        }
        if (response.status === 429 || body?.error?.code === 429) {
          const retryAfter = retryAfterSeconds(response, body?.error?.retryAfterSeconds);
          if (url.pathname.endsWith("/query") && pages > 0) {
            rateLimited = retryAfter;
            return new Response(JSON.stringify({ features: [] }), { status: 200 });
          }
          throw new Error(
            `The server is limiting requests for this source; try again${retryAfter ? ` in ${retryAfter} seconds` : " shortly"}.`,
          );
        }
        if (body?.error) throw new Error("The source server refused the SDK query.");
        if (body) {
          if (url.pathname.endsWith("/query")) {
            pages++;
            incomplete =
              body.exceededTransferLimit === true ||
              (body.exceededTransferLimit === undefined && body.features?.length === 2000);
          } else metadataObserved = true;
        }
        return new Response(bytes.byteLength ? bytes : null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      throw new Error("The Studio session cannot authorize this source query.");
    },
  });
  const source = await loadHonuaFeatureServiceGeoJson(client, `${root}${layerPath}`, {
    definitionExpression: target.searchParams.get("where") ?? "1=1",
    outFields: (target.searchParams.get("outFields") ?? "*").split(","),
    outSR: 4326,
    pageSize: 2000,
    maxPages: 32,
    signal,
  });
  signal.throwIfAborted();
  if (authority !== options.getAuth()) throw new Error("The Studio source authority changed.");
  if (!metadataObserved) throw new Error("Authorized source metadata could not be loaded.");
  if (rateLimited !== undefined)
    options.onIncomplete?.(
      `Showing the first ${source.data.features.length} features; the server is limiting requests, so the rest did not load${rateLimited ? ` (retry in ${rateLimited} seconds)` : ""}.`,
    );
  else if (pages >= 32 && incomplete)
    options.onIncomplete?.(
      `Showing ${source.data.features.length} features at the 32-page preview limit; additional features remain.`,
    );
  return source.data as unknown as Record<string, unknown>;
}

function retryAfterSeconds(response: Response, declared: unknown): number | false {
  const seconds = typeof declared === "number" ? declared : Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : false;
}
