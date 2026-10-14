/** Runs in the actual page. Do not infer data readiness from composition intent or console silence. */
export function collectRenderedWidgetObservations(widgets) {
  const root = document.querySelector("honua-studio-canvas")?.widgetDeck?.shadowRoot;
  const cards = [...(root?.querySelectorAll('[data-testid="studio-widget"]') ?? [])];
  return widgets
    .filter((widget) => widget.kind === "chart" || widget.kind === "table")
    .map((widget) => {
      const card = cards.find((entry) => entry.dataset.widgetId === widget.id);
      const status = card?.querySelector('[data-testid="studio-widget-status"]')?.textContent?.trim() ?? "";
      const chart = card?.querySelector('[data-testid="studio-widget-chart"] svg');
      const marks = chart?.querySelectorAll(".widget-chart-bar, .widget-chart-vertex, .widget-chart-slice").length ?? 0;
      const rows = card?.querySelectorAll('[data-testid="studio-widget-grid-row"]').length ?? 0;
      const loading = !card || /^Loading |^Preparing the chart/.test(status);
      const ready = widget.kind === "chart" ? Boolean(chart && marks > 0 && !status) : rows > 0;
      return {
        widgetId: widget.id,
        sourceId: widget.sourceId,
        kind: widget.kind,
        state: ready ? "ready" : loading ? "loading" : "error",
        status,
        renderedMarkCount: marks,
        renderedRowCount: rows,
        chartSummary: card?.querySelector('[data-testid="studio-widget-chart-summary"]')?.textContent?.trim(),
        renderedValues: [
          ...(chart?.querySelectorAll(
            ".widget-chart-bar title, .widget-chart-vertex title, .widget-chart-slice title",
          ) ?? []),
        ].map((entry) => entry.textContent),
        tableColumns: [...(card?.querySelectorAll("thead th") ?? [])].map((entry) => entry.textContent),
        tableCells: [...(card?.querySelectorAll('[role="gridcell"]') ?? [])].map((entry) => entry.textContent),
      };
    });
}

export function requireRenderedWidgetData(observations) {
  const failed = observations.filter((entry) => entry.state !== "ready");
  if (failed.length)
    throw new Error(
      `Widget data did not render: ${failed.map((entry) => `${entry.widgetId}: ${entry.status || entry.state}`).join("; ")}`,
    );
}
