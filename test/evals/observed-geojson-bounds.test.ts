import { describe, expect, it } from "vitest";
import { observedGeoJsonBounds } from "../../scripts/lib/observed-geojson-bounds.mjs";
const collection = (coordinates: unknown) => ({
  type: "FeatureCollection",
  features: [{ type: "Feature", geometry: { type: "Polygon", coordinates } }],
});
describe("diagnostic bounds from observed GeoJSON", () => {
  it("derives the real polygon bounds independently of an incorrect bbox member", () => {
    expect(
      observedGeoJsonBounds({
        ...collection([
          [
            [-157.87, 21.3],
            [-157.86, 21.31],
            [-157.87, 21.3],
          ],
        ]),
        bbox: [0, 0, 1, 1],
      }),
    ).toEqual([-157.87, 21.3, -157.86, 21.31]);
  });
  it.each([
    collection([[[500, 100]]]),
    collection([]),
    { ...collection([[[0, 0]]]), crs: { name: "EPSG:3857" } },
    { type: "FeatureCollection", features: Array(2001).fill(null) },
  ])("refuses unknown CRS, invalid or unbounded observations", (value) => {
    expect(() => observedGeoJsonBounds(value)).toThrow();
  });
});
