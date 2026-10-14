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

  it("rejects a select without either source discovery or explicit options", () => {
    expect(
      compositionAuthoringError("honua_studio_add_control", {
        control: { id: "c", kind: "filterSelect", config: { field: "district" } },
      })?.isError,
    ).toBe(true);
    expect(
      compositionAuthoringError("honua_studio_add_control", {
        control: { id: "c", kind: "filterSelect", config: { field: "district", options: ["North"] } },
      }),
    ).toBeUndefined();
  });

  it("admits a declared numeric domain without a source for a later explicit binding", () => {
    expect(
      compositionAuthoringError("honua_studio_add_control", {
        control: { id: "c", kind: "filterSlider", config: { field: "height", min: 0, max: 100 } },
      }),
    ).toBeUndefined();
    expect(
      compositionAuthoringError("honua_studio_add_control", { control: { id: "nav", kind: "navigation" } }),
    ).toBeUndefined();
  });

  for (const config of [
    { kind: "filterSlider", field: "height", min: 0, max: 10, step: 0 },
    { kind: "filterSlider", field: "height", min: 0, max: 10, step: -1 },
    { kind: "timeSlider", field: "date", from: "2026-99-99", to: "2027-01-01" },
    { kind: "timeSlider", field: "date", from: "2026-02-29", to: "2026-03-01" },
    { kind: "timeSlider", field: "date", from: "2024-02-30", to: "2024-03-01" },
    { kind: "timeSlider", field: "date", from: "2026-01-02", to: "2026-01-01" },
  ]) {
    it(`rejects the invalid authored control domain before dispatch: ${JSON.stringify(config)}`, async () => {
      const fetchImpl = vi.fn();
      const client = new StudioAuthoringMcpClient({ baseUrl: "https://example.test", fetchImpl });
      const { kind, ...domain } = config;
      const result = await client.callTool("honua_studio_add_control", {
        control: { id: "domain", kind, config: domain },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(kind === "filterSlider" ? "positive" : "calendar dates");
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  }

  for (const config of [
    { kind: "filterSlider", field: "height", min: 0, max: 10, step: 0.5 },
    { kind: "timeSlider", field: "date", from: "2024-02-29", to: "2024-03-01" },
    { kind: "timeSlider", field: "date", from: "2024-02-29", to: "2024-02-29" },
    { kind: "timeSlider", field: "date", start: "2024-02-29T12:00:00Z", end: "2024-03-01T12:00:00Z" },
  ]) {
    it(`preserves valid normalized control domains: ${JSON.stringify(config)}`, () => {
      const { kind, ...domain } = config;
      const args = { control: { id: "domain", kind, config: domain } };
      const before = JSON.stringify(args);
      expect(compositionAuthoringError("honua_studio_add_control", args)).toBeUndefined();
      expect(JSON.stringify(args)).toBe(before);
    });
  }

  for (const [kind, expected] of [
    ["compare", "two layers"],
    ["time", "config.steps"],
    ["table", "sourceId"],
  ] as const) {
    it(`refuses unrenderable ${kind} before durable dispatch`, async () => {
      const fetchImpl = vi.fn();
      const client = new StudioAuthoringMcpClient({ baseUrl: "https://example.test", fetchImpl });
      const error = await client.callTool("honua_studio_add_widget", { widget: { id: "w", kind } });
      expect(error.isError).toBe(true);
      expect(JSON.stringify(error.content)).toContain(expected);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  }

  for (const widget of [
    { id: "w", kind: "compare", config: { left: "layer-a", right: "layer-b" } },
    { id: "w", kind: "time", config: { steps: [{ label: "First", layerId: "layer-a" }] } },
    { id: "w", kind: "table", sourceId: "catalog-source" },
    { id: "w", kind: "toc" },
    { id: "w", kind: "legend" },
  ]) {
    it(`preserves valid ${widget.kind} rendering configuration`, () => {
      const before = JSON.stringify(widget);
      expect(compositionAuthoringError("honua_studio_add_widget", { widget })).toBeUndefined();
      expect(JSON.stringify(widget)).toBe(before);
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
