import { describe, expect, it, vi } from "vitest";
import type { CompositionMapFactoryOptions, CompositionMapLike } from "../../src/map/composition-map-view.js";
import { createReadOnlyMapCanvas } from "../../src/map/read-only-map-canvas.js";
import { AudienceStyleProvider, audienceStyleRevision } from "../../src/styles/audience-style-provider.js";
import { styleContentHash } from "../../src/styles/authoritative-style-provider.js";

const source = {
  id: "internal%2Fservice/7",
  protocol: "geoservices-feature-service",
  geometryType: "Polygon",
  locator: {
    serviceId: "internal/service",
    layerId: 7,
    url: "https://console.test/api/studio/viewer/data/rest/services/Parcels/FeatureServer",
  },
};
const stylesheet = {
  version: 8,
  name: "Districts",
  sources: { canonical: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
  layers: [
    {
      id: "district-fill",
      type: "fill",
      source: "canonical",
      paint: { "fill-color": ["match", ["get", "district"], "North", "#003366", "#ddaa22"] },
    },
  ],
};
const metadata = {
  id: 7,
  geometryType: "esriGeometryPolygon",
  fields: [{ name: "district", type: "esriFieldTypeString" }],
};

function fixture(options: { tag?: string | null; descriptor?: unknown; sheet?: unknown } = {}) {
  const token = vi.fn(async () => "must-never-be-requested");
  const fetchRequest = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === "https://console.test/api/studio/viewer/styles/district") {
      const headers = new Headers({ "content-type": "application/vnd.mapbox.style+json" });
      if (options.tag !== null) headers.set("etag", options.tag ?? '"style-v7"');
      return new Response(JSON.stringify(options.sheet ?? stylesheet), { headers });
    }
    if (url === `${source.locator.url}/7`)
      return new Response(JSON.stringify(options.descriptor ?? metadata), {
        headers: { "content-type": "application/json" },
      });
    throw new Error(`Unexpected audience endpoint: ${url}`);
  });
  let transport = { fetchRequest, getAccessToken: token };
  const provider = new AudienceStyleProvider({
    styleBaseUrl: "/api/studio/viewer/styles",
    documentUrl: "https://console.test/maps/published/districts",
    catalog: [source],
    getTransport: () => transport,
  });
  return {
    provider,
    fetchRequest,
    token,
    replaceTransport() {
      transport = { fetchRequest, getAccessToken: vi.fn(token) };
    },
  };
}

