export function selectMcpFixtureSource(catalog) {
  const source = catalog.find(
    (entry) =>
      entry.protocol === "geoservices-feature-service" &&
      /point|polygon|polyline|linestring/i.test(entry.geometryType) &&
      typeof entry.locator?.url === "string" &&
      Number.isSafeInteger(entry.locator?.layerId) &&
      entry.locator.layerId >= 0,
  );
  if (!source) throw new Error("Scripted MCP journey needs a published vector FeatureServer source.");
  return source;
}

export function liveMcpFixture(source, metadata) {
  const field = metadata.fields?.find(
    (entry) => typeof entry.name === "string" && entry.name.length > 0 && !/geometry/i.test(entry.type ?? ""),
  );
  if (metadata.error || metadata.id !== source.locator.layerId || !field) {
    throw new Error("Scripted MCP journey needs matching live layer metadata and a group-by field.");
  }
  const datasetId = source.id;
  const shared = { datasetId, sourceId: source.id };
  return {
    datasetId,
    chartId: `chart-${datasetId}-${field.name}`,
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
  await page.evaluate((scriptedTurns) => {
    const turns = scriptedTurns.map((turn, index) => {
      const toolCallId = `live-fixture-${index + 1}`;
      return {
        user: { text: turn.prompt },
        assistant: {
          events: [
            { type: "messageStart", model: "scripted-no-model" },
            { type: "toolCallStart", toolCallId, toolName: turn.toolName },
            { type: "toolCallDelta", toolCallId, toolArgumentsDelta: JSON.stringify(turn.args) },
            { type: "toolCallStop", toolCallId, toolArguments: turn.args },
            { type: "messageStop", stopReason: "toolCall", promptTokens: 0, completionTokens: 0, latencyMs: 0 },
          ],
        },
      };
    });
    window.__honuaStudioSetChatFixture({ id: "live-mcp", title: "Live MCP compose", turns });
  }, turns);
}
