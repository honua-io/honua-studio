import { canonicalCompositionJson } from "../composition/model.js";

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
  const descriptors = (sources ?? []).map(object);
  const identities = new Set<string>();
  const evidence: { sourceId: string; url: string; metadata: Record<string, unknown> }[] = [];
  for (const sourceId of REQUIRED_SOURCES) {
    const matching = descriptors.filter((entry) => entry.id === sourceId);
    if (matching.length !== 1) throw new Error(`Expected exactly one configured live source ${sourceId}.`);
    const source = matching[0];
    if (
      typeof source.serviceId !== "string" ||
      !source.serviceId ||
      !Number.isSafeInteger(source.layerId) ||
      Number(source.layerId) < 0 ||
      typeof source.url !== "string"
    )
      throw new Error(`Invalid locator for ${sourceId}.`);
    const url = new URL(source.url);
    const path = `/rest/services/${encodeURIComponent(source.serviceId)}/FeatureServer/${source.layerId}`;
    if (url.origin !== origin || url.username || url.password || url.pathname !== path || url.search || url.hash)
      throw new Error(`Live source ${sourceId} does not bind the owned locator.`);
    if (identities.has(url.href)) throw new Error("Distinct corpus sources must not alias the same layer.");
    identities.add(url.href);
    const response = await fetchImpl(`${url.href}?f=json`, { redirect: "error", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Live source ${sourceId} metadata returned ${response.status}.`);
    const metadata = object(await response.json());
    const actualFields = fields(metadata.fields);
    if (
      metadata.id !== source.layerId ||
      metadata.geometryType !== "esriGeometryPolygon" ||
      canonicalCompositionJson(actualFields) !== canonicalCompositionJson(fields(source.fields))
    )
      throw new Error(`Live source ${sourceId} metadata does not match its configured descriptor.`);
    if (
      sourceId === "hi-parcels" &&
      !["district", "zoning_code", "year_built"].every((name) => actualFields.some((field) => field.name === name))
    )
      throw new Error("The parcel source is missing required corpus fields.");
    evidence.push({ sourceId, url: url.href, metadata });
  }
  return evidence;
}
