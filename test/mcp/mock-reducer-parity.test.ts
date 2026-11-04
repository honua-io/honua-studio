/**
 * The mock server's `honua_studio_*` composition tools and the client reducer must reach the same
 * composition for the same command: each case seeds one draft body, applies a command through
 * `applyCompositionCommand` and, as the live orchestrator would send it, through the mock's `/mcp` tool.
 */
import { afterEach, describe, expect, it } from "vitest";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import type { CompositionCommand } from "../../src/composition/commands.js";
import { applyCompositionCommand } from "../../src/composition/reducer.js";
import { readCompositionBody } from "../../src/lifecycle/composition-draft-store.js";
import { McpClient } from "../../src/mcp/client.js";
import { StudioMcpToolClient, parseStudioDraftResult } from "../../src/mcp/studio-tools.js";
import { buildServerToolInvocation, resolveToolCall, toStudioCompositionBody } from "../../src/mcp/tool-bridge.js";

const binding = (sourceId: string) => ({
  sourceId,
  protocol: "geoservices-feature-service",
  locator: { url: `/rest/services/${sourceId}/FeatureServer/0`, serviceId: sourceId, layerId: 0 },
});

const ROADS_STYLE = { roads: { paint: { "line-color": "#334455" } } };

/** Two layers share `parcels`; `roads` owns its source, an inline style, an outline and a labelled style layer. */
const SEEDED_BODY = {
  sourceBindings: [binding("parcels"), binding("roads")],
  styleRefs: [{ styleId: "honua-inline:roads", body: ROADS_STYLE }],
  mapSpec: {
    version: 8,
    sources: { parcels: { type: "geojson", data: {} }, roads: { type: "geojson", data: {} } },
    layers: [
      { id: "parcels", type: "fill", source: "parcels" },
      { id: "parcel-labels", type: "symbol", source: "parcels" },
      { id: "roads", type: "line", source: "roads" },
      { id: "roads__outline", type: "line", source: "roads" },
      { id: "road-names", type: "symbol", source: "roads", metadata: { "honua:compositionLayerId": "roads" } },
    ],
    metadata: { "honua:compositionLayerIds": ["parcels", "parcel-labels", "roads"] },
  },
  layers: [
    { id: "parcels", sourceId: "parcels", visible: true },
    { id: "parcel-labels", sourceId: "parcels", visible: true },
    { id: "roads", sourceId: "roads", visible: true, styleRef: "honua-inline:roads" },
  ],
  view: { center: [-157.86, 21.3], zoom: 9 },
  widgets: [],
};

const CASES: readonly { readonly name: string; readonly command: CompositionCommand }[] = [
  {
    name: "removing a layer prunes its binding, inline style, map-style source, style layers and owner entry",
    command: { name: "removeLayer", target: { kind: "layer", id: "roads" } },
  },
  {
    name: "removing one of two layers on a source keeps that source bound and drawn",
    command: { name: "removeLayer", target: { kind: "layer", id: "parcels" } },
  },
  {
    name: "a partial view merges into the current view",
    command: { name: "setView", view: { zoom: 12 } },
  },
  {
    name: "a layer style body becomes that layer's inline style",
    command: {
      name: "setLayerStyleRef",
      target: { kind: "layer", id: "parcels" },
      styleBody: { parcels: { paint: { "fill-color": "#112233" } } },
    },
  },
  {
    name: "clearing a layer's style keeps the shared style definitions",
    command: { name: "setLayerStyleRef", target: { kind: "layer", id: "roads" } },
  },
];

let server: Awaited<ReturnType<typeof startMockServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function seededDraft(client: McpClient) {
  const tools = new StudioMcpToolClient(client);
  const draft = await tools.createDraft({ packageKey: "pkg-parity", family: "map", schemaVersion: "1" });
  return tools.updateDraft({
    draftId: draft.draftId,
    generation: draft.generation,
    packageKey: "pkg-parity",
    schemaVersion: "1",
    body: SEEDED_BODY,
  });
}

async function applyThroughMock(command: CompositionCommand): Promise<unknown> {
  server = await startMockServer();
  const token = mintFixtureAccessToken();
  const client = new McpClient({ baseUrl: server.url, auth: { getAccessToken: async () => token } });
  const draft = await seededDraft(client);
  const resolution = resolveToolCall({ toolName: command.name, arguments: { ...command } });
  if (!resolution.ok || !resolution.serverToolName) throw new Error(`No server tool for ${command.name}.`);
  const invocation = buildServerToolInvocation(resolution, draft)!;
  const result = parseStudioDraftResult(await client.callTool(invocation.name, invocation.arguments));
  return readComparableBody(result.envelope.body);
}

function applyThroughReducer(command: CompositionCommand): unknown {
  const { state } = applyCompositionCommand(readCompositionBody(SEEDED_BODY), command);
  return readComparableBody(toStudioCompositionBody(state));
}

function readComparableBody(body: unknown) {
  const { sourceBindings, styleRefs, mapSpec, layers, view, widgets } = toStudioCompositionBody(
    readCompositionBody(body),
  );
  return { sourceBindings, styleRefs, mapSpec, layers, view, widgets };
}

describe("mock server composition tools match the client reducer", () => {
  it.each(CASES)("$name", async ({ command }) => {
    const expected = applyThroughReducer(command);

    expect(await applyThroughMock(command)).toEqual(expected);
  });

  it("refuses an out-of-bounds view the reducer refuses", async () => {
    server = await startMockServer();
    const token = mintFixtureAccessToken();
    const client = new McpClient({ baseUrl: server.url, auth: { getAccessToken: async () => token } });
    const draft = await seededDraft(client);
    const command: CompositionCommand = { name: "setView", view: { zoom: 30 } };

    expect(() => applyThroughReducer(command)).toThrow("out of bounds");
    await expect(
      new StudioMcpToolClient(client).setView({
        draftId: draft.draftId,
        generation: draft.generation,
        view: { zoom: 30 },
      }),
    ).rejects.toThrow("out of bounds");
  });
});
