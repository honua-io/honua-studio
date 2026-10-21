import { canonicalCompositionJson } from "../composition/model.js";
import {
  type CompositionSourceDescriptor,
  findCompositionSourceDescriptor,
  layerTypeForGeometry,
} from "../map/source-resolution.js";
import {
  type AuthoritativeStyleDefinition,
  type BoundAuthoritativeStyle,
  bindAuthoritativeStyleDefinition,
  parseStyleLayers,
  styleContentHash,
} from "./authoritative-style-provider.js";
import type { CompositionStyleLayerBinding } from "./map-style-edit.js";

export interface AudienceStyleTransport {
  readonly fetchRequest: typeof fetch;
}

export interface AudienceStyleProviderOptions {
  /** A trusted same-origin GET root, such as the Console audience style BFF. */
  readonly styleBaseUrl: string;
  readonly documentUrl: string;
  readonly catalog: readonly CompositionSourceDescriptor[];
  /** The host enforces current-reader partitioning. This provider never asks for a bearer. */
  readonly getTransport: () => AudienceStyleTransport | undefined;
  readonly signal?: AbortSignal;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The current-reader style or layer metadata is invalid.");
  return value as Record<string, unknown>;
}

function encodeId(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Same exact strong revision token as the canonical Server StyleVersionTag. Zero is a real revision. */
export function audienceStyleRevision(etag: string | null): number {
  const match = /^"style-v(0|[1-9][0-9]*)"$/.exec(etag ?? "");
  const revision = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(revision) || revision > 2147483647)
    throw new Error("The current stylesheet has no verifiable canonical revision.");
  return revision;
}

async function boundedText(response: Response, maximumBytes: number, signal: AbortSignal): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("The current-reader style response exceeds its size limit.");
  }
  if (!response.body) throw new Error("The current-reader style response is empty.");
  const reader = response.body.getReader();
  let bytes = new Uint8Array(0);
  let total = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      const nextTotal = total + value.byteLength;
      if (nextTotal > maximumBytes) throw new Error("The current-reader style response exceeds its size limit.");
      if (nextTotal > bytes.byteLength) {
        let capacity = Math.max(bytes.byteLength, 1024);
        while (capacity < nextTotal) capacity = Math.min(capacity * 2, maximumBytes);
        const expanded = new Uint8Array(capacity);
        expanded.set(bytes.subarray(0, total));
        bytes = expanded;
      }
      bytes.set(value, total);
      total = nextTotal;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  signal.throwIfAborted();
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total));
}

/** Read-only audience counterpart to the authoring provider. No MCP, mutation, token lookup or global fetch. */
export class AudienceStyleProvider {
  readonly serverRoot: string;
  readonly #catalog: readonly CompositionSourceDescriptor[];

  constructor(private readonly options: AudienceStyleProviderOptions) {
    const root = new URL(options.styleBaseUrl, options.documentUrl);
    if (
      !/^https?:$/.test(root.protocol) ||
      root.origin !== new URL(options.documentUrl).origin ||
      root.username ||
      root.password ||
      root.search ||
      root.hash
    )
      throw new Error("The audience style reader requires a trusted same-origin root.");
    this.serverRoot = root.href.replace(/\/$/, "");
    this.#catalog = structuredClone(options.catalog);
    if (this.#catalog.length > 1000 || new Set(this.#catalog.map((source) => source.id)).size !== this.#catalog.length)
      throw new Error("The current-reader source catalog is invalid.");
  }

  get sessionIdentity(): AudienceStyleTransport | undefined {
    return this.options.getTransport();
  }

  #assertSession(session: AudienceStyleTransport): void {
    if (session !== this.options.getTransport()) throw new Error("The viewer authority changed during style readback.");
  }

