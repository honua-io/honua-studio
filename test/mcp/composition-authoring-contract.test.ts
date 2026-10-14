import { describe, expect, it, vi } from "vitest";
import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { buildStudioSystemPrompt } from "../../src/chat/system-prompt.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import {
  StudioAuthoringMcpClient,
  compositionAuthoringError,
  compositionAuthoringGuidance,
} from "../../src/mcp/composition-authoring-contract.js";
import { readChartConfig } from "../../src/widgets/widget-config.js";

describe("model composition authoring contract", () => {
  it("shares general rendering guidance with the normal app", () => {
    const guidance = compositionAuthoringGuidance();
    expect(buildStudioSystemPrompt({ composition: createEmptyCompositionState() })).toContain(guidance);
    expect(guidance).toContain("kind toc");
    expect(guidance).toContain("groupBy");
    expect(guidance).toContain("filterSlider");
    expect(guidance).toContain('value: "$event.value"');
    expect(guidance).not.toContain("hi-parcels");
    expect(guidance).not.toContain("zoning_code");
  });

  for (const [name, args, expected] of [
    ["honua_studio_add_widget", { widget: { id: "w", kind: "layerList" } }, "toc"],
    ["honua_studio_add_widget", { widget: { id: "w", kind: "chart", config: {} } }, "groupBy"],
    ["honua_studio_add_control", { control: { id: "c", kind: "filterSlider", config: { min: 0, max: 10 } } }, "field"],
    [
      "honua_studio_add_control",
      { control: { id: "c", kind: "filterSlider", config: { field: "height", min: 10, max: 0 } } },
      "max greater than min",
    ],
    ["honua_studio_add_control", { control: { id: "c", kind: "timeSlider", config: { field: "date" } } }, "ISO dates"],
    ["honua_studio_add_control", { control: { id: "c", kind: "invented" } }, "filterSlider"],
    ["honua_studio_add_widget", { name: "setView", view: {}, widget: { id: "w", kind: "chart" } }, "groupBy"],
  ] as const) {
    it(`refuses unrenderable ${name}: ${expected} before any network mutation`, async () => {
      const fetchImpl = vi.fn();
      const client = new StudioAuthoringMcpClient({ baseUrl: "https://example.test", fetchImpl });
      const result = await client.callTool(name, args);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(expected);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  }

  for (const sourceId of [undefined, "", "   "]) {
    it(`refuses a chart without an actual source identifier: ${JSON.stringify(sourceId)}`, () => {
      const error = compositionAuthoringError("honua_studio_add_widget", {
        widget: { id: "chart", kind: "chart", sourceId, config: { groupBy: "district" } },
      });
      expect(error?.isError).toBe(true);
      expect(JSON.stringify(error?.content)).toContain("sourceId");
    });
  }

  for (const alias of ["groupBy", "categoryField", "category", "by", "x", "field"]) {
    it(`preserves the supported ${alias} chart alias and its actual rendering intent`, () => {
      const widget = {
        id: "w",
        kind: "chart" as const,
        sourceId: "catalog-source",
        config: { [alias]: "district", chartType: "bar" },
      };
      const before = JSON.stringify(widget);
      expect(compositionAuthoringError("honua_studio_add_widget", { widget })).toBeUndefined();
      expect(readChartConfig(widget)).toMatchObject({
        ok: true,
        config: { groupBy: "district", chartType: "bar", measure: { fn: "count" } },
      });
      expect(JSON.stringify(widget)).toBe(before);
    });
  }

  it("admits valid numeric controls before their later explicit binding", () => {
    expect(
      compositionAuthoringError("honua_studio_add_control", {
        control: {
          id: "c",
          kind: "filterSlider",
          sourceId: "future-layer",
          config: { field: "height", min: 0, max: 50 },
        },
      }),
    ).toBeUndefined();
    expect(
      compositionAuthoringError("honua_studio_bind_interaction", { interaction: { id: "binding" } }),
    ).toBeUndefined();
  });

  it("retains real MCP discovery and transmits valid alias arguments unchanged", async () => {
    const server = await startMockServer();
    try {
      const requests: Record<string, unknown>[] = [];
      const client = new StudioAuthoringMcpClient({
        baseUrl: server.url,
        auth: { getAccessToken: async () => mintFixtureAccessToken() },
        fetchImpl: async (url, init) => {
          if (typeof init?.body === "string") requests.push(JSON.parse(init.body));
          return fetch(url, init);
        },
      });
      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === "honua_studio_add_widget")).toBe(true);
      const args = {
        draftId: "unknown-draft",
        generation: 0,
        widget: {
          id: "w",
          kind: "chart",
          sourceId: "catalog-source",
          config: { categoryField: "district", chartType: "bar" },
        },
      };
      // The actual server may reject this deliberately absent draft; host admission must preserve its arguments.
      await client.callTool("honua_studio_add_widget", args).catch(() => undefined);
      expect(requests.find((request) => request.method === "tools/call")?.params).toEqual({
        name: "honua_studio_add_widget",
        arguments: args,
      });
    } finally {
      await server.close();
    }
  });
});
