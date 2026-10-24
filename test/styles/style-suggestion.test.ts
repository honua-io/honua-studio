// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompositionController } from "../../src/composition/controller.js";
import { canonicalCompositionJson, createEmptyCompositionState } from "../../src/composition/model.js";
import type { CompositionSourceDescriptor } from "../../src/map/source-resolution.js";
import type { MapStyleDocument } from "../../src/styles/map-style-edit.js";
import { LayerStyleSuggestion } from "../../src/styles/style-suggestion.js";

const PRINCIPAL = "principal-a";
const ENVIRONMENT = "env-a";
const CANONICAL_LAYER_ID = 12;

afterEach(() => {
  document.body.innerHTML = "";
});

function mapStyle(): MapStyleDocument {
  return {
    version: 8,
    glyphs: "https://example.com/approved/{fontstack}/{range}.pbf",
    sources: {
      parcels: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      other: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    },
    layers: [
      { id: "parcels", type: "fill", source: "parcels", paint: { "fill-color": "#112233", "fill-opacity": 1 } },
      { id: "parcels__outline", type: "line", source: "parcels", paint: { "line-color": "#112233", "line-width": 1 } },
      { id: "other", type: "circle", source: "other", paint: { "circle-color": "#abcdef", "circle-radius": 4 } },
    ],
  };
}

function controllerFor(styleRefs?: CompositionController["state"]["styleRefs"]) {
  return new CompositionController({
    ...createEmptyCompositionState(),
    layers: [
      { id: "parcels", sourceId: "parcels", type: "fill", title: "Parcels", visible: true },
      {
        id: "other",
        sourceId: "other",
        type: "circle",
        title: "Other",
        visible: true,
        ...(styleRefs ? { styleRef: { kind: "style-ref" as const, styleId: "catalog-shared" } } : {}),
      },
    ],
    mapSpec: mapStyle(),
    ...(styleRefs ? { styleRefs } : {}),
  });
}

function catalog(
  locator: CompositionSourceDescriptor["locator"] = { serviceId: "parcels", layerId: CANONICAL_LAYER_ID },
) {
  return [{ id: "parcels", locator }] satisfies readonly CompositionSourceDescriptor[];
}

