import { describe, expect, it } from "vitest";

import { basemapPaletteFor, createGraticule, createOfflineBasemapStyle } from "../../src/map/basemap.js";
import { BASEMAP_ID_PREFIX } from "../../src/map/constants.js";

/** Walks every string in the style looking for something that would hit the network at runtime (REQ-003). */
function externalUrls(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") {
    if (/^(https?:)?\/\//.test(value)) found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const entry of value) externalUrls(entry, found);
    return found;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) externalUrls(entry, found);
  }
  return found;
}

describe("the vendored offline basemap (honua-studio#23 REQ-003)", () => {
  it("fetches nothing: no CDN URL, no sprite, no glyphs", () => {
    const style = createOfflineBasemapStyle();
    expect(externalUrls(style)).toEqual([]);
    expect(style.sprite).toBeUndefined();
    expect(style.glyphs).toBeUndefined();
  });

  it("carries its land geometry inline, credited to Natural Earth", () => {
    const style = createOfflineBasemapStyle();
    const land = style.sources[`${BASEMAP_ID_PREFIX}land`] as unknown as {
      data?: { features?: unknown[] };
      attribution?: string;
    };
    expect(land.data?.features).toHaveLength(1);
    expect(land.attribution).toContain("Natural Earth");
  });

  it("includes Hawaiʻi — the fixture journey composes there, so a basemap that omitted it would be useless", () => {
    const style = createOfflineBasemapStyle();
    const land = style.sources[`${BASEMAP_ID_PREFIX}land`] as unknown as {
      data: { features: { geometry: { coordinates: number[][][][] } }[] };
    };
    const polygons = land.data.features[0]?.geometry.coordinates ?? [];
    const oahu = polygons.some((polygon) =>
      (polygon[0] ?? []).some(([longitude, latitude]) => {
        return (
          longitude !== undefined &&
          latitude !== undefined &&
          longitude > -158.4 &&
          longitude < -157.6 &&
          latitude > 21.2 &&
          latitude < 21.8
        );
      }),
    );
    expect(oahu).toBe(true);
  });

  it("namespaces every layer and source so a composition layer can never collide with basemap furniture", () => {
    const style = createOfflineBasemapStyle();
    expect(style.layers.every((layer) => layer.id.startsWith(BASEMAP_ID_PREFIX))).toBe(true);
    expect(Object.keys(style.sources).every((id) => id.startsWith(BASEMAP_ID_PREFIX))).toBe(true);
  });

  it("switches palettes for the dark theme without changing structure", () => {
    const light = createOfflineBasemapStyle({ theme: "light" });
    const dark = createOfflineBasemapStyle({ theme: "dark" });
    expect(dark.layers.map((layer) => layer.id)).toEqual(light.layers.map((layer) => layer.id));
    expect(dark.layers[0]?.paint?.["background-color"]).toBe(basemapPaletteFor("dark").water);
    expect(light.layers[0]?.paint?.["background-color"]).toBe(basemapPaletteFor("light").water);
  });

  it("omits the graticule entirely when its step is 0", () => {
    const style = createOfflineBasemapStyle({ graticuleStepDegrees: 0 });
    expect(style.layers.some((layer) => layer.id === `${BASEMAP_ID_PREFIX}graticule`)).toBe(false);
    expect(style.sources[`${BASEMAP_ID_PREFIX}graticule`]).toBeUndefined();
  });

  it("generates a deterministic graticule clamped inside Web Mercator's valid latitudes", () => {
    const first = createGraticule(30);
    expect(JSON.stringify(createGraticule(30))).toBe(JSON.stringify(first));
    const latitudes = first.geometry.coordinates.flat().map(([, latitude]) => latitude as number);
    expect(Math.max(...latitudes)).toBeLessThanOrEqual(85);
    expect(Math.min(...latitudes)).toBeGreaterThanOrEqual(-85);
  });
});
