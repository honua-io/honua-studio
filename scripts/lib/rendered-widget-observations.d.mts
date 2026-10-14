export interface RenderedWidgetObservation {
  widgetId: string;
  sourceId?: string;
  kind: string;
  state: string;
  status: string;
  renderedMarkCount: number;
  renderedRowCount: number;
  chartSummary?: string;
  renderedValues: (string | null)[];
  tableCells: (string | null)[];
}
export function collectRenderedWidgetObservations(
  widgets: readonly { id: string; kind: string; sourceId?: string }[],
): RenderedWidgetObservation[];
export function requireRenderedWidgetData(observations: readonly RenderedWidgetObservation[]): void;
