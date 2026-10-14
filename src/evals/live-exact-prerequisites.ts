import { canonicalCompositionJson } from "../composition/model.js";
import { McpClient } from "../mcp/client.js";

const REQUIRED_SOURCES = ["hi-parcels", "hi-districts", "src-flood-risk", "src-dev-pressure"] as const;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid live source descriptor.");
  return value as Record<string, unknown>;
}

function fields(value: unknown): { name: string; type: string }[] {
  if (!Array.isArray(value)) throw new Error("Live source fields are unavailable.");
  const result = value.map((value) => {
    const entry = object(value);
    if (typeof entry.name !== "string" || typeof entry.type !== "string") throw new Error("Invalid live source field.");
    return { name: entry.name, type: entry.type };
  });
  if (new Set(result.map((field) => field.name)).size !== result.length)
    throw new Error("Duplicate live source fields.");
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** Binds configured aliases to real same-origin metadata before any model turn. */
export async function verifyLiveExactSources(
  sources: readonly unknown[] | undefined,
  baseUrl: string,
  fetchImpl: typeof fetch,
) {
  const origin = new URL(baseUrl).origin;
  const client = new McpClient({
    baseUrl,
    fetchImpl: (input, init) => fetchImpl(input, { ...init, redirect: "error", signal: AbortSignal.timeout(8000) }),
  });
  const descriptors = (sources ?? []).map(object);
  if (
    descriptors.length !== REQUIRED_SOURCES.length ||
    new Set(descriptors.map((entry) => entry.id)).size !== REQUIRED_SOURCES.length ||
    descriptors.some((entry) => !REQUIRED_SOURCES.some((required) => required === entry.id))
  )
    throw new Error("Exact live catalog requires only the four predeclared unique source aliases.");
  const identities = new Set<string>();
  const evidence: {
    sourceId: string;
    url: string;
    descriptor: Record<string, unknown>;
    metadata: Record<string, unknown>;
  }[] = [];
  for (const sourceId of REQUIRED_SOURCES) {
    const matching = descriptors.filter((entry) => entry.id === sourceId);
    if (matching.length !== 1) throw new Error(`Expected exactly one configured live source ${sourceId}.`);
    const source = matching[0];
    const locator = source.locator === undefined ? source : object(source.locator);
    if (
      typeof locator.serviceId !== "string" ||
      !locator.serviceId ||
      !Number.isSafeInteger(locator.layerId) ||
      Number(locator.layerId) < 0 ||
      typeof locator.url !== "string"
    )
      throw new Error(`Invalid locator for ${sourceId}.`);
    for (const key of ["serviceId", "layerId"])
      if (source.locator !== undefined && source[key] !== undefined && source[key] !== locator[key])
        throw new Error(`Conflicting live source identities for ${sourceId}.`);
    const url = new URL(locator.url, baseUrl);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash)
      throw new Error(`Live source ${sourceId} does not bind the owned locator.`);
    const result = await client.callTool("honua_describe_layer", {
      serviceId: locator.serviceId,
      layerId: locator.layerId,
    });
    const text = result.content?.find((block) => block.type === "text")?.text;
    const descriptor = object(result.structuredContent ?? (text ? JSON.parse(text) : undefined));
    if (
      typeof descriptor.serviceId !== "string" ||
      !descriptor.serviceId ||
      typeof descriptor.serviceName !== "string" ||
      !descriptor.serviceName ||
      descriptor.layerId !== locator.layerId ||
      descriptor.geometryType !== "Polygon" ||
      (source.geometryType !== undefined && source.geometryType !== descriptor.geometryType) ||
      (source.protocol !== undefined && source.protocol !== "geoservices-feature-service") ||
      (descriptor.serviceId !== locator.serviceId &&
        (source.locator !== undefined || descriptor.serviceName !== locator.serviceId))
    )
      throw new Error(`Live source ${sourceId} does not match its actual MCP identity.`);
    const serviceUrl = `${baseUrl.replace(/\/$/, "")}/rest/services/${descriptor.serviceName.split("/").map(encodeURIComponent).join("/")}/FeatureServer`;
    const layerUrl = `${serviceUrl}/${locator.layerId}`;
    for (const value of [locator.url, source.url].filter((value) => value !== undefined)) {
      if (typeof value !== "string") throw new Error(`Invalid URL for ${sourceId}.`);
      const declared = new URL(value, baseUrl);
      if (
        declared.username ||
        declared.password ||
        declared.search ||
        declared.hash ||
        ![serviceUrl, layerUrl].includes(declared.href.replace(/\/$/, ""))
      )
        throw new Error(`Live source ${sourceId} URL conflicts with its actual MCP locator.`);
    }
    if (identities.has(layerUrl)) throw new Error("Distinct corpus sources must not alias the same layer.");
    identities.add(layerUrl);
    const response = await fetchImpl(`${layerUrl}?f=json`, { redirect: "error", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Live source ${sourceId} metadata returned ${response.status}.`);
    const metadata = object(await response.json());
    const actualFields = fields(metadata.fields);
    if (
      metadata.id !== locator.layerId ||
      metadata.geometryType !== "esriGeometryPolygon" ||
      (source.fields !== undefined &&
        canonicalCompositionJson(actualFields) !== canonicalCompositionJson(fields(source.fields)))
    )
      throw new Error(`Live source ${sourceId} metadata does not match its configured descriptor.`);
    if (
      sourceId === "hi-parcels" &&
      (!["district", "zoning_code"].every((name) =>
        actualFields.some((field) => field.name === name && field.type === "esriFieldTypeString"),
      ) ||
        !actualFields.some(
          (field) =>
            field.name === "year_built" &&
            [
              "esriFieldTypeSmallInteger",
              "esriFieldTypeInteger",
              "esriFieldTypeSingle",
              "esriFieldTypeDouble",
              "esriFieldTypeBigInteger",
            ].includes(field.type),
        ))
    )
      throw new Error("The parcel source is missing required corpus fields.");
    evidence.push({ sourceId, url: layerUrl, descriptor, metadata });
  }
  return evidence;
}
