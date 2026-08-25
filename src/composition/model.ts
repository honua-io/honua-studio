/**
 * Composition state — the pure-data, serializable model the composition
 * engine (honua-studio#8) reduces over.
 *
 * AD-8 (`.specifica/studio-v0/spec.md`) is load-bearing here: this state is
 * the client's PROJECTION of a Studio package lifecycle draft, never the
 * source of truth. The reducer (`reducer.ts`) is a pure merge engine; the
 * server draft (`history.ts`'s `DraftSync` / `CompositionDraftStore` seam)
 * owns persistence, and undo/redo (`history.ts`) maps to draft revisions
 * through `DraftSync` — over `FixtureDraftStore` in fixture mode, or over
 * `@honua/sdk-js/studio`'s `HonuaStudioLifecycleClient.drafts` through
 * `../lifecycle/composition-draft-store.ts` against a real server.
 *
 * These types are **not** the durable wire shape and are not meant to become
 * it: this is the renderer's projection — what the reducer, the map view and
 * the widget deck all read — while honua-server stores a
 * `StudioCompositionBody` (`../mcp/tool-bridge.ts`'s
 * `toStudioCompositionBody`/`applyStudioDraftBody` pair). {@link CompositionState.pins}
 * and {@link CompositionState.annotations} are app-only and deliberately
 * outside that envelope. The two meet in exactly two places, both using that
 * same pair: `../mcp/orchestrator.ts` for a tool call, and
 * `../lifecycle/composition-draft-store.ts` for a `DraftSync` write.
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

/**
 * The bounded set of composable widget surfaces (mirrors #1's REQ-002
 * "table, chart, compare, time" list, plus legend and — honua-studio#24
 * REQ-002 — `toc`, the layer list).
 *
 * `toc` is the one kind that binds to *composition state itself* rather than
 * to a data source: it lists `state.layers`, so a layer added by any later
 * tool call appears in it automatically. Nothing "pulls layers into" a TOC,
 * which is why it carries no source binding and why its visibility toggles
 * are intrinsic (REQ-003) rather than authored — see
 * `../widgets/widget-config.ts`.
 */
export type CompositionWidgetKind = "table" | "chart" | "compare" | "time" | "legend" | "toc";

