export const SCRIPTED_MCP_FIXTURE_ID = "live-mcp";
export const SCRIPTED_MCP_MODEL_LABEL = "scripted-no-model";

const noVectorSource = "Scripted MCP journey needs a published vector FeatureServer source.";

/** Service-local layer index supporting both `layerId` and `serviceLayerIndex` shapes. */
export function locatorLayerIndex(locator) {
  if (!locator || typeof locator !== "object") return undefined;
  const hasLayerId = Object.hasOwn(locator, "layerId") && locator.layerId !== undefined;
  const hasServiceLayerIndex = Object.hasOwn(locator, "serviceLayerIndex") && locator.serviceLayerIndex !== undefined;
  const layerId = hasLayerId
    ? Number.isSafeInteger(locator.layerId) && locator.layerId >= 0
      ? locator.layerId
      : Number.NaN
    : undefined;
  const serviceLayerIndex = hasServiceLayerIndex
    ? Number.isSafeInteger(locator.serviceLayerIndex) && locator.serviceLayerIndex >= 0
      ? locator.serviceLayerIndex
      : Number.NaN
    : undefined;
  if (Number.isNaN(layerId) || Number.isNaN(serviceLayerIndex)) return undefined;
  if (layerId !== undefined && serviceLayerIndex !== undefined && layerId !== serviceLayerIndex) return undefined;
  return layerId ?? serviceLayerIndex;
}

function isVectorFeatureSource(entry) {
  return (
    entry?.protocol === "geoservices-feature-service" &&
    /point|polygon|polyline|linestring/i.test(entry.geometryType ?? "") &&
    typeof entry.locator?.url === "string" &&
    entry.locator.url.length > 0 &&
    locatorLayerIndex(entry.locator) !== undefined
  );
}

/** Normalize the FeatureServer layer metadata URL regardless of trailing slash or suffixed index. */
export function metadataUrlForSource(source, baseUrl) {
  const layerIndex = locatorLayerIndex(source?.locator);
  if (typeof source?.locator?.url !== "string" || layerIndex === undefined) {
    throw new Error(noVectorSource);
  }
  const base = source.locator.url.replace(/\/+$/, "");
  const layerSuffix = `/${layerIndex}`;
  const path = base.endsWith(layerSuffix) ? base : `${base}${layerSuffix}`;
  return new URL(`${path}?f=json`, baseUrl).href;
}

/** True only for local/loopback candidate servers where seeding a synthetic polygon layer is safe. */
export function isLoopbackCandidateUrl(baseUrl) {
  if (typeof baseUrl !== "string" || !baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

export function selectMcpFixtureSource(catalog) {
  const source = catalog.find(isVectorFeatureSource);
  if (!source) throw new Error(noVectorSource);
  return source;
}

/** The catalog can list sources whose layer is not served (unpublished or stale); use the first one that resolves. */
export async function resolveMcpFixture(catalog, fetchMetadata) {
  const candidates = catalog.filter(isVectorFeatureSource);
  if (candidates.length === 0) throw new Error(noVectorSource);
  let lastError;
  for (const source of candidates) {
    try {
      return { source, fixture: liveMcpFixture(source, await fetchMetadata(source)) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function selectGroupByField(fields) {
  if (!Array.isArray(fields)) return undefined;
  const nonGeometry = fields.filter(
    (entry) => typeof entry?.name === "string" && entry.name.length > 0 && !/geometry/i.test(entry.type ?? ""),
  );
  return nonGeometry.find((entry) => !/oid$/i.test(entry.type ?? "")) ?? nonGeometry[0];
}

export function liveMcpFixture(source, metadata) {
  const layerIndex = locatorLayerIndex(source?.locator);
  const field = selectGroupByField(metadata?.fields);
  if (!metadata || metadata.error || layerIndex === undefined || metadata.id !== layerIndex || !field) {
    throw new Error("Scripted MCP journey needs matching live layer metadata and a group-by field.");
  }
  const datasetId = source.id;
  const shared = { datasetId, sourceId: source.id };
  return {
    fixtureId: SCRIPTED_MCP_FIXTURE_ID,
    modelLabel: SCRIPTED_MCP_MODEL_LABEL,
    datasetId,
    chartId: `chart-${datasetId}-${field.name}`,
    groupByField: field.name,
    turns: [
      { prompt: `Add the published ${source.title} layer.`, toolName: "add_layer", args: shared },
      {
        prompt: `Add a count chart grouped by ${field.name}.`,
        toolName: "add_chart",
        args: { ...shared, groupBy: field.name, chartType: "bar" },
      },
    ],
  };
}

/** Only assistant events are scripted; commands and draft storage still use the deployed MCP server. */
export async function installLiveMcpFixture(page, turns) {
  await page.evaluate(
    ({ scriptedTurns, fixtureId, modelLabel }) => {
      const turns = scriptedTurns.map((turn, index) => {
        const toolCallId = `live-fixture-${index + 1}`;
        return {
          user: { text: turn.prompt },
          assistant: {
            events: [
              { type: "messageStart", model: modelLabel },
              { type: "toolCallStart", toolCallId, toolName: turn.toolName },
              { type: "toolCallDelta", toolCallId, toolArgumentsDelta: JSON.stringify(turn.args) },
              { type: "toolCallStop", toolCallId, toolArguments: turn.args },
              { type: "messageStop", stopReason: "toolCall", promptTokens: 0, completionTokens: 0, latencyMs: 0 },
            ],
          },
        };
      });
      window.__honuaStudioSetChatFixture({ id: fixtureId, title: "Live MCP compose", turns });
    },
    { scriptedTurns: turns, fixtureId: SCRIPTED_MCP_FIXTURE_ID, modelLabel: SCRIPTED_MCP_MODEL_LABEL },
  );
}