function geometrySuggestion() {
  return {
    mapLibreStyle: {
      version: 8,
      sources: { "12": { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
      glyphs: "https://evil.example/glyphs/{fontstack}/{range}.pbf",
      sprite: "https://evil.example/sprite",
      layers: [
        { id: "12", type: "fill", source: "12", paint: { "fill-color": "#0b7285", "fill-opacity": 0.8 } },
        { id: "12-outline", type: "line", source: "12", paint: { "line-color": "#654321", "line-width": 2 } },
      ],
    },
    legend: { title: "Parcels", entries: [{ label: "Parcels", color: "#0b7285" }] },
    paletteName: "Default",
    observations: ["Geometry follows the server default."],
    edition: "Community",
  };
}

function classificationSuggestion() {
  return {
    mapLibreStyle: {
      version: 8,
      layers: [{ id: "storage-12", type: "fill", source: "storage-12", paint: { "fill-color": "#440154" } }],
    },
    legend: {
      title: "Year built",
      entries: [
        { label: "1900–1950", color: "#440154" },
        { label: "1950–2020", color: "#fde725" },
      ],
    },
    suggestedField: { name: "year_built", type: "integer", reason: "numeric range" },
    classificationMethod: "NaturalBreaks",
    paletteName: "Viridis",
    observations: ["Five classes follow the natural breaks."],
    edition: "Standard",
  };
}

function envelope(revision: string, data: Record<string, unknown>, binding: Record<string, unknown> = {}) {
  return {
    binding: {
      principalId: PRINCIPAL,
      environmentId: ENVIRONMENT,
      canonicalLayerId: CANONICAL_LAYER_ID,
      draftRevision: revision,
      composedLayerId: "parcels",
      ...binding,
    },
    suggestion: { success: true, data },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function paintOf(style: MapStyleDocument, layerId: string): Record<string, unknown> {
  const layer = (style.layers as Record<string, unknown>[]).find((entry) => entry.id === layerId);
  return (layer?.paint ?? {}) as Record<string, unknown>;
}

function mount(
  controller: CompositionController,
  transport: (
    canonicalLayerId: number,
    init: { signal: AbortSignal; draftRevision: string; composedLayerId: string },
  ) => Promise<Response>,
  sourceCatalog: readonly CompositionSourceDescriptor[] = catalog(),
  layerId = "parcels",
) {
  const container = document.createElement("div");
  document.body.append(container);
  const onPreview = vi.fn();
  const suggestion = new LayerStyleSuggestion({
    controller,
    catalog: sourceCatalog,
    principalId: PRINCIPAL,
    environmentId: ENVIRONMENT,
    transport,
    onPreview,
    container,
    layerId,
  });
  return { container, onPreview, suggestion };
}

describe("authorized style suggestion", () => {
  it("previews the server paint and observations for a geometry-only response without writing", async () => {
    const controller = controllerFor();
    const before = canonicalCompositionJson(controller.state);
    const apply = vi.spyOn(controller, "apply");
    const transport = vi.fn<
      (
        canonicalLayerId: number,
        init: { signal: AbortSignal; draftRevision: string; composedLayerId: string },
      ) => Promise<Response>
    >(async () => jsonResponse(envelope(canonicalCompositionJson(controller.state), geometrySuggestion())));
    const { container, onPreview, suggestion } = mount(controller, transport);
    const result = await suggestion.request();
    expect(result.ok).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]).toHaveLength(2);
    expect(transport.mock.calls[0]?.[0]).toBe(CANONICAL_LAYER_ID);
    expect(transport.mock.calls[0]?.[1]).toMatchObject({ draftRevision: before, composedLayerId: "parcels" });
    expect(transport.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(apply).not.toHaveBeenCalled();
    expect(canonicalCompositionJson(controller.state)).toBe(before);
    expect(onPreview).toHaveBeenCalledTimes(1);
    const preview = onPreview.mock.calls[0]?.[0] as MapStyleDocument;
    expect(paintOf(preview, "parcels")["fill-color"]).toBe("#0b7285");
    expect(paintOf(preview, "parcels__outline")["line-color"]).toBe("#654321");
    expect(paintOf(preview, "other")["circle-color"]).toBe("#abcdef");
    expect(preview.glyphs).toBe("https://example.com/approved/{fontstack}/{range}.pbf");
    expect(JSON.stringify(preview)).not.toContain("evil.example");
    expect(container.querySelector("[data-style-suggestion-method]")).toBeNull();
    expect(container.querySelector("[data-style-suggestion-palette]")?.textContent).toBe("Default");
    expect(container.querySelector("[data-style-suggestion-edition]")?.textContent).toBe("Community");
    expect(container.querySelector("[data-style-suggestion-observations]")?.textContent).toContain(
      "Geometry follows the server default.",
    );
    expect(container.querySelector("[data-style-suggestion-legend]")?.textContent).toContain("#0b7285");
  });

  it("shows the server classification method, field, palette, and legend entries", async () => {
    const controller = controllerFor();
    const transport = vi.fn(async () =>
      jsonResponse(envelope(canonicalCompositionJson(controller.state), classificationSuggestion())),
    );
    const { container, onPreview, suggestion } = mount(controller, transport);
    const result = await suggestion.request();
    expect(result.ok).toBe(true);
    expect(container.querySelector("[data-style-suggestion-method]")?.textContent).toBe("NaturalBreaks");
    expect(container.querySelector("[data-style-suggestion-field]")?.textContent).toBe("year_built");
    expect(container.querySelector("[data-style-suggestion-palette]")?.textContent).toBe("Viridis");
    expect(container.querySelector("[data-style-suggestion-edition]")?.textContent).toBe("Standard");
    const legend = container.querySelector("[data-style-suggestion-legend]")?.textContent ?? "";
    expect(legend).toContain("1900–1950");
    expect(legend).toContain("#440154");
    expect(legend).toContain("1950–2020");
    expect(legend).toContain("#fde725");
    expect(paintOf(onPreview.mock.calls[0]?.[0] as MapStyleDocument, "parcels")["fill-color"]).toBe("#440154");
  });

  it("applies only the selected layer inline style and keeps the shared catalog style", async () => {
    const shared = {
      styleId: "catalog-shared",
      body: { other: { paint: { "circle-color": "#abcdef" } } },
    };
    const controller = controllerFor([shared]);
    const transport = vi.fn(async () =>
      jsonResponse(envelope(canonicalCompositionJson(controller.state), geometrySuggestion())),
    );
    const { suggestion } = mount(controller, transport);
    expect((await suggestion.request()).ok).toBe(true);
    const applied = await suggestion.apply();
    expect(applied.ok).toBe(true);
    const inline = controller.state.styleRefs?.find((ref) => ref.styleId === "honua-inline:parcels");
    expect(inline?.body?.parcels).toMatchObject({ paint: { "fill-color": "#0b7285", "fill-opacity": 0.8 } });
    expect(inline?.body?.parcels__outline).toMatchObject({ paint: { "line-color": "#654321", "line-width": 2 } });
    expect(JSON.stringify(inline)).not.toMatch(/glyphs|sprite|sources|evil\.example/);
    expect(controller.state.styleRefs?.find((ref) => ref.styleId === "catalog-shared")).toEqual(shared);
    expect(controller.state.layers.find((layer) => layer.id === "other")?.styleRef).toEqual({
      kind: "style-ref",
      styleId: "catalog-shared",
    });
    expect(controller.state.layers.find((layer) => layer.id === "parcels")?.styleRef).toEqual({
      kind: "style-ref",
      styleId: "honua-inline:parcels",
    });
    expect(paintOf(controller.state.mapSpec as MapStyleDocument, "parcels")["fill-color"]).toBe("#112233");
    expect(paintOf(controller.state.mapSpec as MapStyleDocument, "other")["circle-color"]).toBe("#abcdef");
    expect(suggestion.undo()).toBe(true);
    expect(controller.state.layers.find((layer) => layer.id === "parcels")?.styleRef).toBeUndefined();
    expect(controller.state.styleRefs?.find((ref) => ref.styleId === "honua-inline:parcels")).toBeUndefined();
    expect(controller.state.styleRefs?.find((ref) => ref.styleId === "catalog-shared")).toEqual(shared);
  });

  it("does not mutate when the suggestion is unauthorized or the canonical layer is gone", async () => {
    for (const [status, reason] of [
      [403, "The suggestion was not authorized."],
      [401, "The suggestion was not authorized."],
      [404, "The canonical layer is no longer available."],
    ] as const) {
      const controller = controllerFor();
      const before = canonicalCompositionJson(controller.state);
      const apply = vi.spyOn(controller, "apply");
      const { onPreview, suggestion } = mount(
        controller,
        vi.fn(async () => new Response("no", { status })),
      );
      const result = await suggestion.request();
      expect(result).toEqual({ ok: false, reason });
      expect(apply).not.toHaveBeenCalled();
      expect(onPreview).not.toHaveBeenCalled();
      expect(canonicalCompositionJson(controller.state)).toBe(before);
    }
  });

  it("refuses a missing, deleted, external, or ambiguous catalog target before transport", async () => {
    const controller = controllerFor();
    const cases: { catalog: readonly CompositionSourceDescriptor[]; layerId?: string; reason: string }[] = [
      { catalog: catalog({ serviceId: "parcels" }), reason: "This layer has no canonical metadata id." },
      { catalog: catalog({ serviceId: "parcels", layerId: -1 }), reason: "This layer has no canonical metadata id." },
      {
        catalog: catalog({
          serviceId: "parcels",
          layerId: CANONICAL_LAYER_ID,
          url: "https://evil.example/FeatureServer/12",
        }),
        reason: "This source is not an authorized catalog layer.",
      },
      {
        catalog: [{ id: "elsewhere", locator: { layerId: CANONICAL_LAYER_ID } }],
        reason: "This source is not an authorized catalog layer.",
      },
      {
        catalog: [
          { id: "parcels", locator: { layerId: 1 } },
          { id: "parcels", locator: { layerId: 2 } },
        ],
        reason: "The canonical layer is ambiguous.",
      },
      { catalog: catalog(), layerId: "removed", reason: "The selected layer is no longer on the map." },
    ];
    for (const entry of cases) {
      const transport = vi.fn();
      const { suggestion } = mount(controller, transport, entry.catalog, entry.layerId);
      const result = await suggestion.request();
      expect(result).toEqual({ ok: false, reason: entry.reason });
      expect(transport).not.toHaveBeenCalled();
    }
  });

  it("ignores a late response after the selection or the composition changes", async () => {
    const controller = controllerFor();
    let release: ((response: Response) => void) | undefined;
    const transport = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const revision = canonicalCompositionJson(controller.state);
    const { onPreview, suggestion } = mount(controller, transport);
    const pending = suggestion.request();
    suggestion.retarget("other");
    release!(jsonResponse(envelope(revision, geometrySuggestion())));
    expect(await pending).toEqual({ ok: false, reason: "The selection changed before the suggestion returned." });
    expect(onPreview).not.toHaveBeenCalled();

    const second = mount(controller, transport);
    const again = second.suggestion.request();
    controller.apply({ name: "setVisibility", target: { kind: "layer", id: "other" }, visible: false });
    release!(jsonResponse(envelope(revision, geometrySuggestion())));
    expect(await again).toEqual({ ok: false, reason: "The composition changed since the suggestion." });
    expect(second.onPreview).not.toHaveBeenCalled();
    expect(paintOf(controller.state.mapSpec as MapStyleDocument, "parcels")["fill-color"]).toBe("#112233");
  });

  it("refuses a credential or an unapproved style URL and a mismatched binding", async () => {
    const controller = controllerFor();
    const before = canonicalCompositionJson(controller.state);
    const poisoned = geometrySuggestion();
    (poisoned.mapLibreStyle.layers[0] as { paint: Record<string, unknown> }).paint["fill-color"] =
      "https://example.com/tiles?access_token=abc";
    const { onPreview, suggestion } = mount(
      controller,
      vi.fn(async () => jsonResponse(envelope(before, poisoned))),
    );
    expect(await suggestion.request()).toEqual({
      ok: false,
      reason: "The suggestion includes a credential or an unapproved style URL.",
    });
    expect(onPreview).not.toHaveBeenCalled();
    expect(canonicalCompositionJson(controller.state)).toBe(before);

    const mismatch = mount(
      controller,
      vi.fn(async () => jsonResponse(envelope(before, geometrySuggestion(), { principalId: "someone-else" }))),
    );
    expect(await mismatch.suggestion.request()).toEqual({
      ok: false,
      reason: "The suggestion does not match this principal, environment, layer, or draft.",
    });
    expect(mismatch.onPreview).not.toHaveBeenCalled();
  });

  it("discards the local preview and undo restores the inline style", async () => {
    const controller = controllerFor();
    const transport = vi.fn(async () =>
      jsonResponse(envelope(canonicalCompositionJson(controller.state), geometrySuggestion())),
    );
    const { onPreview, suggestion } = mount(controller, transport);
    expect((await suggestion.request()).ok).toBe(true);
    suggestion.discard();
    expect(onPreview).toHaveBeenLastCalledWith(undefined);
    expect(await suggestion.apply()).toEqual({ ok: false, reason: "There is no style suggestion to apply." });
    expect(controller.canUndo()).toBe(false);

    expect((await suggestion.request()).ok).toBe(true);
    expect((await suggestion.apply()).ok).toBe(true);
    expect(suggestion.undo()).toBe(true);
    expect(paintOf(controller.state.mapSpec as MapStyleDocument, "parcels")["fill-color"]).toBe("#112233");
    expect(controller.state.layers.find((layer) => layer.id === "parcels")?.styleRef).toBeUndefined();
  });

  it("previews the filter and layout that apply will persist", async () => {
    const controller = controllerFor();
    const suggestionBody = geometrySuggestion();
    const primary = suggestionBody.mapLibreStyle.layers[0] as Record<string, unknown>;
    primary.filter = ["==", ["get", "zoning"], "Residential"];
    primary.layout = { visibility: "none" };
    primary.minzoom = 4;
    const transport = vi.fn(async () =>
      jsonResponse(envelope(canonicalCompositionJson(controller.state), suggestionBody)),
    );
    const { onPreview, suggestion } = mount(controller, transport);
    expect((await suggestion.request()).ok).toBe(true);
    const preview = onPreview.mock.calls[0]?.[0] as MapStyleDocument;
    const previewLayer = (preview.layers as Record<string, unknown>[]).find((layer) => layer.id === "parcels");
    if (!previewLayer) throw new Error("The preview is missing the selected layer.");
    expect(previewLayer.filter).toEqual(["==", ["get", "zoning"], "Residential"]);
    expect(previewLayer.layout).toEqual({ visibility: "none" });
    expect(previewLayer.minzoom).toBe(4);
    expect(previewLayer.source).toBe("parcels");
    expect((await suggestion.apply()).ok).toBe(true);
    const inline = controller.state.styleRefs?.find((ref) => ref.styleId === "honua-inline:parcels");
    expect(inline?.body?.parcels).toMatchObject({
      filter: ["==", ["get", "zoning"], "Residential"],
      layout: { visibility: "none" },
      minzoom: 4,
      paint: { "fill-color": "#0b7285" },
    });
  });

  it("clears the active preview on retarget and refuses a renderer source override", async () => {
    const controller = controllerFor();
    const transport = vi.fn(async () =>
      jsonResponse(envelope(canonicalCompositionJson(controller.state), geometrySuggestion())),
    );
    const { onPreview, suggestion } = mount(controller, transport);
    expect((await suggestion.request()).ok).toBe(true);
    suggestion.retarget("other");
    expect(onPreview).toHaveBeenLastCalledWith(undefined);
    expect(await suggestion.apply()).toEqual({ ok: false, reason: "There is no style suggestion to apply." });

    const overridden = new CompositionController({
      ...createEmptyCompositionState(),
      layers: [
        {
          id: "parcels",
          sourceId: "parcels",
          type: "fill",
          title: "Parcels",
          visible: true,
          metadata: { honua: { source: { type: "geojson", data: { type: "FeatureCollection", features: [] } } } },
        },
      ],
      mapSpec: mapStyle(),
    });
    const blocked = vi.fn();
    const refused = mount(overridden, blocked);
    expect(await refused.suggestion.request()).toEqual({
      ok: false,
      reason: "This source is not an authorized catalog layer.",
    });
    expect(blocked).not.toHaveBeenCalled();
  });
});
