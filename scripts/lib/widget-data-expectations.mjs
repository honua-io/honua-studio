/** Bind browser evidence to the exact request made by this widget resolver in this run. */
export function bindWidgetFeatureResponse(url, requests) {
  const matches = requests.filter((entry) => entry.method === "GET" && entry.browserUrl === url);
  const latest = matches.at(-1);
  if (!latest || latest.status !== 200) throw new Error("The widget's exact current query has no successful response.");
  const collection = JSON.parse(latest.response);
  if (collection?.type !== "FeatureCollection" || !Array.isArray(collection.features))
    throw new Error("The widget's exact query did not return a FeatureCollection.");
  const successful = matches
    .filter((entry) => {
      if (entry.status !== 200) return false;
      try {
        const body = JSON.parse(entry.response);
        return body?.type === "FeatureCollection" && Array.isArray(body.features);
      } catch {
        return false;
      }
    })
    .map((entry) => entry.response);
  if (new Set(successful).size !== 1) throw new Error("Widget query returned ambiguous data during this browser run.");
  return { request: latest, collection };
}

/** Expected values come from real returned features through frozen production rendering contracts. */
export function expectedWidgetData(widget, collection, pipeline) {
  const parsed = pipeline.rowsFromFeatureCollection(collection);
  if (!parsed) throw new Error("Expected actual FeatureCollection widget data.");
  if (widget.kind === "chart") {
    const spec = pipeline.compositionChartSpec(
      widget,
      parsed.rows.map((row) => row.properties),
    );
    if (!spec.ok) throw new Error(spec.reason);
    const series = pipeline.chartSeriesFromSpec(spec.spec);
    if (series.reason) throw new Error(series.reason);
    const chart = pipeline.renderChartSvg(spec.spec, series);
    return { kind: "chart", svg: chart.svg, chartSummary: chart.summary };
  }
  if (widget.kind === "table") {
    const config = pipeline.readTableConfig(widget);
    if (!config.ok) throw new Error(config.reason);
    const columns = config.config.fields.length ? config.config.fields : pipeline.inferColumns(parsed.rows);
    const rows = parsed.rows.slice(0, config.config.pageSize);
    return {
      kind: "table",
      tableColumns: columns,
      renderedRowCount: rows.length,
      tableCells: rows.flatMap((row) => columns.map((column) => pipeline.formatCellValue(row.properties[column]))),
    };
  }
  throw new Error("Expected a data-bound chart or table.");
}

/** Runs in the page, but parses expected SVG inertly rather than mounting it as observed evidence. */
export function expectedChartValues(svg) {
  const root = new DOMParser().parseFromString(svg, "image/svg+xml");
  return [
    ...root.querySelectorAll(".widget-chart-bar title, .widget-chart-vertex title, .widget-chart-slice title"),
  ].map((entry) => entry.textContent);
}

export function requireMatchingWidgetData(observed, expected) {
  if (observed.kind !== expected.kind) throw new Error("Rendered widget kind differs from its data contract.");
  if (expected.kind === "chart") {
    if (
      JSON.stringify(observed.renderedValues) !== JSON.stringify(expected.renderedValues) ||
      observed.chartSummary !== expected.chartSummary
    )
      throw new Error("Rendered chart values differ from the exact captured feature query.");
  } else if (
    JSON.stringify(observed.tableColumns) !== JSON.stringify(expected.tableColumns) ||
    observed.renderedRowCount !== expected.renderedRowCount ||
    JSON.stringify(observed.tableCells) !== JSON.stringify(expected.tableCells)
  ) {
    throw new Error("Rendered table cells differ from the exact captured feature query and columns.");
  }
}
