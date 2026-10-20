import { describe, expect, it, vi } from "vitest";

import type {
  CompositionMapFactory,
  CompositionMapFactoryOptions,
  CompositionMapLike,
} from "../../src/map/composition-map-view.js";
import { createReadOnlyMapCanvas } from "../../src/map/read-only-map-canvas.js";

const catalog = [
  {
    id: "service/1",
    title: "Parcels",
    protocol: "geoservices-feature-service",
    geometryType: "GeometryCollection",
    locator: { serviceId: "service", layerId: 1, url: "/rest/services/parcels/FeatureServer" },
  },
];

function body() {
  return {
    layers: [{ id: "parcels", sourceId: "service/1", type: "fill", visible: true }],
    view: { center: [-157.85, 21.3], zoom: 10 },
  };
}

function mapHarness() {
  const captured: CompositionMapFactoryOptions[] = [];
  const remove = vi.fn();
  const map: CompositionMapLike = {
    setStyle: vi.fn(),
    jumpTo: vi.fn(),
    easeTo: vi.fn(),
    fitBounds: vi.fn(),
    on: vi.fn(),
    resize: vi.fn(),
    remove,
    queryRenderedFeatures: (_point, options) => (options?.layers?.includes("parcels") ? [{ id: 1 }] : []),
  };
  const factory: CompositionMapFactory = async (options) => {
    captured.push(options);
    return map;
  };
  return { captured, factory, remove };
}

const container = {} as HTMLElement;

describe("read-only map canvas", () => {
  it("uses the active renderer and bounded anonymous transport without a synthetic editor session", async () => {
    const harness = mapHarness();
    const canvas = await createReadOnlyMapCanvas({
      container,
      body: body(),
      projection: { catalog, baseUrl: "/api" },
      mapFactory: harness.factory,
    });
    expect(canvas.status).toBe("ready");
    expect(canvas.projection?.unresolved).toEqual([]);
    expect(canvas.projection?.renderedLayerIds).toContain("parcels");
    expect(canvas.renderedFeatureCount).toBe(1);
    expect(harness.captured[0].getAuth).toBeTypeOf("function");
    expect(harness.captured[0].getAuth?.()).toBeUndefined();
    expect(canvas).not.toHaveProperty("controller");
    canvas.dispose();
  });

  it("keeps the requested immutable snapshot when the caller edits its object during startup", async () => {
    const original = body();
    const harness = mapHarness();
    const pending = createReadOnlyMapCanvas({
      container,
      body: original,
      projection: { catalog },
      mapFactory: harness.factory,
    });
    original.layers[0].sourceId = "different/2";
    const canvas = await pending;
    expect(canvas.projection?.unresolved).toEqual([]);
    expect(canvas.projection?.renderedLayerIds).toContain("parcels");
    canvas.dispose();
  });

  it("does not retarget a pending render when another view changes its source locator", async () => {
    const descriptors = structuredClone(catalog);
    const harness = mapHarness();
    const pending = createReadOnlyMapCanvas({
      container,
      body: body(),
      projection: { catalog: descriptors },
      mapFactory: harness.factory,
    });
    descriptors[0].locator.url = "/rest/services/different/FeatureServer";
    const canvas = await pending;
    expect(canvas.projection?.mapPackage.sourceBindings?.[0]?.locator.url).toBe(
      "/rest/services/parcels/FeatureServer/1",
    );
    const style = JSON.stringify(harness.captured[0].style);
    expect(style).toContain("parcels");
    expect(style).not.toContain("different");
    canvas.dispose();
  });

  it.each([null, { mapSpec: { layers: [] } }, { layers: "not-an-array" }])(
    "refuses an incompatible body before rendering instead of displaying an empty replacement",
    async (invalid) => {
      const harness = mapHarness();
      await expect(
        createReadOnlyMapCanvas({ container, body: invalid, mapFactory: harness.factory }),
      ).rejects.toThrow();
      expect(harness.captured).toEqual([]);
    },
  );

  it("refuses a missing canonical style reader rather than silently substituting a preset", async () => {
    const harness = mapHarness();
    const original = { ...body(), layers: [{ ...body().layers[0], styleRef: "parcels-style" }] };
    await expect(
      createReadOnlyMapCanvas({
        container,
        body: original,
        projection: { catalog },
        mapFactory: harness.factory,
      }),
    ).rejects.toThrow("authoritative style reader");
    expect(harness.captured).toEqual([]);
  });

  it("reports renderer failure without claiming a ready map or rendered features", async () => {
    const canvas = await createReadOnlyMapCanvas({
      container,
      body: body(),
      projection: { catalog },
      mapFactory: async () => {
        throw new Error("WebGL unavailable");
      },
    });
    expect(canvas.status).toBe("unavailable");
    expect(canvas.statusDetail).toBe("WebGL unavailable");
    expect(canvas.renderedFeatureCount).toBe(0);
    canvas.dispose();
  });

  it("releases the audience canvas on disposal and stops reporting features from its old map", async () => {
    const harness = mapHarness();
    const canvas = await createReadOnlyMapCanvas({
      container,
      body: body(),
      projection: { catalog },
      mapFactory: harness.factory,
    });
    expect(canvas.renderedFeatureCount).toBe(1);
    canvas.dispose();
    expect(harness.remove).toHaveBeenCalledOnce();
    expect(canvas.renderedFeatureCount).toBe(0);
    expect(canvas.status).toBe("idle");
  });
});