describe("current-reader audience style provider", () => {
  it("does not acquire the reader transport for a canvas whose only styled source is denied", async () => {
    const getTransport = vi.fn(() => { throw new Error("Denied layer attempted an authority lookup."); });
    const provider = new AudienceStyleProvider({
      styleBaseUrl: "/api/studio/viewer/styles", documentUrl: "https://console.test/", catalog: [], getTransport,
    });
    const map: CompositionMapLike = {
      setStyle: vi.fn(), jumpTo: vi.fn(), easeTo: vi.fn(), fitBounds: vi.fn(), on: vi.fn(), off: vi.fn(), resize: vi.fn(), remove: vi.fn(),
    };
    const canvas = await createReadOnlyMapCanvas({
      container: {} as HTMLElement,
      body: { layers: [{ id: "denied", sourceId: source.id, type: "fill", visible: true, styleRef: "district" }], view: {} },
      projection: { catalog: [] }, styleProvider: provider, mapFactory: async () => map,
    });
    expect(canvas.projection?.renderedLayerIds).toEqual([]);
    expect(canvas.statusDetail).toContain("denied");
    expect(getTransport).not.toHaveBeenCalled();
    canvas.dispose();
  });

  it("binds the actual stylesheet revision to current layer metadata through two bounded host GETs", async () => {
    const current = fixture();
    const binding = await current.provider.bind("district", source);
    expect(binding.definition.styleVersion).toBe(7);
    expect(binding.definition.sha256).toBe(await styleContentHash(JSON.stringify(stylesheet)));
    expect(binding.definition.title).toBe("Districts");
    expect(binding.sourceId).toBe(source.id);
    expect(binding.stylesheetLayerId).toBe("district-fill");
    expect(binding.override.paint).toEqual(stylesheet.layers[0]?.paint);
    expect(binding.override.metadata).toMatchObject({ "honua:styleId": "district", "honua:styleVersion": 7 });
    expect(binding.descriptorBody).toContain('"id":7');
    expect(binding.fields).toEqual(["district"]);
    expect(current.fetchRequest).toHaveBeenCalledTimes(2);
    for (const [input, init] of current.fetchRequest.mock.calls) {
      expect(String(input)).not.toContain("/mcp");
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error", cache: "no-store" });
      expect(init?.body).toBeUndefined();
      const headers = new Headers(init?.headers);
      expect(headers.has("Authorization")).toBe(false);
      expect(headers.has("Cookie")).toBe(false);
      expect(headers.has("X-API-Key")).toBe(false);
      expect(headers.has("If-Match")).toBe(false);
    }
    expect(current.token).not.toHaveBeenCalled();
  });

  it("retains canonical map-layer mappings and validates thematic fields against the actual metadata", async () => {
    const current = fixture();
    const binding = await current.provider.bind("district", source, {
      primaryTargetId: "parcels",
      layerBindings: [{ targetLayerId: "parcels", styleLayerId: "district-fill", layerType: "fill" }],
    });
    expect(binding.mappedBody?.parcels?.paint).toEqual(stylesheet.layers[0]?.paint);
    expect(binding.mappedBody?.parcels?.metadata).toMatchObject({ "honua:styleVersion": 7 });
    await expect(
      fixture({ descriptor: { ...metadata, fields: [{ name: "other" }] } }).provider.bind("district", source),
    ).rejects.toThrow('missing field "district"');
  });

  it("accepts the real v0 revision without fabricating a revision for a missing token", async () => {
    expect((await fixture({ tag: '"style-v0"' }).provider.read("district")).styleVersion).toBe(0);
    await expect(fixture({ tag: null }).provider.read("district")).rejects.toThrow("canonical revision");
  });

  it("renders a nonembedded published shared style through the existing read-only canvas", async () => {
    const current = fixture();
    let captured: CompositionMapFactoryOptions | undefined;
    const map: CompositionMapLike = {
      setStyle: vi.fn(),
      jumpTo: vi.fn(),
      easeTo: vi.fn(),
      fitBounds: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      resize: vi.fn(),
      remove: vi.fn(),
    };
    const body = {
      layers: [{ id: "parcels", sourceId: source.id, type: "fill", visible: true, styleRef: "district" }],
      view: { center: [-157.85, 21.3], zoom: 10 },
    };
    const original = structuredClone(body);
    const canvas = await createReadOnlyMapCanvas({
      container: {} as HTMLElement,
      body,
      projection: { catalog: [source] },
      styleProvider: current.provider,
      mapFactory: async (options) => {
        captured = options;
        return map;
      },
    });
    expect(canvas.status).toBe("ready");
    expect(captured?.style.layers.find((layer) => layer.id === "parcels")?.paint).toMatchObject(
      stylesheet.layers[0]?.paint ?? {},
    );
    expect(body).toEqual(original);
    expect(current.token).not.toHaveBeenCalled();
    canvas.dispose();
    expect(map.remove).toHaveBeenCalledOnce();
  });

  it.each([null, 'W/"style-v7"', '"style-version-7"', '"style-v07"', '"style-v-1"', '"style-v2147483648"', "*"])(
    "refuses unsupported revision tokens: %s",
    (tag) => {
      expect(() => audienceStyleRevision(tag)).toThrow("canonical revision");
    },
  );

  it("uses the discovered locator for a unique legacy service alias", async () => {
    const current = fixture();
    const binding = await current.provider.bind("district", { ...source, id: source.locator.serviceId });
    expect(binding.sourceId).toBe(source.locator.serviceId);
    expect(current.fetchRequest.mock.calls[1]?.[0]).toBe(`${source.locator.url}/7`);
  });

  it("refuses denied and replaced locators before any session or network lookup", async () => {
    const current = fixture();
    const getTransport = vi.fn(() => ({ fetchRequest: current.fetchRequest }));
    const provider = new AudienceStyleProvider({
      styleBaseUrl: "/api/studio/viewer/styles",
      documentUrl: "https://console.test/",
      catalog: [source],
      getTransport,
    });
    await expect(provider.bind("district", { ...source, id: "hidden/9" })).rejects.toThrow("current-reader catalog");
    await expect(
      provider.bind("district", {
        ...source,
        locator: { ...source.locator, url: "https://other.test/rest/services/Parcels/FeatureServer" },
      }),
    ).rejects.toThrow("current-reader catalog");
    expect(getTransport).not.toHaveBeenCalled();
    expect(current.fetchRequest).not.toHaveBeenCalled();
    expect(current.token).not.toHaveBeenCalled();
  });

  it.each([
    { ...metadata, id: 8 },
    { ...metadata, geometryType: "esriGeometryPoint" },
    { ...metadata, fields: [{ name: "district" }, { name: "district" }] },
    { ...metadata, fields: [{ name: "" }] },
    { error: { code: 403, message: "Unavailable" } },
  ])("refuses incompatible live source metadata", async (descriptor) => {
    await expect(fixture({ descriptor }).provider.bind("district", source)).rejects.toThrow();
  });

  it("rejects late replies under another viewer identity", async () => {
    const current = fixture();
    current.fetchRequest.mockImplementationOnce(async () => {
      current.replaceTransport();
      return new Response(JSON.stringify(stylesheet), { headers: { etag: '"style-v7"' } });
    });
    await expect(current.provider.bind("district", source)).rejects.toThrow("viewer authority changed");
    expect(current.fetchRequest).toHaveBeenCalledTimes(1);
    expect(current.token).not.toHaveBeenCalled();
  });

  it("rejects a reader change during the subsequent layer metadata read", async () => {
    const current = fixture();
    const read = current.fetchRequest.getMockImplementation()!;
    current.fetchRequest.mockImplementation(async (input, init) => {
      const response = await read(input, init);
      if (String(input) === `${source.locator.url}/7`) current.replaceTransport();
      return response;
    });
    await expect(current.provider.bind("district", source)).rejects.toThrow("viewer authority changed");
    expect(current.fetchRequest).toHaveBeenCalledTimes(2);
  });

  it("rejects a reader change while the stylesheet fingerprint is computed", async () => {
    const current = fixture();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (algorithm, bytes) => {
      const value = await digest(algorithm, bytes);
      current.replaceTransport();
      return value;
    });
    try {
      await expect(current.provider.bind("district", source)).rejects.toThrow("viewer authority changed");
      expect(current.fetchRequest).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    "https://other.test/rest/services/Parcels/FeatureServer",
    "blob:https://console.test/rest/services/Parcels/FeatureServer",
    `${source.locator.url}/8`,
    `${source.locator.url}?key=private`,
    `${source.locator.url}#fragment`,
    "https://reader:password@console.test/rest/services/Parcels/FeatureServer",
  ])("refuses malformed or foreign current-catalog locators before transport: %s", async (url) => {
    const changed = { ...source, locator: { ...source.locator, url } };
    const getTransport = vi.fn(() => ({ fetchRequest: vi.fn() as typeof fetch }));
    const provider = new AudienceStyleProvider({
      styleBaseUrl: "/api/studio/viewer/styles",
      documentUrl: "https://console.test/",
      catalog: [changed],
      getTransport,
    });
    await expect(provider.bind("district", changed)).rejects.toThrow("metadata route");
    expect(getTransport).not.toHaveBeenCalled();
  });

  it("encodes a style ID using the canonical server path encoding", async () => {
    const current = fixture();
    current.fetchRequest.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify(stylesheet), {
          headers: { etag: '"style-v7"' },
        }),
    );
    await current.provider.read("district!'()*");
    expect(current.fetchRequest.mock.calls[0]?.[0]).toBe(
      "https://console.test/api/studio/viewer/styles/district%21%27%28%29%2A",
    );
  });

  it.each(["", "..", "../other", "district%2Fprivate", "district\n"])(
    "rejects invalid style identifiers before transport: %s",
    async (styleId) => {
      const current = fixture();
      await expect(current.provider.read(styleId)).rejects.toThrow("identifier is invalid");
      expect(current.fetchRequest).not.toHaveBeenCalled();
    },
  );

  it("rejects oversized streaming styles and cancels their body", async () => {
    const current = fixture();
    const cancel = vi.fn();
    current.fetchRequest.mockImplementationOnce(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(256 * 1024 + 1));
            },
            cancel,
          }),
          { headers: { etag: '"style-v7"' } },
        ),
    );
    await expect(current.provider.read("district")).rejects.toThrow("size limit");
    expect(cancel).toHaveBeenCalled();
  });

  it("requires a host transport and never falls back to a global network client", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch");
    try {
      const provider = new AudienceStyleProvider({
        styleBaseUrl: "/api/studio/viewer/styles",
        documentUrl: "https://console.test/",
        catalog: [source],
        getTransport: () => undefined,
      });
      await expect(provider.read("district")).rejects.toThrow("transport is unavailable");
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      globalFetch.mockRestore();
    }
  });
});
