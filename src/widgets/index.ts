/**
 * Public entry point for the composed chrome (honua-studio#24). Side effect
 * free on import, like `../composition/index.ts` and `../elements/index.ts`.
 *
 * Everything reachable from here is pure and DOM-free: config normalization,
 * the SDK-backed chart-spec projection, the aggregation that reads that spec,
 * the bounded SVG renderer, and the feature-loader seam. The element that
 * assembles them is `../elements/studio-widget-deck-element.ts`.
 *
 * @module
 */

export type {
  CompositionChartConfig,
  CompositionChartType,
  CompositionCompareConfig,
  CompositionLegendConfig,
  CompositionMeasure,
  CompositionMeasureFn,
  CompositionTableConfig,
  CompositionTimeConfig,
  CompositionTimeStep,
  CompositionTocConfig,
  WidgetConfigResult,
} from "./widget-config.js";
export {
  normalizeChartType,
  readChartConfig,
  readCompareConfig,
  readLegendConfig,
  readTableConfig,
  readTimeConfig,
  readTocConfig,
} from "./widget-config.js";

export type { ChartSpecResult, HonuaVegaLiteChartSpec } from "./chart-spec.js";
export { compositionChartSpec, compositionChartToGeneratedAppWidget } from "./chart-spec.js";

export type { ChartPoint, ChartSeries } from "./chart-data.js";
export { chartSeriesFromSpec } from "./chart-data.js";

export type { ChartRenderResult } from "./chart-render.js";
export { formatValue, renderChartSvg, specMark } from "./chart-render.js";

export type {
  CatalogWidgetDataLoaderOptions,
  WidgetDataLoadOptions,
  WidgetDataLoader,
  WidgetDataResult,
  WidgetFeatureRow,
} from "./widget-data.js";
export {
  createCatalogWidgetDataLoader,
  formatCellValue,
  inferColumns,
  rowsFromFeatureCollection,
} from "./widget-data.js";