  async #get(
    url: string,
    accept: string,
    maximumBytes: number,
    session: AudienceStyleTransport,
  ): Promise<{ readonly response: Response; readonly text: string }> {
    this.#assertSession(session);
    if (!session.fetchRequest) throw new Error("Current-reader style transport is unavailable.");
    const signal = this.options.signal
      ? AbortSignal.any([this.options.signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000);
    signal.throwIfAborted();
    const response = await session.fetchRequest(url, {
      method: "GET",
      headers: { Accept: accept },
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal,
    });
    this.#assertSession(session);
    if (!response.ok || response.redirected)
      throw new Error(`The current-reader style or source is unavailable (${response.status}).`);
    const text = await boundedText(response, maximumBytes, signal);
    this.#assertSession(session);
    return { response, text };
  }

  async read(styleId: string): Promise<AuthoritativeStyleDefinition> {
    if (!styleId || styleId.length > 256 || styleId === "." || styleId === ".." || /[\\/%\p{Cc}]/u.test(styleId))
      throw new Error("The published style identifier is invalid.");
    const session = this.options.getTransport();
    if (!session?.fetchRequest) throw new Error("Current-reader style transport is unavailable.");
    const { response, text } = await this.#get(
      `${this.serverRoot}/${encodeId(styleId)}`,
      "application/vnd.mapbox.style+json",
      256 * 1024,
      session,
    );
    const styleVersion = audienceStyleRevision(response.headers.get("etag"));
    const layers = parseStyleLayers(text);
    const document = record(JSON.parse(text));
    const metadata = document.metadata === undefined ? {} : record(document.metadata);
    const sha256 = await styleContentHash(text);
    this.#assertSession(session);
    return {
      styleId,
      title: typeof document.name === "string" ? document.name : styleId,
      description: typeof metadata["honua:description"] === "string" ? metadata["honua:description"] : "",
      styleVersion,
      sha256,
      inlineBody: text,
      layers,
      serverRoot: this.serverRoot,
      observedAt: new Date().toISOString(),
    };
  }

  async bind(
    styleId: string,
    source: CompositionSourceDescriptor,
    mapping?: {
      readonly primaryTargetId: string;
      readonly layerBindings: readonly CompositionStyleLayerBinding[];
    },
  ): Promise<BoundAuthoritativeStyle> {
    // An authored locator cannot replace the current reader's canonical or unique legacy descriptor.
    const discovered = findCompositionSourceDescriptor(source.id, this.#catalog);
    if (
      !discovered ||
      source.protocol !== "geoservices-feature-service" ||
      discovered.protocol !== source.protocol ||
      discovered.geometryType !== source.geometryType ||
      canonicalCompositionJson(discovered.locator) !== canonicalCompositionJson(source.locator)
    )
      throw new Error("The style source is not in the current-reader catalog.");
    const locator = record(source.locator);
    const layerId = locator.layerId;
    if (
      typeof locator.serviceId !== "string" ||
      !locator.serviceId ||
      !Number.isSafeInteger(layerId) ||
      Number(layerId) < 0 ||
      typeof locator.url !== "string"
    )
      throw new Error("The current-reader source identity is incomplete.");
    const target = new URL(locator.url, this.options.documentUrl);
    const suffix = target.pathname.match(/\/rest\/services\/(?:[^/]+\/)+FeatureServer(?:\/(\d+))?\/?$/);
    if (
      !/^https?:$/.test(target.protocol) ||
      target.origin !== new URL(this.serverRoot).origin ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      /%(?:2f|5c|25)/i.test(target.pathname) ||
      !suffix ||
      (suffix[1] !== undefined && Number(suffix[1]) !== layerId)
    )
      throw new Error("The style source has an unsupported current-reader metadata route.");
    const metadataUrl = target.href.replace(/\/$/, "") + (suffix[1] === undefined ? `/${layerId}` : "");
    const session = this.options.getTransport();
    if (!session?.fetchRequest) throw new Error("Current-reader style transport is unavailable.");
    const definition = await this.read(styleId);
    this.#assertSession(session);
    const { text } = await this.#get(metadataUrl, "application/json", 1024 * 1024, session);
    const descriptor = record(JSON.parse(text));
    const geometry = layerTypeForGeometry(
      typeof descriptor.geometryType === "string" ? descriptor.geometryType : undefined,
    );
    if (
      descriptor.id !== layerId ||
      !geometry ||
      geometry !== layerTypeForGeometry(source.geometryType) ||
      !Array.isArray(descriptor.fields) ||
      descriptor.fields.length > 1000
    )
      throw new Error("The actual source metadata does not match the published style source.");
    const fields = descriptor.fields.map((entry) => {
      const name = record(entry).name;
      if (typeof name !== "string" || !name || name.length > 256 || /\p{Cc}/u.test(name))
        throw new Error("The current-reader field metadata is invalid.");
      return name;
    });
    if (new Set(fields).size !== fields.length) throw new Error("The current-reader field metadata is ambiguous.");
    const binding = await bindAuthoritativeStyleDefinition(definition, source, descriptor, fields, mapping);
    this.#assertSession(session);
    return binding;
  }
}