export const COMPOSITION_WIDGET_KINDS: readonly CompositionWidgetKind[] = [
  "table",
  "chart",
  "compare",
  "time",
  "legend",
  "toc",
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
 * The closed control vocabulary (geospatial-mcp ADR-0031, honua-studio#25
 * REQ-001) — verbatim, in the upstream schema's enum order. It is a *closed*
 * set on purpose: a host that renders an unknown kind cannot know what the
 * affordance means, and the standard would rather reject the document than
 * let each host invent a dialect.
 *
 * The upstream schema splits the vocabulary semantically, and that split is
 * load-bearing for this module's consumers:
 *
 *  - **Map affordances** — `navigation`, `scale`, `fullscreen`, `geolocate`,
 *    `attribution`, `basemapSwitcher`, `bookmarks`, `measure`, `search`.
 *    These act on the map directly through the host; their behavior is
 *    *intrinsic* (REQ-003) and needs no authored binding.
 *  - **Data-binding affordances that emit `change`** — `timeSlider`,
 *    `filterSelect`, `filterSlider`, `filterDateRange`, `opacity`. These are
 *    the input half ADR-0030 interactions bind to.
 *
 * See `../controls/control-config.ts` for the per-kind normalization, and
 * `CONTROL_KIND_EMITS_CHANGE` there for the machine-readable split.
 *
 * There is deliberately **no draw/edit kind** — ADR-0031's own exclusion:
 * a draw control writing to a source dataset would put feature mutation
 * behind an agent-authored document, bypassing the governed `edit_features`
 * boundary ADR-0028 makes the only admitted path (honua-studio#25 NFR-001).
 */
export type CompositionControlKind =
  | "navigation"
  | "scale"
  | "fullscreen"
  | "geolocate"
  | "search"
  | "measure"
  | "timeSlider"
  | "filterSelect"
  | "filterSlider"
  | "filterDateRange"
  | "bookmarks"
  | "opacity"
  | "attribution"
  | "basemapSwitcher";

export const COMPOSITION_CONTROL_KINDS: readonly CompositionControlKind[] = [
  "navigation",
  "scale",
  "fullscreen",
  "geolocate",
  "search",
  "measure",
  "timeSlider",
  "filterSelect",
  "filterSlider",
  "filterDateRange",
  "bookmarks",
  "opacity",
  "attribution",
  "basemapSwitcher",
];

/**
 * A composed control — an input affordance, and a **peer of a widget rather
 * than a widget kind**. Same entry shape as {@link CompositionWidget}
 * (`{ id, kind, title?, sourceId?, config? }`), deliberately: ADR-0031 mirrors
 * the widget entry so a host that can read one can read the other.
 *
 * Controls are **chrome, not `layout` grid items** — docked to a map corner
 * or a rail — which is exactly why they live in their own collection instead
 * of forcing every host to carry a rule for "which widget kinds are exempt
 * from layout".
 */
export interface CompositionControl {
  readonly id: string;
  readonly kind: CompositionControlKind;
  readonly title?: string;
  /** The layer or datasource the control reads its domain from. Presentation-only kinds omit it. */
  readonly sourceId?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

/**
 * ADR-0030's closed event vocabulary. `change` is the one a control emits —
 * and the only one honua-studio#25 produces; the rest are named so a binding
 * authored against them round-trips rather than being dropped.
 */
export type CompositionInteractionEvent = "featureSelect" | "featureHover" | "selection" | "change" | "viewportChange";

export const COMPOSITION_INTERACTION_EVENTS: readonly CompositionInteractionEvent[] = [
  "featureSelect",
  "featureHover",
  "selection",
  "change",
  "viewportChange",
];

/** ADR-0030's closed verb vocabulary. Presentation/exploration only — no verb touches source records. */
export type CompositionInteractionVerb =
  | "setFilter"
  | "setViewport"
  | "selectFeature"
  | "runWidgetQuery"
  | "setVisibility";

export const COMPOSITION_INTERACTION_VERBS: readonly CompositionInteractionVerb[] = [
  "setFilter",
  "setViewport",
  "selectFeature",
  "runWidgetQuery",
  "setVisibility",
];

/**
 * One declarative binding (ADR-0030): `on` a component's event, `do` a verb
 * on a component. `ref` is the `map | layer:{id} | widget:{id} | control:{id}`
 * grammar — the same string {@link compositionTargetKey} produces for a
 * {@link CompositionTarget}, which is why `control:{id}` resolution is a
 * lookup rather than a parser.
 *
 * Bindings are **data, never code**: `args` is static JSON plus `$event.`
 * path substitution, with no expression language.
 */
export interface CompositionInteraction {
  readonly id: string;
  readonly on: { readonly ref: string; readonly event: CompositionInteractionEvent };
  readonly do: {
    readonly ref: string;
    readonly verb: CompositionInteractionVerb;
    readonly args?: Readonly<Record<string, unknown>>;
  };
  readonly disabled?: boolean;
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
 *
 * honua-studio#25 adds `control`, and it is worth saying why it is a target
 * kind of its own rather than another `component`: ADR-0030's reference
 * grammar is `map | layer:{id} | widget:{id} | control:{id}`, and
 * {@link compositionTargetKey} renders a target as exactly `kind:id`. So
 * `{ kind: "control", id: "year-built" }` *is* the string
 * `control:year-built` a binding references — resolving a `control:` ref
 * becomes a lookup rather than a parser, and a control can be pinned and
 * selected through the same machinery every other composed entity uses.
 */
export type CompositionTargetKind = "layer" | "feature" | "region" | "component" | "control";

export const COMPOSITION_TARGET_KINDS: readonly CompositionTargetKind[] = [
  "layer",
  "feature",
  "region",
  "component",
  "control",
];

export type CompositionTarget =
  | { readonly kind: "layer"; readonly id: string }
  | { readonly kind: "component"; readonly id: string }
  | { readonly kind: "control"; readonly id: string }
  | { readonly kind: "region"; readonly id: string }
  | { readonly kind: "feature"; readonly sourceId: string; readonly featureId: string | number };

/** The full composition state: a serializable, diffable projection of one composed app. */
export interface CompositionState {
  readonly version: typeof COMPOSITION_STATE_VERSION;
  readonly layers: readonly CompositionLayer[];
  readonly view: CompositionView;
  readonly widgets: readonly CompositionWidget[];
  /** Input affordances (honua-studio#25) — chrome, and a peer collection of `widgets`, never a widget kind. */
  readonly controls: readonly CompositionControl[];
  /** Declarative event→action bindings (ADR-0030). Data, never code — see {@link CompositionInteraction}. */
  readonly interactions: readonly CompositionInteraction[];
  readonly annotations: readonly CompositionAnnotation[];
  /** Targets the agent must not alter — see `reducer.ts`'s pin enforcement. */
  readonly pins: readonly CompositionTarget[];
}

/** A fresh, empty composition — the reducer's identity element and every test/fixture's starting point. */
export function createEmptyCompositionState(): CompositionState {
  return {
    version: COMPOSITION_STATE_VERSION,
    layers: [],
    view: {},
    widgets: [],
    controls: [],
    interactions: [],
    annotations: [],
    pins: [],
  };
}

/** Every interaction whose `on.ref` is `control:{id}` for the given control — the set `removeControl` must cascade or refuse over. */
export function interactionsReferencingControl(
  state: CompositionState,
  controlId: string,
): readonly CompositionInteraction[] {
  const ref = `control:${controlId}`;
  return state.interactions.filter((interaction) => interaction.on.ref === ref || interaction.do.ref === ref);
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
