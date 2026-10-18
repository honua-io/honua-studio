import type { HonuaStyleRefLayerOverride } from "@honua/sdk-js/runtime";
import { validateHonuaStyle } from "@honua/sdk-js/style";
import type { AuthSession } from "../auth/types.js";
import { canonicalCompositionJson } from "../composition/model.js";
import { type CompositionSourceDescriptor, layerTypeForGeometry } from "../map/source-resolution.js";
import { McpClient } from "../mcp/client.js";

export interface AuthoritativeStyleSummary {
  readonly styleId: string;
  readonly title: string;
}
export interface AuthoritativeStyleDefinition extends AuthoritativeStyleSummary {
  readonly description: string;
  readonly styleVersion: number;
  readonly sha256: string;
  readonly inlineBody: string;
  readonly serverRoot: string;
  readonly observedAt: string;
  readonly layers: readonly Readonly<Record<string, unknown>>[];
}
export interface BoundAuthoritativeStyle {
  readonly definition: AuthoritativeStyleDefinition;
  readonly sourceId: string;
  readonly descriptorSha256: string;
  readonly descriptorBody: string;
  readonly stylesheetLayerId: string;
  readonly fields: readonly string[];
  readonly override: HonuaStyleRefLayerOverride;
}
export interface AuthoritativeStyleProviderOptions {
  readonly baseUrl: string;
  readonly documentUrl: string;
  readonly getAuth: () => Pick<AuthSession, "getAccessToken" | "fetchRequest"> | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid authoritative style response.");
  return value as Record<string, unknown>;
}
export async function styleContentHash(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Legacy property-name filters cannot safely mix with expression-based controls. */
function rejectLegacyFilter(value: unknown): void {
  if (!Array.isArray(value)) return;
  const [operator, operand] = value;
  if (
    ["!has", "!in", "none"].includes(operator) ||
    (["==", "!=", ">", ">=", "<", "<=", "in"].includes(operator) && typeof operand === "string")
  )
    throw new Error("Legacy stylesheet filters are not supported; use explicit get/has expressions.");
  if (["all", "any", "!"].includes(operator)) for (const child of value.slice(1)) rejectLegacyFilter(child);
}

/** Initial subset: resource-free fill/line/circle overrides onto existing resolved sources. */
export function parseStyleLayers(inlineBody: string): readonly Readonly<Record<string, unknown>>[] {
  if (new TextEncoder().encode(inlineBody).length > 262144) throw new Error("Stylesheet exceeds the 256 KiB limit.");
  const style = record(JSON.parse(inlineBody));
  if (style.version !== 8 || !Array.isArray(style.layers) || style.layers.length === 0 || style.layers.length > 100)
    throw new Error("Expected a bounded MapLibre v8 stylesheet.");
  if (style.sprite !== undefined || style.glyphs !== undefined || style.imports !== undefined)
    throw new Error("External stylesheet assets are not supported.");
  for (const source of Object.values(record(style.sources ?? {}))) {
    const entry = record(source);
    // Inline GeoJSON is legitimate canonical style metadata, but is never imported into the map.
    if (entry.type !== "geojson" || typeof entry.data !== "object" || entry.data === null || entry.url || entry.tiles)
      throw new Error("Only inline GeoJSON stylesheet sources are supported.");
  }
  const errors = validateHonuaStyle(style);
  if (errors.length > 0) throw new Error(`Invalid canonical stylesheet: ${errors[0]?.message}`);
  const identities = new Set<string>();
  return style.layers.map((value) => {
    const layer = record(value);
    if (
      typeof layer.id !== "string" ||
      !layer.id ||
      identities.has(layer.id) ||
      !["fill", "line", "circle"].includes(String(layer.type))
    )
      throw new Error("Stylesheet layers must have unique ids and supported vector types.");
    identities.add(layer.id);
    const paint = record(layer.paint ?? {});
    const layout = record(layer.layout ?? {});
    if (Object.keys(paint).some((key) => key.endsWith("-pattern")) || layout["icon-image"] !== undefined)
      throw new Error("Stylesheet image resources are not supported.");
    rejectLegacyFilter(layer.filter);
    for (const value of [...Object.values(paint), ...Object.values(layout)])
      if (value !== null && typeof value === "object" && !Array.isArray(value))
        throw new Error("Legacy stylesheet property functions are not supported; use expressions.");
    return layer;
  });
}

/** No persistent or shared cache: each operation observes the current host session and server revision. */
export class AuthoritativeStyleProvider {
  readonly serverRoot: string;
  constructor(private readonly options: AuthoritativeStyleProviderOptions) {
    const root = new URL(options.baseUrl || "/", options.documentUrl);
    if (!/^https?:$/.test(root.protocol) || root.username || root.password || root.search || root.hash)
      throw new Error("Invalid trusted style server root.");
    this.serverRoot = root.href.replace(/\/$/, "");
  }

  get sessionIdentity() {
    return this.options.getAuth();
  }

  async #call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const auth = this.options.getAuth();
    const endpoint = `${this.serverRoot}/mcp`;
    const transport = this.options.fetchImpl ?? auth?.fetchRequest ?? fetch;
    const client = new McpClient({
      baseUrl: this.serverRoot,
      fetchImpl: async (input, init) => {
        if (String(input) !== endpoint) throw new Error("Untrusted style discovery endpoint.");
        for (let attempt = 0; attempt < 2; attempt++) {
          if (auth !== this.options.getAuth()) throw new Error("Studio session changed during style discovery.");
          const token = await auth?.getAccessToken({ forceRefresh: attempt === 1 });
          if (auth !== this.options.getAuth()) throw new Error("Studio session changed during style discovery.");
          const headers = new Headers(init?.headers);
          if (token) headers.set("Authorization", `Bearer ${token}`);
          const response = await transport(input, {
            ...init,
            headers,
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
            signal: this.options.signal ?? init?.signal ?? AbortSignal.timeout(30000),
          });
          if (response.redirected) throw new Error("Style discovery redirects are not allowed.");
          if (auth !== this.options.getAuth()) throw new Error("Studio session changed during style discovery.");
          if (response.status === 401 && auth && attempt === 0) continue;
          return response;
        }
        throw new Error("Style discovery authorization failed.");
      },
    });
    const result = await client.callTool(name, args);
    if (auth !== this.options.getAuth()) throw new Error("Studio session changed during style discovery.");
    const text = result.content?.find((entry) => entry.type === "text")?.text;
    return record(result.structuredContent ?? (text ? JSON.parse(text) : undefined));
  }

  async list(): Promise<readonly AuthoritativeStyleSummary[]> {
    const result = await this.#call("honua_get_style", {});
    if (!Array.isArray(result.styles) || result.styles.length > 1000) throw new Error("Invalid bounded style catalog.");
    const identities = new Set<string>();
    return result.styles.map((value) => {
      const style = record(value);
      if (typeof style.styleId !== "string" || !style.styleId || identities.has(style.styleId))
        throw new Error("Invalid or duplicate style catalog identity.");
      identities.add(style.styleId);
      return { styleId: style.styleId, title: typeof style.title === "string" ? style.title : style.styleId };
    });
  }

  async read(styleId: string): Promise<AuthoritativeStyleDefinition> {
    const auth = this.options.getAuth();
    const result = await this.#call("honua_get_style", { styleId, includeStylesheet: true, encoding: "mapbox-style" });
    // The server contract is an integer revision; legacy records may legitimately be zero.
    if (
      result.styleId !== styleId ||
      !Number.isSafeInteger(result.styleVersion) ||
      Number(result.styleVersion) < 0 ||
      !Array.isArray(result.encodings)
    )
      throw new Error("Style identity or revision is invalid.");
    const selected = result.encodings.map(record).filter((entry) => entry.encoding === "mapbox-style");
    if (selected.length !== 1 || typeof selected[0]?.inlineBody !== "string")
      throw new Error("Canonical inline stylesheet is unavailable.");
    const inlineBody = selected[0].inlineBody;
    const layers = parseStyleLayers(inlineBody);
    const document = record(JSON.parse(inlineBody));
    const metadata = record(document.metadata ?? {});
    const sha256 = await styleContentHash(inlineBody);
    if (auth !== this.options.getAuth()) throw new Error("Studio session changed during style readback.");
    return {
      styleId,
      title:
        typeof document.name === "string" ? document.name : typeof result.title === "string" ? result.title : styleId,
      description:
        typeof result.description === "string" && result.description.trim()
          ? result.description
          : typeof metadata["honua:description"] === "string"
            ? metadata["honua:description"]
            : "",
      styleVersion: Number(result.styleVersion),
      sha256,
      inlineBody,
      layers,
      serverRoot: this.serverRoot,
      observedAt: new Date().toISOString(),
    };
  }

  async bind(styleId: string, source: CompositionSourceDescriptor): Promise<BoundAuthoritativeStyle> {
    const auth = this.options.getAuth();
    const { serviceId, layerId } = source.locator ?? {};
    if (typeof serviceId !== "string" || !Number.isSafeInteger(layerId))
      throw new Error("An actual discovered layer identity is required for style binding.");
    const sourceUrl = new URL(String(source.locator?.url), this.options.documentUrl);
    const root = new URL(this.serverRoot);
    if (
      sourceUrl.origin !== root.origin ||
      !sourceUrl.pathname.startsWith(`${root.pathname.replace(/\/$/, "")}/rest/services/`) ||
      sourceUrl.username ||
      sourceUrl.password
    )
      throw new Error("Style binding source is outside the trusted server root.");
    const definition = await this.read(styleId);
    const descriptor = await this.#call("honua_describe_layer", { serviceId, layerId });
    if (auth !== this.options.getAuth()) throw new Error("Studio session changed during style binding.");
    if (descriptor.serviceId !== serviceId || descriptor.layerId !== layerId || !Array.isArray(descriptor.fields))
      throw new Error("Style source descriptor identity does not match.");
    if (
      descriptor.fields.length > 1000 ||
      descriptor.fieldCount !== descriptor.fields.length ||
      layerTypeForGeometry(String(descriptor.geometryType)) !== layerTypeForGeometry(source.geometryType)
    )
      throw new Error("Source descriptor geometry or bounded fields do not match.");
    if (typeof descriptor.serviceName !== "string") throw new Error("Source descriptor service name is missing.");
    const serviceUrl = `${this.serverRoot}/rest/services/${descriptor.serviceName.split("/").map(encodeURIComponent).join("/")}/FeatureServer`;
    if (
      sourceUrl.href.replace(/\/$/, "") !== serviceUrl &&
      sourceUrl.href.replace(/\/$/, "") !== `${serviceUrl}/${layerId}`
    )
      throw new Error("Source locator does not match the actual descriptor.");
    const fields = descriptor.fields.map((value) => {
      const field = record(value);
      if (typeof field.name !== "string" || !field.name) throw new Error("Invalid source descriptor field.");
      return field.name;
    });
    const compatible = definition.layers.filter((layer) => layer.type === layerTypeForGeometry(source.geometryType));
    if (compatible.length !== 1) throw new Error("Stylesheet must identify exactly one compatible vector layer.");
    const selected = compatible[0];
    if (!selected) throw new Error("Compatible stylesheet layer is missing.");
    for (const field of expressionFields(selected))
      if (!fields.includes(field)) throw new Error(`Stylesheet references missing field "${field}".`);
    const override: Record<string, unknown> = {};
    for (const key of ["paint", "layout", "filter", "minzoom", "maxzoom"] as const)
      if (selected[key] !== undefined) override[key] = selected[key];
    override.metadata = {
      "honua:styleId": definition.styleId,
      "honua:styleVersion": definition.styleVersion,
      "honua:styleSha256": definition.sha256,
      "honua:styleServer": definition.serverRoot,
    };
    const descriptorBody = canonicalCompositionJson(descriptor);
    const descriptorSha256 = await styleContentHash(descriptorBody);
    if (auth !== this.options.getAuth()) throw new Error("Studio session changed during style binding.");
    return {
      definition,
      sourceId: source.id,
      fields,
      descriptorSha256,
      descriptorBody,
      stylesheetLayerId: String(selected.id),
      override,
    };
  }
}

export function expressionFields(value: unknown): readonly string[] {
  const fields = new Set<string>();
  const walk = (entry: unknown) => {
    if (Array.isArray(entry)) {
      if ((entry[0] === "get" || entry[0] === "has") && typeof entry[1] === "string") fields.add(entry[1]);
      for (const child of entry) walk(child);
    } else if (entry && typeof entry === "object") for (const child of Object.values(entry)) walk(child);
  };
  walk(value);
  return [...fields].sort();
}
