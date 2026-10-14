import type { CompositionWidget } from "../../src/composition/model.js";
import type { chartSeriesFromSpec } from "../../src/widgets/chart-data.js";
import type { renderChartSvg } from "../../src/widgets/chart-render.js";
import type { compositionChartSpec } from "../../src/widgets/chart-spec.js";
import type { readTableConfig } from "../../src/widgets/widget-config.js";
import type { formatCellValue, inferColumns, rowsFromFeatureCollection } from "../../src/widgets/widget-data.js";
interface FeatureRequest {
  method: string;
  browserUrl: string;
  status: number;
  response: string;
}
interface WidgetPipeline {
  compositionChartSpec: typeof compositionChartSpec;
  chartSeriesFromSpec: typeof chartSeriesFromSpec;
  renderChartSvg: typeof renderChartSvg;
  readTableConfig: typeof readTableConfig;
  rowsFromFeatureCollection: typeof rowsFromFeatureCollection;
  inferColumns: typeof inferColumns;
  formatCellValue: typeof formatCellValue;
}
interface WidgetValues {
  kind: string;
  chartSummary?: string;
  renderedValues?: readonly (string | null)[];
  renderedRowCount?: number;
  tableColumns?: readonly (string | null)[];
  tableCells?: readonly (string | null)[];
}
export function bindWidgetFeatureResponse(
  url: string,
  requests: readonly FeatureRequest[],
): { request: FeatureRequest; collection: unknown };
export function expectedWidgetData(
  widget: CompositionWidget,
  collection: unknown,
  pipeline: WidgetPipeline,
):
  | { kind: "chart"; svg: string; chartSummary: string }
  | { kind: "table"; tableColumns: readonly string[]; renderedRowCount: number; tableCells: string[] };
export function expectedChartValues(svg: string): (string | null)[];
export function requireMatchingWidgetData(observed: WidgetValues, expected: WidgetValues): void;
