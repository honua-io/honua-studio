import { composeStyle } from "@honua/sdk-js/runtime";
import { describe, expect, it, vi } from "vitest";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import { compositionToMapPackage } from "../../src/map/map-package-projection.js";
import {
  AuthoritativeStyleProvider,
  parseStyleLayers,
  styleContentHash,
} from "../../src/styles/authoritative-style-provider.js";

const sheet = {
  version: 8,
  sources: { parcels: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
  layers: [
    {
      id: "canonical-parcels",
      type: "fill",
      source: "parcels",
      paint: {
        "fill-color": ["match", ["get", "district"], "North", "#003366", "#ddaa22"],
      },
    },
  ],
};
const source = {
  id: "service/0",
  geometryType: "Polygon",
  protocol: "geoservices-feature-service",
  locator: { serviceId: "service", layerId: 0, url: "https://honua.test/honua/rest/services/Parcels/FeatureServer" },
};
function fixture(overrides: Record<string, unknown> = {}, descriptorOverrides: Record<string, unknown> = {}) {
  const style = {
    styleId: "district",
    title: "District colors",
    description: "District field: North navy, other gold.",
    styleVersion: 0,
    encodings: [{ encoding: "mapbox-style", inlineBody: JSON.stringify(sheet) }],
    ...overrides,
  };
  let auth = { getAccessToken: vi.fn(async () => "token") };
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    const body =
      request.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: "1" } }
        : {
            structuredContent:
              request.params.name === "honua_describe_layer"
                ? {
                    serviceId: "service",
                    serviceName: "Parcels",
                    layerId: 0,
                    geometryType: "Polygon",
                    fieldCount: 1,
                    fields: [{ name: "district", type: "String" }],
                    ...descriptorOverrides,
                  }
                : request.params.arguments.styleId
                  ? style
                  : { styles: [{ styleId: "district", title: "District colors" }] },
          };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: body }), {
      headers: { "content-type": "application/json" },
    });
  });
  const provider = new AuthoritativeStyleProvider({
    baseUrl: "https://honua.test/honua",
    documentUrl: "https://studio.test/",
    getAuth: () => auth,
    fetchImpl,
  });
  return {
    style,
    provider,
    fetchImpl,
    get auth() {
      return auth;
    },
    replaceAuth() {
      auth = { getAccessToken: vi.fn(async () => "next-token") };
    },
  };
}

