/**
 * Composition state — the pure-data, serializable model the composition
 * engine (honua-studio#8) reduces over.
 *
 * AD-8 (`.specifica/studio-v0/spec.md`) is load-bearing here: this state is
 * the client's PROJECTION of a Studio package lifecycle draft, never the
 * source of truth. The reducer (`reducer.ts`) is a pure merge engine; the
 * server draft (`history.ts`'s `DraftSync` / `CompositionDraftStore` seam)
 * owns persistence, and undo/redo (`history.ts`) is designed to map to draft
 * revisions once `DraftSync` is wired to the real Studio lifecycle client
 * (`@honua/sdk-js`'s `src/studio/lifecycle-client.ts`, merged to trunk in
 * sdk-js#783 but not yet in the published `0.1.2-beta.0` this app depends
 * on — see `history.ts`'s module doc for the seam).
 *
 * Every field here is plain, JSON-serializable data — no class instances, no
 * DOM references, no functions — so it round-trips unchanged through
 * `JSON.stringify`, `structuredClone`, and a Studio package envelope body.
 * {@link canonicalCompositionJson} gives a stable (sorted-key) serialization
 * used for diffing, snapshot tests, and draft payloads: two states with the
 * same content always serialize identically regardless of property
 * insertion order.
 *
 * @module
 */

/** Bumped whenever the shape of {@link CompositionState} changes incompatibly. */
export const COMPOSITION_STATE_VERSION = 1 as const;

/** A pointer to a style definition — composition state never inlines a full style spec, only a reference to one. */
export interface CompositionStyleRef {
  readonly kind: "style-ref";
  readonly styleId: string;
  readonly version?: string;
}

/** A composed layer: a source bound to an optional style reference and visibility. */
export interface CompositionLayer {
  readonly id: string;
  readonly sourceId: string;
  readonly title?: string;
  readonly visible: boolean;
  readonly styleRef?: CompositionStyleRef;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** The composed map view. All fields optional — an unset field means "unspecified", not "zero". */
export interface CompositionView {
  readonly bbox?: readonly [number, number, number, number];
  readonly center?: readonly [number, number];
  readonly zoom?: number;
  readonly pitch?: number;
  readonly bearing?: number;
}

/** The bounded set of composable widget surfaces (mirrors #1's REQ-002 "table, chart, compare, time" list, plus legend). */
export type CompositionWidgetKind = "table" | "chart" | "compare" | "time" | "legend";

export const COMPOSITION_WIDGET_KINDS: readonly CompositionWidgetKind[] = [
  "table",
  "chart",
  "compare",
  "time",
  "legend",
];

/** A composed widget/analysis surface. */
export interface CompositionWidget {
  readonly id: string;
  readonly kind: CompositionWidgetKind;
  readonly title?: string;
  readonly sourceId?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

/**
 * The bounded set of annotation-as-target kinds (honua-studio#8's scope-note
 * comment, REQ-012): a user-drawn/labeled screen region or point (the
 * deictic "THIS" a click/lasso in the chat console — honua-studio#6 —
 * resolves to), or a free-standing note. Every annotation carries an `id`
 * that is itself a valid `{ kind: "region"; id }` deictic target.
 */
export type CompositionAnnotationKind = "region" | "point" | "note";

export const COMPOSITION_ANNOTATION_KINDS: readonly CompositionAnnotationKind[] = ["region", "point", "note"];

/** A composed annotation — a region/point the user marked, or a free-text note. */
export interface CompositionAnnotation {
  readonly id: string;
  readonly kind: CompositionAnnotationKind;
  readonly label?: string;
  readonly text?: string;
  readonly bbox?: readonly [number, number, number, number];
  readonly coordinate?: readonly [number, number];
}

/**
 * Deictic reference kinds a composition mutation command may target
 * (honua-studio#8 issue comment, REQ-012): "layer id / feature selection /
 * screen region / component id". `layer`, `component` (a widget), and
 * `region` (an annotation) resolve against entities actually held in
 * {@link CompositionState}; `feature` is a source-qualified feature
 * selection that composition state does not itself track (selection lives
 * in the SDK's exploration context) — it resolves structurally so a
 * `#6`-authored annotation chip referencing a clicked feature is a valid
 * target shape even though no v0 command mutates feature state.
 */
export type CompositionTargetKind = "layer" | "feature" | "region" | "component";

export const COMPOSITION_TARGET_KINDS: readonly CompositionTargetKind[] = ["layer", "feature", "region", "component"];

export type CompositionTarget =
  | { readonly kind: "layer"; readonly id: string }
  | { readonly kind: "component"; readonly id: string }
  | { readonly kind: "region"; readonly id: string }
  | { readonly kind: "feature"; readonly sourceId: string; readonly featureId: string | number };

/** The full composition state: a serializable, diffable projection of one composed app. */
export interface CompositionState {
  readonly version: typeof COMPOSITION_STATE_VERSION;
  readonly layers: readonly CompositionLayer[];
  readonly view: CompositionView;
  readonly widgets: readonly CompositionWidget[];
  readonly annotations: readonly CompositionAnnotation[];
  /** Targets the agent must not alter — see `reducer.ts`'s pin enforcement. */
  readonly pins: readonly CompositionTarget[];
}

/** A fresh, empty composition — the reducer's identity element and every test/fixture's starting point. */
export function createEmptyCompositionState(): CompositionState {
  return { version: COMPOSITION_STATE_VERSION, layers: [], view: {}, widgets: [], annotations: [], pins: [] };
}

/** A stable string identity for a {@link CompositionTarget}, used for pin-set membership and diff paths. */
export function compositionTargetKey(target: CompositionTarget): string {
  return target.kind === "feature"
    ? `feature:${target.sourceId}:${String(target.featureId)}`
    : `${target.kind}:${target.id}`;
}

/** Structural equality for two {@link CompositionTarget} values. */
export function compositionTargetsEqual(a: CompositionTarget, b: CompositionTarget): boolean {
  return compositionTargetKey(a) === compositionTargetKey(b);
}

export interface CanonicalJsonOptions {
  /** Pretty-print with 2-space indentation (still key-sorted) — readable in test snapshots and draft payload debugging. */
  readonly pretty?: boolean;
}

/**
 * Canonical (sorted-key) JSON serialization. Two values with identical
 * content always produce the identical string regardless of property
 * insertion order — the property this module's snapshot tests and
 * `history.ts`'s draft payloads both depend on. Array order is preserved
 * (order is meaningful data — layer stacking, widget order, etc).
 */
export function canonicalCompositionJson(value: unknown, options: CanonicalJsonOptions = {}): string {
  const sorted = sortKeysDeep(value);
  return options.pretty ? JSON.stringify(sorted, null, 2) : JSON.stringify(sorted);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
    return sorted;
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
