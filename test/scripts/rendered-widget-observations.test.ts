// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  collectRenderedWidgetObservations,
  requireRenderedWidgetData,
} from "../../scripts/lib/rendered-widget-observations.mjs";

function mount(markup: string) {
  const canvas = document.createElement("honua-studio-canvas");
  const deck = document.createElement("div");
  const shadowRoot = deck.attachShadow({ mode: "open" });
  shadowRoot.innerHTML = markup;
  Object.assign(canvas, { widgetDeck: deck });
  document.body.append(canvas);
}
const widgets = [{ id: "chart", kind: "chart", sourceId: "parcels" }];
afterEach(() => {
  document.body.innerHTML = "";
});
describe("actual rendered widget observations", () => {
  it("rejects the real unauthorized card shape even with no browser console error", () => {
    mount(
      '<article data-testid="studio-widget" data-widget-id="chart"><p data-testid="studio-widget-status">Source "parcels" did not return a GeoJSON FeatureCollection.</p></article>',
    );
    const observed = collectRenderedWidgetObservations(widgets);
    expect(observed[0]).toMatchObject({ state: "error", renderedMarkCount: 0 });
    expect(() => requireRenderedWidgetData(observed)).toThrow("FeatureCollection");
  });
  it("retains actual SVG mark values and accepts a rendered chart", () => {
    mount(
      '<article data-testid="studio-widget" data-widget-id="chart"><figure data-testid="studio-widget-chart"><svg><rect class="widget-chart-bar"><title>R-5: 6</title></rect></svg></figure><p data-testid="studio-widget-chart-summary">6 parcels</p></article>',
    );
    const observed = collectRenderedWidgetObservations(widgets);
    expect(observed[0]).toMatchObject({
      state: "ready",
      renderedMarkCount: 1,
      renderedValues: ["R-5: 6"],
      chartSummary: "6 parcels",
    });
    expect(() => requireRenderedWidgetData(observed)).not.toThrow();
  });
  it("does not pass a blank SVG, missing card, or pending load as rendered data", () => {
    mount(
      '<article data-testid="studio-widget" data-widget-id="chart"><figure data-testid="studio-widget-chart"><svg></svg></figure></article>',
    );
    expect(() => requireRenderedWidgetData(collectRenderedWidgetObservations(widgets))).toThrow();
    expect(() =>
      requireRenderedWidgetData(collectRenderedWidgetObservations([{ id: "missing", kind: "table" }])),
    ).toThrow();
  });
  it("accepts actual grid rows with bounded-result status and retains cell values", () => {
    mount(
      '<article data-testid="studio-widget" data-widget-id="grid"><table><tbody><tr data-testid="studio-widget-grid-row"><td role="gridcell">R-5</td></tr></tbody></table><p data-testid="studio-widget-status">Showing the first 500 features — the request is bounded.</p></article>',
    );
    const observed = collectRenderedWidgetObservations([{ id: "grid", kind: "table", sourceId: "parcels" }]);
    expect(observed[0]).toMatchObject({ state: "ready", renderedRowCount: 1, tableCells: ["R-5"] });
    expect(() => requireRenderedWidgetData(observed)).not.toThrow();
  });
});
