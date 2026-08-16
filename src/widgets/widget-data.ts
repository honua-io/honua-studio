/**
 * Feature rows for the data-bound widget kinds (honua-studio#24 REQ-001).
 *
 * A grid and a chart need the *attributes* behind a source, which is the one
 * thing the map path never materializes — MapLibre fetches the GeoJSON itself
 * and keeps it inside the renderer. Rather than teach this module a second
 * set of protocol routes, it **reuses `../map/source-resolution.ts`**: the
 * same resolution that gives the map its source spec gives the loader its
 * URL, so a source that draws is a source that tabulates, and neither can
 * silently drift onto a different endpoint.
 *
 * Three deliberate shapes, mirroring the discipline honua-studio#23 set:
 *
 *  - **The loader is a seam, not a hard dependency.** `WidgetDataLoader` is a
 *    one-method function type, so the whole widget pipeline — config, spec,
 *    aggregation, render, selection — is exercised in `environment: "node"`
 *    against a fake loader, exactly like `mapFactory` does for the map.
 *  - **Failure is a state, not an exception.** An unresolvable source, a
 *    404, a body that is not a FeatureCollection: each returns a `reason` the
 *    widget card renders. Nothing throws, so one bad source cannot blank the
 *    deck.
 *  - **Bounded by construction.** The request carries the same
 *    `featureLimit` the map's source URL does (#1 REQ-005), and the result
 *    reports whether it was truncated rather than pretending it is complete.
 *
 * @module
 */

// Type-only, so nothing from `../map/` enters this module's static graph.
// The implementation is reached through a dynamic import inside `load()` —
// see the note on {@link createCatalogWidgetDataLoader}.
import type { CompositionSourceDescriptor } from "../map/source-resolution.js";

/** One feature, flattened to what a grid or a chart needs: its attributes, and the id a `selectFeature` target is built from. */
export interface WidgetFeatureRow {
  readonly featureId?: string | number;
  readonly properties: Readonly<Record<string, unknown>>;
}

export type WidgetDataResult =
  | {
      readonly ok: true;
      readonly rows: readonly WidgetFeatureRow[];
      /** True when the server had more rows than the bounded request asked for. Surfaced in the UI — a partial table must say so. */
      readonly truncated: boolean;
      readonly total?: number;
    }
  | { readonly ok: false; readonly reason: string };

export interface WidgetDataLoadOptions {
  readonly signal?: AbortSignal;
}

/** The injection seam. Production wiring is {@link createCatalogWidgetDataLoader}; tests pass a function returning fixture rows. */
export type WidgetDataLoader = (sourceId: string, options?: WidgetDataLoadOptions) => Promise<WidgetDataResult>;

export interface CatalogWidgetDataLoaderOptions {
  readonly catalog?: readonly CompositionSourceDescriptor[];
  /** Server root, matching `StudioClient`'s own default. */
  readonly baseUrl?: string;
  /** Bounded page size — the same value the map's source URL carries. */
  readonly featureLimit?: number;
  /** Replaces `globalThis.fetch`. The seam a node test (or an auth-decorating host) uses. */
  readonly fetchImpl?: typeof fetch;
}

/** Rows a widget request asks for by default. Smaller than the map's 2000: a deck holds several of these at once. */
const DEFAULT_WIDGET_FEATURE_LIMIT = 500;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Flattens a GeoJSON FeatureCollection body to rows. Geometry is deliberately dropped — no widget here plots it, and keeping it would multiply the deck's memory for nothing. */
export function rowsFromFeatureCollection(body: unknown): { rows: WidgetFeatureRow[]; total?: number } | undefined {
  if (!isPlainObject(body)) return undefined;
  const features = body.features;
  if (!Array.isArray(features)) return undefined;
  const rows: WidgetFeatureRow[] = [];
  for (const feature of features) {
    if (!isPlainObject(feature)) continue;
    const properties = isPlainObject(feature.properties) ? feature.properties : {};
    const rawId = feature.id;
    rows.push({
      properties,
      ...(typeof rawId === "string" || typeof rawId === "number" ? { featureId: rawId } : {}),
    });
  }
  const matched = body.numberMatched;
  return { rows, ...(typeof matched === "number" ? { total: matched } : {}) };
}

