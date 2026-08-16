/**
 * The measurement maths behind the `scale` and `measure` controls. Checked
 * against known ground truth rather than against itself: a scale bar and a
 * distance readout are the two places in a GIS UI where being confidently
 * wrong is worst.
 */
import { describe, expect, it } from "vitest";

import {
  computeScaleBar,
  formatArea,
  formatDistance,
  haversineMeters,
  metersPerPixel,
  pathLengthMeters,
  ringAreaSquareMeters,
} from "../../src/controls/geodesy.js";

describe("controls/geodesy", () => {
  it("measures one degree of latitude as ~111 km", () => {
    const meters = haversineMeters({ lng: 0, lat: 0 }, { lng: 0, lat: 1 });
    expect(meters).toBeGreaterThan(111_000);
    expect(meters).toBeLessThan(111_400);
  });

  it("measures the Honolulu–Hilo great circle at ~338 km, matching a spherical reference to within a kilometre", () => {
    const meters = haversineMeters({ lng: -157.858, lat: 21.315 }, { lng: -155.089, lat: 19.72 });
    expect(meters / 1000).toBeGreaterThan(338);
    expect(meters / 1000).toBeLessThan(339);
  });

  it("has no length below two points and sums segments above", () => {
    expect(pathLengthMeters([])).toBe(0);
    expect(pathLengthMeters([{ lng: 0, lat: 0 }])).toBe(0);
    const two = pathLengthMeters([
      { lng: 0, lat: 0 },
      { lng: 0, lat: 1 },
    ]);
    const three = pathLengthMeters([
      { lng: 0, lat: 0 },
      { lng: 0, lat: 1 },
      { lng: 0, lat: 2 },
    ]);
    expect(three / two).toBeCloseTo(2, 2);
  });

  it("encloses nothing below three points, and closes the ring implicitly above", () => {
    expect(ringAreaSquareMeters([{ lng: 0, lat: 0 }])).toBe(0);
    // A 1° x 1° box at the equator is ~12 300 km².
    const area = ringAreaSquareMeters([
      { lng: 0, lat: 0 },
      { lng: 1, lat: 0 },
      { lng: 1, lat: 1 },
      { lng: 0, lat: 1 },
    ]);
    expect(area / 1_000_000).toBeGreaterThan(12_000);
    expect(area / 1_000_000).toBeLessThan(12_400);
  });

  it("is orientation-independent — a ring wound the other way is the same area", () => {
    const clockwise = [
      { lng: 0, lat: 0 },
      { lng: 1, lat: 0 },
      { lng: 1, lat: 1 },
    ];
    expect(ringAreaSquareMeters(clockwise)).toBeCloseTo(ringAreaSquareMeters([...clockwise].reverse()), 0);
  });

  it("picks the sub-unit a reader expects", () => {
    expect(formatDistance(250, "metric")).toBe("250 m");
    expect(formatDistance(2500, "metric")).toBe("2.5 km");
    expect(formatDistance(250, "imperial")).toContain("ft");
    expect(formatDistance(5000, "imperial")).toContain("mi");
    expect(formatArea(500, "metric")).toBe("500 m²");
    expect(formatArea(5_000_000, "metric")).toBe("5 km²");
    expect(formatArea(50_000, "imperial")).toContain("acres");
  });

  it("shrinks ground-per-pixel with zoom and with latitude", () => {
    expect(metersPerPixel(0, 1)).toBeCloseTo(metersPerPixel(0, 0) / 2, 5);
    expect(metersPerPixel(60, 0)).toBeLessThan(metersPerPixel(0, 0));
  });

  describe("computeScaleBar", () => {
    it("returns nothing at all when the camera cannot be read — better than a bar drawn from a guess", () => {
      expect(computeScaleBar(undefined, 120, "metric")).toBeUndefined();
      expect(computeScaleBar({ zoom: Number.NaN, center: [0, 0] }, 120, "metric")).toBeUndefined();
    });

    it("never draws wider than asked, and labels a round number", () => {
      for (const zoom of [0, 4, 8, 12, 16, 20]) {
        const bar = computeScaleBar({ zoom, center: [-157.8, 21.3] }, 120, "metric");
        expect(bar).toBeDefined();
        if (!bar) continue;
        expect(bar.widthPx).toBeGreaterThan(0);
        expect(bar.widthPx).toBeLessThanOrEqual(120);
        expect(bar.label).toMatch(/^(1|2|3|5)0*(\.\d+)?\s(m|km)$/);
      }
    });

    it("switches units on request", () => {
      const bar = computeScaleBar({ zoom: 10, center: [-157.8, 21.3] }, 120, "imperial");
      expect(bar?.label).toMatch(/(ft|mi)$/);
    });
  });
});