describe("authoritative style provider", () => {
  it("preserves hidden layers, combines active filters and scales canonical opacity in the actual SDK composition", async () => {
    const binding = await fixture().provider.bind("district", source);
    const canonicalFilter = ["==", ["get", "district"], "East"];
    const controlFilter = [">", ["get", "year_built"], 1970];
    const styled = {
      ...binding,
      override: {
        ...binding.override,
        layout: { visibility: "visible" },
        filter: canonicalFilter,
        paint: { ...binding.override.paint, "fill-opacity": 0.8 },
      },
    };
    const state = {
      ...createEmptyCompositionState(),
      layers: [
        {
          id: "composed",
          sourceId: source.id,
          visible: false,
          styleRef: { kind: "style-ref" as const, styleId: "district" },
        },
      ],
    };
    const projected = compositionToMapPackage(state, {
      catalog: [source],
      authoritativeStyles: { composed: styled },
      appearance: { filters: { composed: controlFilter }, opacity: { composed: 0.5 } },
    });
    const actual = await composeStyle(projected.mapPackage, projected.mapPackage.mapSpec, {});
    const layer = actual.layers.find((entry) => entry.id === "composed");
    expect(layer?.layout?.visibility).toBe("none");
    expect(layer?.paint?.["fill-opacity"]).toBe(0.4);
    expect(layer?.filter).toEqual(["all", canonicalFilter, controlFilter]);
    expect(actual.layers.find((entry) => entry.id === "composed__outline")?.filter).toEqual([
      "all",
      canonicalFilter,
      controlFilter,
    ]);
  });

  it.each([true, false])(
    "applies composition visibility %s to fill and outline while preserving canonical zoom and layout",
    async (visible) => {
      const binding = await fixture().provider.bind("district", source);
      const canonicalVisibility = visible ? "none" : "visible";
      const canonical = {
        ...binding.override,
        layout: { visibility: canonicalVisibility, "fill-sort-key": 7 },
        minzoom: 8,
        maxzoom: 14,
      };
      const state = {
        ...createEmptyCompositionState(),
        layers: [
          {
            id: "composed",
            sourceId: source.id,
            visible,
            styleRef: { kind: "style-ref" as const, styleId: "district" },
          },
        ],
      };
      const projected = compositionToMapPackage(state, {
        catalog: [source],
        authoritativeStyles: {
          composed: { ...binding, override: canonical },
        },
      });
      const actual = await composeStyle(projected.mapPackage, projected.mapPackage.mapSpec, {});
      for (const id of ["composed", "composed__outline"]) {
        expect(actual.layers.find((layer) => layer.id === id)).toMatchObject({
          layout: { visibility: visible ? canonicalVisibility : "none" },
          minzoom: 8,
          maxzoom: 14,
        });
      }
      expect(actual.layers.find((layer) => layer.id === "composed")?.layout?.["fill-sort-key"]).toBe(7);
      expect(canonical.layout.visibility).toBe(canonicalVisibility);
    },
  );

  it.each([
    ["==", "imaginary", "North"],
    ["all", ["==", "district", "North"], ["has", "district"]],
    ["in", "district", "North", "East"],
    ["!has", "imaginary"],
  ])("rejects legacy filters before they can mix with expression controls: %j", async (...filter) => {
    const altered = { ...sheet, layers: [{ ...sheet.layers[0], filter }] };
    await expect(
      fixture({ encodings: [{ encoding: "mapbox-style", inlineBody: JSON.stringify(altered) }] }).provider.bind(
        "district",
        source,
      ),
    ).rejects.toThrow("Legacy stylesheet filters");
  });

  it("rejects legacy property functions rather than bypassing descriptor field validation", async () => {
    const altered = {
      ...sheet,
      layers: [
        {
          ...sheet.layers[0],
          paint: {
            "fill-color": {
              property: "imaginary",
              type: "categorical",
              stops: [
                ["North", "#003366"],
                ["East", "#ddaa22"],
              ],
            },
          },
        },
      ],
    };
    await expect(
      fixture({ encodings: [{ encoding: "mapbox-style", inlineBody: JSON.stringify(altered) }] }).provider.bind(
        "district",
        source,
      ),
    ).rejects.toThrow("Legacy stylesheet property functions");
  });

  it("projects canonical paint onto the existing layer and refuses missing bindings", async () => {
    const binding = await fixture().provider.bind("district", source);
    const state = {
      ...createEmptyCompositionState(),
      layers: [
        {
          id: "composed",
          sourceId: source.id,
          visible: true,
          styleRef: { kind: "style-ref" as const, styleId: "district" },
        },
      ],
    };
    const projected = compositionToMapPackage(state, { catalog: [source], authoritativeStyles: { composed: binding } });
    expect(projected.mapPackage.styleRefs?.[0]?.body?.composed?.paint).toEqual(sheet.layers[0]?.paint);
    expect(projected.mapPackage.styleRefs?.[0]?.body).not.toHaveProperty("canonical-parcels");
    const missing = compositionToMapPackage(state, { catalog: [source], authoritativeStyles: {} });
    expect(missing.renderedLayerIds).toEqual([]);
    expect(missing.unresolved[0]?.reason).toContain("unavailable");
  });

  it("does not bypass required authority through a legacy Honua service alias", () => {
    const state = {
      ...createEmptyCompositionState(),
      layers: [
        {
          id: "legacy",
          sourceId: "service",
          visible: true,
          styleRef: { kind: "style-ref" as const, styleId: "unknown" },
        },
      ],
    };
    const projected = compositionToMapPackage(state, { catalog: [source], authoritativeStyles: {} });
    expect(projected.renderedLayerIds).toEqual([]);
    expect(projected.unresolved[0]?.reason).toContain("unavailable");
  });

  it("reads actual MCP catalog, exact revision zero and byte hash, then binds actual descriptor fields", async () => {
    const context = fixture();
    expect(await context.provider.list()).toEqual([{ styleId: "district", title: "District colors" }]);
    const result = await context.provider.bind("district", source);
    expect(result.definition.styleVersion).toBe(0);
    expect(result.definition.sha256).toBe(await styleContentHash(JSON.stringify(sheet)));
    expect(result.fields).toEqual(["district"]);
    expect(result.override.paint).toEqual(sheet.layers[0]?.paint);
    expect(result.override).not.toHaveProperty("source");
    for (const [url, init] of context.fetchImpl.mock.calls) {
      expect(url).toBe("https://honua.test/honua/mcp");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer token");
      expect(init?.redirect).toBe("error");
    }
  });
  it("re-reads revisions and current session without sharing a cache", async () => {
    const context = fixture();
    const first = await context.provider.read("district");
    context.style.styleVersion = 1;
    context.replaceAuth();
    const next = await context.provider.read("district");
    expect(next.styleVersion).toBe(1);
    expect(first.styleVersion).toBe(0);
    expect(new Headers(context.fetchImpl.mock.calls.at(-1)?.[1]?.headers).get("Authorization")).toBe(
      "Bearer next-token",
    );
  });
  it.each([{ styleId: "other" }, { styleVersion: -1 }, { styleVersion: "1" }, { encodings: [] }])(
    "rejects invalid identity/revision/body %j",
    async (overrides) => {
      await expect(fixture(overrides).provider.read("district")).rejects.toThrow();
    },
  );
  it("rejects styles referencing fields absent from the actual descriptor", async () => {
    const altered = structuredClone(sheet);
    altered.layers[0]!.paint["fill-color"] = ["get", "imaginary"];
    await expect(
      fixture({ encodings: [{ encoding: "mapbox-style", inlineBody: JSON.stringify(altered) }] }).provider.bind(
        "district",
        source,
      ),
    ).rejects.toThrow("missing field");
  });
  it("rejects ambiguous compatible layers instead of selecting the first", async () => {
    const altered = structuredClone(sheet);
    altered.layers.push({ ...altered.layers[0]!, id: "second" });
    await expect(
      fixture({ encodings: [{ encoding: "mapbox-style", inlineBody: JSON.stringify(altered) }] }).provider.bind(
        "district",
        source,
      ),
    ).rejects.toThrow("exactly one");
  });
  it.each([
    { ...sheet, sprite: "https://outside.test/sprite" },
    { ...sheet, glyphs: "https://outside.test/{fontstack}/{range}.pbf" },
    { ...sheet, sources: { parcels: { type: "geojson", data: "https://outside.test/data" } } },
    { ...sheet, sources: { parcels: { type: "vector", tiles: ["https://outside.test/{z}/{x}/{y}"] } } },
  ])("rejects external resources without fetching them", (style) => {
    expect(() => parseStyleLayers(JSON.stringify(style))).toThrow();
  });
  it("rejects oversized JSON and duplicate layer identities", () => {
    expect(() => parseStyleLayers(" ".repeat(262145))).toThrow("256 KiB");
    expect(() => parseStyleLayers(JSON.stringify({ ...sheet, layers: [sheet.layers[0], sheet.layers[0]] }))).toThrow();
  });
  it("refuses a response that changed session while pending", async () => {
    const context = fixture();
    const original = context.fetchImpl.getMockImplementation()!;
    context.fetchImpl.mockImplementationOnce(async (url, init) => {
      const response = await original(url, init);
      context.replaceAuth();
      return response;
    });
    await expect(context.provider.list()).rejects.toThrow();
  });
  it("refuses redirected metadata rather than using its inline stylesheet", async () => {
    const context = fixture();
    context.fetchImpl.mockImplementationOnce(async () => {
      const response = new Response("{}");
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    });
    await expect(context.provider.list()).rejects.toThrow();
  });
});