/**
 * Builds the production loader: catalog -> resolved source URL -> rows.
 *
 * Requests are memoized per source id, so a table and a chart bound to the
 * same dataset cost one fetch rather than two. A failed load is cached too —
 * retrying it on every composition change would turn one broken source into
 * a request storm as tool calls stream in.
 *
 * `../map/source-resolution.js` is reached through a **dynamic** import
 * rather than a static one. The widget deck lives in the entry bundle (it is
 * a registered element); `source-resolution` otherwise belongs to the map's
 * lazily-imported chunk, and pulling it into the entry's static graph would
 * make the map chunk import back into the entry — the exact circularity
 * honua-studio#23 had to fix, whose real symptom is an element module
 * evaluating twice under two URLs. Keeping it dynamic leaves it a shared
 * leaf chunk instead.
 */
export function createCatalogWidgetDataLoader(options: CatalogWidgetDataLoaderOptions = {}): WidgetDataLoader {
  const cache = new Map<string, Promise<WidgetDataResult>>();
  const featureLimit = options.featureLimit ?? DEFAULT_WIDGET_FEATURE_LIMIT;

  return (sourceId, loadOptions) => {
    const cached = cache.get(sourceId);
    if (cached) return cached;
    const pending = load(sourceId, loadOptions).catch((error: unknown) => ({
      ok: false as const,
      reason: error instanceof Error ? error.message : String(error),
    }));
    cache.set(sourceId, pending);
    return pending;
  };

  async function load(sourceId: string, loadOptions?: WidgetDataLoadOptions): Promise<WidgetDataResult> {
    const { isCompositionSourceResolution, resolveCompositionSource } = await import("../map/source-resolution.js");
    // The synthetic layer exists only to reuse the map's resolution rules —
    // it is never added to composition state.
    const resolution = resolveCompositionSource(
      { id: sourceId, sourceId, visible: true },
      {
        featureLimit,
        ...(options.catalog !== undefined ? { catalog: options.catalog } : {}),
        ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      },
    );
    if (!isCompositionSourceResolution(resolution)) return { ok: false, reason: resolution.reason };

    const url = resolution.source.data;
    if (resolution.source.type !== "geojson" || typeof url !== "string") {
      return {
        ok: false,
        reason: `Source "${sourceId}" resolves to a ${String(resolution.source.type)} source, which carries no tabular rows.`,
      };
    }

    const fetchImpl = options.fetchImpl ?? (typeof fetch === "function" ? fetch : undefined);
    if (!fetchImpl) return { ok: false, reason: "No fetch implementation is available to load widget data." };

    const response = await fetchImpl(url, {
      headers: { accept: "application/geo+json, application/json" },
      ...(loadOptions?.signal ? { signal: loadOptions.signal } : {}),
    });
    if (!response.ok) {
      return { ok: false, reason: `Source "${sourceId}" returned HTTP ${response.status} for its features.` };
    }
    const parsed = rowsFromFeatureCollection(await response.json());
    if (!parsed) return { ok: false, reason: `Source "${sourceId}" did not return a GeoJSON FeatureCollection.` };
    return {
      ok: true,
      rows: parsed.rows,
      truncated: parsed.total !== undefined ? parsed.total > parsed.rows.length : parsed.rows.length >= featureLimit,
      ...(parsed.total !== undefined ? { total: parsed.total } : {}),
    };
  }
}

/** Column order for a grid with no declared `fields`: every key any loaded row carries, in first-seen order. */
export function inferColumns(rows: readonly WidgetFeatureRow[], limit = 8): readonly string[] {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row.properties)) {
      if (!columns.includes(key)) columns.push(key);
      if (columns.length >= limit) return columns;
    }
  }
  return columns;
}

/** Renders a property value as grid text. Objects become JSON rather than `[object Object]`. */
export function formatCellValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
