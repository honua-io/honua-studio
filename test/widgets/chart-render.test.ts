/**
 * The bounded SVG renderer (honua-studio#24 REQ-004's documented trade).
 *
 * These assert structure and accessibility rather than pixels: which mark was
 * drawn, that every datum is reachable as a `<title>` tooltip, and that the
 * chart carries a text equivalent. A chart that draws but cannot be read is
 * not a rendered chart.
 */
import { describe, expect, it } from "vitest";

import type { CompositionWidget } from "../../src/composition/model.js";
import { chartSeriesFromSpec } from "../../src/widgets/chart-data.js";
import { renderChartSvg, specMark } from "../../src/widgets/chart-render.js";
import { compositionChartSpec } from "../../src/widgets/chart-spec.js";

const ROWS = [
  { zoning_code: "R-5", district: "Honolulu" },
  { zoning_code: "R-5", district: "Honolulu" },
  { zoning_code: "B-2", district: "ʻEwa" },
];

function render(config: Record<string, unknown>, rows: ReadonlyArray<Record<string, unknown>> = ROWS) {
  const widget: CompositionWidget = { id: "chart-1", kind: "chart", sourceId: "hi-parcels", config };
  const result = compositionChartSpec(widget, rows);
  if (!result.ok) throw new Error(result.reason);
  return { ...renderChartSvg(result.spec, chartSeriesFromSpec(result.spec)), mark: specMark(result.spec) };
}

describe("widgets/chart-render", () => {
  it("draws a bar per category, each with its own tooltip", () => {
    const { svg, mark } = render({ groupBy: "zoning_code" });
    expect(mark).toBe("bar");
    expect(svg.match(/<rect class="widget-chart-bar"/g)).toHaveLength(2);
    expect(svg).toContain("R-5: 2");
    expect(svg).toContain("B-2: 1");
  });

  it("draws a polyline with a vertex per instant for a line chart", () => {
    const rows = [{ permit_date: "2019-01-01" }, { permit_date: "2020-01-01" }, { permit_date: "2021-01-01" }];
    const { svg } = render({ groupBy: "permit_date", chartType: "line" }, rows);
    expect(svg).toContain("<polyline");
    expect(svg.match(/<circle class="widget-chart-vertex"/g)).toHaveLength(3);
  });

  it("draws one arc per slice, with its share, plus a legend", () => {
    const { svg, mark } = render({ groupBy: "zoning_code", chartType: "pie" });
    expect(mark).toBe("arc");
    expect(svg.match(/<path class="widget-chart-slice"/g)).toHaveLength(2);
    expect(svg).toContain("(67%)");
  });

  it("draws a single all-of-it slice as a full circle rather than nothing", () => {
    const { svg } = render({ groupBy: "district", chartType: "pie" }, [{ district: "Honolulu" }]);
    // A one-slice pie whose start and end points coincide degenerates to an
    // empty path unless it is drawn as two half-circles.
    expect(svg.match(/A \d/g)?.length).toBeGreaterThanOrEqual(2);
    expect(svg).toContain("(100%)");
  });

  it("is a scalable, labelled image with a text equivalent", () => {
    const { svg, summary } = render({ groupBy: "zoning_code" });
    expect(svg).toContain('viewBox="0 0 320 180"');
    expect(svg).toContain('role="img"');
    expect(svg).toContain("<title>");
    expect(svg).toContain("<desc>");
    expect(summary).toContain("bar chart of Count by zoning_code");
    expect(summary).toContain("R-5 2");
  });

  it("escapes category labels rather than injecting them as markup", () => {
    const { svg } = render({ groupBy: "district" }, [{ district: "<script>x</script>" }]);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&#60;");
  });

  it("renders an empty but valid chart when nothing matched", () => {
    const { svg, summary } = render({ groupBy: "district" }, [{}]);
    expect(svg).toContain("</svg>");
    expect(summary).toBe("No rows matched this chart's grouping.");
  });

  it("is deterministic — the same spec and rows always produce the same markup", () => {
    expect(render({ groupBy: "zoning_code" }).svg).toBe(render({ groupBy: "zoning_code" }).svg);
  });
});