it("reads explicit author descriptions from the hash-bound canonical document", async () => {
  const body = JSON.stringify({
    ...sheet,
    name: "Council presentation",
    metadata: { "honua:description": "Navy parcels with 0.8 opacity." },
  });
  const { provider } = fixture({
    title: "opaque-id",
    description: "",
    encodings: [{ encoding: "mapbox-style", inlineBody: body }],
  });
  const value = await provider.read("district");
  expect(value.title).toBe("Council presentation");
  expect(value.description).toBe("Navy parcels with 0.8 opacity.");
  expect(value.sha256).toBe(await styleContentHash(body));
});

it("refuses catalog provenance when the effective renderer source is overridden", async () => {
  const binding = await fixture().provider.bind("district", source);
  const state = {
    ...createEmptyCompositionState(),
    layers: [
      {
        id: "composed",
        sourceId: source.id,
        visible: true,
        styleRef: { kind: "style-ref" as const, styleId: "district" },
        metadata: {
          honua: {
            source: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
            geometryType: "Polygon",
          },
        },
      },
    ],
  };
  const projected = compositionToMapPackage(state, { catalog: [source], authoritativeStyles: { composed: binding } });
  expect(projected.renderedLayerIds).toEqual([]);
  expect(projected.unresolved[0]?.reason).toMatch(/source override/);
  expect(projected.mapPackage.styleRefs).toBeUndefined();
});

