import { describe, expect, it, vi } from "vitest";
import type { AuthSession } from "../../src/auth/types.js";
import type { CompositionMapFactoryOptions, CompositionMapLike } from "../../src/map/composition-map-view.js";
import { type SharedStylePreviewOptions, createSharedStylePreview } from "../../src/styles/shared-style-preview.js";
const document = {
  version: 8,
  sources: { catalog: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
  layers: [{ id: "catalog-fill", type: "fill", source: "catalog", paint: { "fill-color": "#003366" } }],
};
const source = {
  id: "service/0",
  title: "Parcels",
  protocol: "geoservices-feature-service",
  geometryType: "Polygon",
  locator: { serviceId: "service", layerId: 0, url: "https://honua.test/rest/services/Parcels/FeatureServer/0" },
};
function setup(extra: Partial<SharedStylePreviewOptions> = {}) {
  let auth = { getAccessToken: async () => undefined } as AuthSession;
  const map = { setStyle: vi.fn(), remove: vi.fn() } as unknown as CompositionMapLike;
  const factory = vi.fn(async (_options: CompositionMapFactoryOptions) => map);
  const status = vi.fn();
  const describeSource = vi.fn(async () => [{ name: "district", type: "String" }]);
  const preview = createSharedStylePreview({
    container: {} as HTMLElement,
    consumer: { kind: "source", source, catalogSourceId: "catalog" },
    styleId: "district",
    document,
    getAuth: () => auth,
    sourceBaseUrl: "https://honua.test",
    documentUrl: "https://console.test/",
    mapFactory: factory,
    styleProvider: { read: vi.fn(), describeSource },
    onStatus: status,
    ...extra,
  });
  return {
    preview,
    factory,
    map,
    status,
    describeSource,
    replaceAuth() {
      auth = { getAccessToken: async () => undefined } as AuthSession;
    },
  };
}
describe("read-only shared-style preview", () => {
  it("keeps the derived preview across same-authority transport renewal", async () => {
    const context = setup({ getAuthority: () => "same-workspace-binding" });
    await context.preview.preview();
    context.replaceAuth();
    await context.preview.preview();
    expect(context.factory).toHaveBeenCalledOnce();
    expect(context.map.setStyle).toHaveBeenCalledOnce();
    expect(context.map.remove).not.toHaveBeenCalled();
  });

  it("uses only the explicitly selected actual source and existing authenticated renderer", async () => {
    const context = setup();
    await context.preview.preview();
    const options = context.factory.mock.calls[0]![0];
    expect(options.style.sources.catalog).toMatchObject({
      type: "geojson",
      data: expect.stringContaining("/FeatureServer/0/query"),
    });
    expect(options.getAuth).toBeTypeOf("function");
    expect(await context.preview.getFields("catalog")).toEqual([{ name: "district", type: "String" }]);
    expect(context.describeSource).toHaveBeenCalledWith(source);
    await expect(context.preview.getFields("another-source")).rejects.toThrow("unambiguous authorized source");
    context.preview.dispose();
    expect(context.map.remove).toHaveBeenCalledOnce();
  });
  it("refuses editor source retargeting before constructing a map", async () => {
    const context = setup();
    await expect(
      context.preview.preview({
        ...document,
        sources: { catalog: { type: "geojson", data: "https://foreign.test/data" } },
      }),
    ).rejects.toThrow("protected style member");
    expect(context.factory).not.toHaveBeenCalled();
  });
  it("does not adopt a renderer created after its authority changed", async () => {
    let resolve!: (map: CompositionMapLike) => void;
    const pending = new Promise<CompositionMapLike>((done) => {
      resolve = done;
    });
    const factory = vi.fn((_options: CompositionMapFactoryOptions) => pending);
    const context = setup({ mapFactory: factory });
    const creating = context.preview.preview();
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    context.replaceAuth();
    resolve(context.map);
    await creating;
    expect(context.map.remove).toHaveBeenCalledOnce();
    expect(context.status).not.toHaveBeenCalled();
  });
  it("coalesces pending previews and never uses a prior retained map", async () => {
    const context = setup();
    const first = context.preview.preview();
    const latest = context.preview.preview({
      ...document,
      layers: [{ ...document.layers[0], paint: { "fill-color": "#ff0000" } }],
    });
    await Promise.all([first, latest]);
    expect(context.factory).toHaveBeenCalledOnce();
    expect(context.factory.mock.calls[0]![0].style.layers[0]?.paint?.["fill-color"]).toBe("#ff0000");
  });
});