it("does not treat explicit literal-object or literal-array filter operands as source fields", async () => {
  const altered = {
    ...sheet,
    layers: [
      {
        ...sheet.layers[0],
        filter: ["all", ["has", "name", ["literal", { name: 1 }]], ["in", "a", ["literal", ["a", "b"]]]],
      },
    ],
  };
  await expect(
    fixture({ encodings: [{ encoding: "mapbox-style", inlineBody: JSON.stringify(altered) }] }).provider.bind(
      "district",
      source,
    ),
  ).resolves.toMatchObject({ stylesheetLayerId: sheet.layers[0]!.id });
});

it("uses only the canonical streaming process identity and reports unsupported bindings without index fallback", async () => {
  expect(await fixture({}, { processLayerId: 702 }).provider.resolveProcessSource(source)).toEqual({
    processLayerId: 702,
  });
  expect(await fixture({}, { processLayerId: 0 }).provider.resolveProcessSource(source)).toEqual({ processLayerId: 0 });
  expect(
    await fixture(
      {},
      { processLayerUnavailableReason: "The bound provider cannot stream." },
    ).provider.resolveProcessSource(source),
  ).toEqual({ unavailableReason: "The bound provider cannot stream." });
  await expect(fixture({}, { processLayerId: 1.5 }).provider.resolveProcessSource(source)).rejects.toThrow(
    "identity is invalid",
  );
});

it("accepts resource-free labels on the selected actual source and validates their published field", async () => {
  const withLabels = {
    ...sheet,
    layers: [
      ...sheet.layers,
      {
        id: "parcel-labels",
        type: "symbol",
        source: "parcels",
        layout: { "text-field": ["get", "district"], "text-size": 12 },
      },
    ],
  };
  const bound = await fixture({
    encodings: [{ encoding: "mapbox-style", inlineBody: JSON.stringify(withLabels) }],
  }).provider.bind("district", source);
  expect(bound.definition.layers.some((layer) => layer.id === "parcel-labels" && layer.type === "symbol")).toBe(true);
  const missing = {
    ...withLabels,
    layers: [
      ...sheet.layers,
      {
        id: "parcel-labels",
        type: "symbol",
        source: "parcels",
        layout: { "text-field": ["get", "secret"] },
      },
    ],
  };
  await expect(
    fixture({ encodings: [{ encoding: "mapbox-style", inlineBody: JSON.stringify(missing) }] }).provider.bind(
      "district",
      source,
    ),
  ).rejects.toThrow('missing field "secret"');
});
