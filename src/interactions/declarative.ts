/**
 * The declarative interaction compiler (geospatial-mcp ADR-0030,
 * honua-studio#25 REQ-002): interaction documents in, live bindings out.
 *
 * ## Why this file exists at all, and what it is a stand-in for
 *
 * `@honua/sdk-js/interactions/declarative` (sdk-js#1259) is this compiler.
 * It is **not** in the published `0.1.2-beta.0` this app pins — the subpath
 * lands with `0.1.4-beta.0` — which is the same seam
 * `../composition/history.ts` documents for `lifecycle-client.ts` (sdk-js#783)
 * and `../map/composition-map-view.ts` documents for `cloneLayer`. So this
 * module is deliberately shaped as a **drop-in local implementation of that
 * exact contract**, not as a Studio dialect:
 *
 *  - the same entry point signature (`compile…({ interactions, view,
 *    components, fanOutCap, onDispatch })`),
 *  - the same closed vocabularies, the same fan-out cap of 8, the same
 *    `$event.` substitution rule, the same issue codes,
 *  - the same result shape (`{ ok, issues, bindings, unsupported, disabled,
 *    dispose() }`),
 *  - and, critically, **the same runtime primitives underneath**:
 *    `bindFilterControlsToExploration` over an `ExplorationViewController`
 *    from `@honua/sdk-js/exploration`, which *are* published today.
 *
 * The consequence is that swapping to the SDK module when it ships is an
 * import change, not a rewrite, and until then Studio is not running a
 * parallel event system — it is running the SDK's own exploration primitives
 * with a local compiler on top.
 *
 * ## Actions never emit events
 *
 * ADR-0030: "Only user gestures produce events; verb-driven state changes
 * MUST NOT re-enter the interaction dispatcher." That is enforced three ways
 * here, deliberately overlapping, because a cycle that only *usually* cannot
 * happen is a cycle:
 *
 *  1. **Structurally.** The compiler subscribes on its own
 *     {@link ExplorationViewController}, separate from the view controls
 *     publish through. Bound views ignore their own notifications
 *     (`includeSelf` defaults to false), so a clause the compiler itself
 *     writes never wakes the compiler.
 *  2. **By source tag.** Every event carries the `source` discriminator
 *     `HonuaController` uses (`controller | exploration | adapter |
 *     snapshot`) — a user gesture arrives `adapter`, an exploration-propagated
 *     change arrives `exploration`, and anything tagged `controller` (an
 *     action's own write) is refused by {@link StudioCompiledInteractions.dispatch}.
 *     This is the enforcement point honua-studio#25's issue comment asks for.
 *  3. **By re-entrancy guard.** A verb running is a flag; an event arriving
 *     while it is set is dropped and counted.
 *
 * @module
 */

import type { FilterClause } from "@honua/sdk-js/exploration";
import type { ExplorationViewController } from "@honua/sdk-js/exploration";
import { bindFilterControlsToExploration } from "@honua/sdk-js/interactions";

import {
  COMPOSITION_INTERACTION_EVENTS,
  COMPOSITION_INTERACTION_VERBS,
  type CompositionInteraction,
  type CompositionInteractionEvent,
  type CompositionInteractionVerb,
} from "../composition/model.js";

/**
 * Where an event came from. Borrowed verbatim from `HonuaController`'s
 * `HonuaControllerEventSource` (`@honua/sdk-js/app-controller`) rather than
 * invented — the point of a shared discriminator is that it means the same
 * thing on both sides of the boundary.
 */
export type StudioInteractionEventSource = "controller" | "exploration" | "adapter" | "snapshot";

/** Sources that represent a user gesture, and are therefore allowed to drive a binding. */
export const GESTURE_EVENT_SOURCES: readonly StudioInteractionEventSource[] = ["adapter", "exploration"];

/** ADR-0030's fan-out cap: at most this many bindings may share one `(on.ref, on.event)` pair. Documents over the cap are rejected, not truncated. */
export const INTERACTION_FANOUT_CAP = 8;

export const INTERACTION_EVENT_PATH_PREFIX = "$event.";

export type StudioInteractionRefKind = "map" | "layer" | "widget" | "control";

export interface ParsedInteractionRef {
  readonly kind: StudioInteractionRefKind;
  /** Absent for the bare `map` ref. */
  readonly id?: string;
}

/** Parses `map | layer:{id} | widget:{id} | control:{id}`. Splits on the FIRST colon, so an id may contain colons. */
export function parseInteractionRef(ref: string): ParsedInteractionRef | undefined {
  if (ref === "map") return { kind: "map" };
  const separator = ref.indexOf(":");
  if (separator <= 0) return undefined;
  const kind = ref.slice(0, separator);
  const id = ref.slice(separator + 1);
  if (id.length === 0) return undefined;
  if (kind === "layer" || kind === "widget" || kind === "control") return { kind, id };
  return undefined;
}

/**
 * Which ref kind may emit which event — ADR-0030's own table. `change` is
 * a **control** event and only a control event, which is precisely why
 * honua-studio#25 (controls) is the issue that makes the event reachable.
 */
const EVENT_SOURCE_KIND: Readonly<Record<CompositionInteractionEvent, StudioInteractionRefKind>> = {
  featureSelect: "layer",
  featureHover: "layer",
  selection: "widget",
  change: "control",
  viewportChange: "map",
};

export type InteractionIssueCode =
  | "invalid-shape"
  | "duplicate-id"
  | "unknown-event"
  | "unknown-verb"
  | "invalid-ref"
  | "invalid-event-path"
  | "fan-out-exceeded";

export interface InteractionIssue {
  readonly code: InteractionIssueCode;
  readonly interactionId?: string;
  readonly path: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Components — what a ref resolves to
// ---------------------------------------------------------------------------

export interface InteractionViewport {
  readonly bbox?: readonly [number, number, number, number];
  readonly center?: readonly [number, number];
  readonly zoom?: number;
  readonly pitch?: number;
  readonly bearing?: number;
}

export interface InteractionMapComponent {
  setViewport?(viewport: InteractionViewport): void;
}

export interface InteractionLayerComponent {
  readonly sourceId?: string;
  setVisibility?(visible: boolean): void;
  /** `undefined` clears. */
  setFilter?(clause: FilterClause | undefined): void;
  selectFeature?(featureId: string | number): void;
}

export interface InteractionWidgetComponent {
  runQuery?(args: Readonly<Record<string, unknown>>): void;
  setVisibility?(visible: boolean): void;
  setFilter?(clause: FilterClause | undefined): void;
}

/** A control component needs no methods — declaring it is what makes `control:{id}` resolve. Same as the SDK's registry. */
export type InteractionControlComponent = Record<string, never> | Record<string, unknown>;

export interface StudioInteractionComponents {
  readonly map?: InteractionMapComponent;
  readonly layers?: Readonly<Record<string, InteractionLayerComponent>>;
  readonly widgets?: Readonly<Record<string, InteractionWidgetComponent>>;
  readonly controls?: Readonly<Record<string, InteractionControlComponent>>;
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

/**
 * The `change` payload, field for field as sdk-js#1259 builds it. `$event.`
 * paths in a binding's `args` read from this object, so the field names are
 * part of the authored contract, not an implementation detail.
 */
export interface ControlChangePayload {
  readonly id: string;
  readonly field?: string;
  readonly operator?: FilterClause["operator"];
  readonly value?: unknown;
  readonly clause?: FilterClause;
  readonly filters: Readonly<Record<string, FilterClause>>;
}

/** One control gesture, ready to dispatch. `source` is the no-cascade enforcement point — see this module's doc. */
export interface StudioControlChangeEvent {
  readonly type: "change";
  readonly ref: string;
  readonly source: StudioInteractionEventSource;
  readonly payload: ControlChangePayload;
}

export interface InteractionDispatchRecord {
  readonly interactionId: string;
  readonly event: CompositionInteractionEvent;
  readonly verb: CompositionInteractionVerb;
  readonly ref: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface CompiledInteractionBinding {
  readonly interactionId: string;
  readonly on: CompositionInteraction["on"];
  readonly do: CompositionInteraction["do"];
  /** `"change -> setFilter"` — the pair, for readouts and tests. */
  readonly pair: string;
}

export interface UnsupportedInteraction {
  readonly interactionId: string;
  readonly reason: string;
}

export interface StudioCompiledInteractions {
  /** True when the document validated AND every non-disabled binding compiled. */
  readonly ok: boolean;
  /** Non-empty means nothing was bound — a document with a broken binding is not half-applied. */
  readonly issues: readonly InteractionIssue[];
  readonly bindings: readonly CompiledInteractionBinding[];
  readonly unsupported: readonly UnsupportedInteraction[];
  readonly disabled: readonly string[];
  /** Gesture events refused because they arrived tagged as action-driven, or re-entered mid-action. */
  readonly refused: readonly string[];
  /**
   * Dispatches one gesture. Returns the actions it ran. Refuses (returning an
   * empty list) any event whose `source` is not a gesture, or that arrives
   * while a verb is already running.
   */
  dispatch(event: StudioControlChangeEvent): readonly InteractionDispatchRecord[];
  dispose(): void;
}

export interface CompileStudioInteractionsOptions {
  readonly interactions: readonly CompositionInteraction[];
  /**
   * The compiler's OWN exploration view — never the one controls publish
   * through. `context.connectView({ id: "interactions", role: "custom" })`.
   * Passing the control host's view would defeat the structural half of the
   * no-cascade rule.
   */
  readonly view: ExplorationViewController;
  readonly components?: StudioInteractionComponents;
  readonly fanOutCap?: number;
  readonly onDispatch?: (dispatch: InteractionDispatchRecord) => void;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** True for a `$event.<path>` string with a non-empty path. */
export function isInteractionEventPath(value: string): boolean {
  return value.startsWith(INTERACTION_EVENT_PATH_PREFIX) && value.length > INTERACTION_EVENT_PATH_PREFIX.length;
}

/** Reads `$event.a.b` out of a payload. Returns `undefined` for any path that does not resolve — never throws. */
export function readInteractionEventPath(payload: unknown, path: string): unknown {
  const segments = path.slice(INTERACTION_EVENT_PATH_PREFIX.length).split(".");
  let current: unknown = payload;
  for (const segment of segments) {
    if (!isPlainObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Static JSON plus `$event.` substitution. **No expression language** — no
 * arithmetic, no conditionals, no function calls (ADR-0030). Substitution
 * recurses through nested objects and arrays so `{ view: { bbox:
 * "$event.value" } }` works, which is the shape a `setViewport` binding wants.
 */
export function resolveInteractionArgs(
  args: Readonly<Record<string, unknown>> | undefined,
  payload: unknown,
): Readonly<Record<string, unknown>> {
  if (!args) return {};
  return substitute(args, payload) as Readonly<Record<string, unknown>>;
}

function substitute(value: unknown, payload: unknown): unknown {
  if (typeof value === "string") {
    return isInteractionEventPath(value) ? readInteractionEventPath(payload, value) : value;
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, payload));
  if (isPlainObject(value)) {
    const resolved: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) resolved[key] = substitute(entry, payload);
    return resolved;
  }
  return value;
}

/** Structural + vocabulary validation of a whole interactions block. Returns every problem at once. */
export function validateInteractions(
  interactions: readonly CompositionInteraction[],
  options: { readonly components?: StudioInteractionComponents; readonly fanOutCap?: number } = {},
): readonly InteractionIssue[] {
  const issues: InteractionIssue[] = [];
  const seen = new Set<string>();
  const fanOut = new Map<string, number>();
  const cap = options.fanOutCap ?? INTERACTION_FANOUT_CAP;

  for (const [index, interaction] of interactions.entries()) {
    const path = `interactions[${index}]`;
    if (!isPlainObject(interaction) || typeof interaction.id !== "string" || interaction.id.length === 0) {
      issues.push({ code: "invalid-shape", path, message: `${path} must be an object with a non-empty id.` });
      continue;
    }
    const id = interaction.id;
    if (seen.has(id)) {
      issues.push({ code: "duplicate-id", interactionId: id, path, message: `Interaction id "${id}" is not unique.` });
      continue;
    }
    seen.add(id);

    if (!isPlainObject(interaction.on) || !isPlainObject(interaction.do)) {
      issues.push({
        code: "invalid-shape",
        interactionId: id,
        path,
        message: `Interaction "${id}" must carry both an "on" and a "do" object.`,
      });
      continue;
    }

    if (!(COMPOSITION_INTERACTION_EVENTS as readonly string[]).includes(interaction.on.event)) {
      issues.push({
        code: "unknown-event",
        interactionId: id,
        path: `${path}.on.event`,
        message: `"${String(interaction.on.event)}" is not one of ${COMPOSITION_INTERACTION_EVENTS.join(", ")}.`,
      });
    }
    if (!(COMPOSITION_INTERACTION_VERBS as readonly string[]).includes(interaction.do.verb)) {
      issues.push({
        code: "unknown-verb",
        interactionId: id,
        path: `${path}.do.verb`,
        message: `"${String(interaction.do.verb)}" is not one of ${COMPOSITION_INTERACTION_VERBS.join(", ")}.`,
      });
    }

    const onRef = parseInteractionRef(interaction.on.ref);
    if (!onRef) {
      issues.push({
        code: "invalid-ref",
        interactionId: id,
        path: `${path}.on.ref`,
        message: `"${interaction.on.ref}" is not a "map", "layer:{id}", "widget:{id}", or "control:{id}" reference.`,
      });
    } else {
      const expected = EVENT_SOURCE_KIND[interaction.on.event];
      if (expected && onRef.kind !== expected) {
        issues.push({
          code: "invalid-ref",
          interactionId: id,
          path: `${path}.on.ref`,
          message: `"${interaction.on.event}" is emitted by a ${expected} source, not by "${interaction.on.ref}".`,
        });
      } else if (!componentResolves(options.components, onRef)) {
        issues.push({
          code: "invalid-ref",
          interactionId: id,
          path: `${path}.on.ref`,
          message: `"${interaction.on.ref}" does not resolve to a declared component.`,
        });
      }
    }

    const doRef = parseInteractionRef(interaction.do.ref);
    if (!doRef) {
      issues.push({
        code: "invalid-ref",
        interactionId: id,
        path: `${path}.do.ref`,
        message: `"${interaction.do.ref}" is not a "map", "layer:{id}", "widget:{id}", or "control:{id}" reference.`,
      });
    } else if (!componentResolves(options.components, doRef)) {
      issues.push({
        code: "invalid-ref",
        interactionId: id,
        path: `${path}.do.ref`,
        message: `"${interaction.do.ref}" does not resolve to a declared component.`,
      });
    }

    for (const [key, value] of Object.entries(interaction.do.args ?? {})) {
      if (
        typeof value === "string" &&
        value.startsWith(INTERACTION_EVENT_PATH_PREFIX) &&
        !isInteractionEventPath(value)
      ) {
        issues.push({
          code: "invalid-event-path",
          interactionId: id,
          path: `${path}.do.args.${key}`,
          message: `"${value}" is an empty event path.`,
        });
      }
    }

    if (interaction.disabled === true) continue;
    const pairKey = `${interaction.on.ref} ${interaction.on.event}`;
    const count = (fanOut.get(pairKey) ?? 0) + 1;
    fanOut.set(pairKey, count);
    if (count > cap) {
      issues.push({
        code: "fan-out-exceeded",
        interactionId: id,
        path: `${path}.on`,
        message: `More than ${cap} interactions share (${interaction.on.ref}, ${interaction.on.event}).`,
      });
    }
  }
  return issues;
}

function componentResolves(components: StudioInteractionComponents | undefined, ref: ParsedInteractionRef): boolean {
  if (!components) return true;
  if (ref.kind === "map") return components.map !== undefined;
  if (!ref.id) return false;
  if (ref.kind === "layer") return components.layers?.[ref.id] !== undefined;
  if (ref.kind === "widget") return components.widgets?.[ref.id] !== undefined;
  return components.controls?.[ref.id] !== undefined;
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

/**
 * Compiles an interaction block onto exploration primitives.
 *
 * `change` bindings are wired the way sdk-js#1259 wires them: the compiler
 * subscribes to the shared filters slice through
 * `bindFilterControlsToExploration` on its OWN view, keyed by control id. A
 * control publishing a clause under its own id is therefore what "a control
 * emitted change" *is* — there is no second channel, and nothing in this file
 * invents one.
 *
 * The other four events are recognized, validated, and reported as
 * {@link UnsupportedInteraction} rather than silently ignored: Studio's map
 * click path (honua-studio#23) and widget selection path (honua-studio#24)
 * already exist, but binding them declaratively is ADR-0030 work beyond
 * honua-studio#25's controls scope, and a binding that is quietly inert is the
 * failure mode this repo keeps paying for.
 */
export function compileStudioInteractions(options: CompileStudioInteractionsOptions): StudioCompiledInteractions {
  const { interactions, view, components, onDispatch } = options;
  const cap = options.fanOutCap ?? INTERACTION_FANOUT_CAP;
  const issues = validateInteractions(interactions, {
    ...(components !== undefined ? { components } : {}),
    fanOutCap: cap,
  });

  const disabled = interactions.filter((entry) => entry.disabled === true).map((entry) => entry.id);
  const refused: string[] = [];
  const disposers: (() => void)[] = [];

  if (issues.length > 0) {
    return {
      ok: false,
      issues,
      bindings: [],
      unsupported: [],
      disabled,
      refused,
      dispatch: () => [],
      dispose: () => {},
    };
  }

  const active = interactions.filter((entry) => entry.disabled !== true);
  const bindings: CompiledInteractionBinding[] = [];
  const unsupported: UnsupportedInteraction[] = [];

  for (const interaction of active) {
    const reason = unsupportedReason(interaction, components);
    if (reason) {
      unsupported.push({ interactionId: interaction.id, reason });
      continue;
    }
    bindings.push({
      interactionId: interaction.id,
      on: interaction.on,
      do: interaction.do,
      pair: `${interaction.on.event} -> ${interaction.do.verb}`,
    });
  }

  const changeBindings = bindings.filter((binding) => binding.on.event === "change");
  let dispatching = false;

  const runVerb = (
    binding: CompiledInteractionBinding,
    payload: ControlChangePayload,
  ): InteractionDispatchRecord | undefined => {
    const args = resolveInteractionArgs(binding.do.args, payload);
    const ref = parseInteractionRef(binding.do.ref);
    if (!ref) return undefined;
    const applied = applyVerb(binding.do.verb, ref, args, payload, components);
    if (!applied) return undefined;
    const record: InteractionDispatchRecord = {
      interactionId: binding.interactionId,
      event: binding.on.event,
      verb: binding.do.verb,
      ref: binding.do.ref,
      args,
    };
    onDispatch?.(record);
    return record;
  };

  const dispatch = (event: StudioControlChangeEvent): readonly InteractionDispatchRecord[] => {
    // (2) source tag, and (3) re-entrancy guard. (1) — the separate view — is
    // structural and lives in the subscription below.
    if (!GESTURE_EVENT_SOURCES.includes(event.source)) {
      refused.push(`${event.ref}: refused a "${event.source}"-sourced event (actions never emit events).`);
      return [];
    }
    if (dispatching) {
      refused.push(`${event.ref}: refused a re-entrant event while an action was running.`);
      return [];
    }
    dispatching = true;
    try {
      const records: InteractionDispatchRecord[] = [];
      for (const binding of changeBindings) {
        if (binding.on.ref !== event.ref) continue;
        const record = runVerb(binding, event.payload);
        if (record) records.push(record);
      }
      return records;
    } finally {
      dispatching = false;
    }
  };

  // The SDK-compatible transport: the compiler watches the shared filters
  // slice on its own view. `includeSelf` stays at its default (false), so a
  // clause written by one of this compiler's own verbs is invisible to it.
  if (changeBindings.length > 0) {
    const controls = bindFilterControlsToExploration(view);
    disposers.push(
      controls.subscribe((filters, event) => {
        const changedId = changedClauseId(filters, event);
        if (!changedId) return;
        const clause = filters[changedId];
        dispatch({
          type: "change",
          ref: `control:${changedId}`,
          source: "exploration",
          payload: {
            id: changedId,
            ...(clause ? { field: clause.field, operator: clause.operator, value: clause.value, clause } : {}),
            filters,
          },
        });
      }),
    );
  }

  return {
    ok: unsupported.length === 0,
    issues,
    bindings,
    unsupported,
    disabled,
    refused,
    dispatch,
    dispose: () => {
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}

/** Which clause id the notification is about — the exploration selector hands over the whole record, not a delta. */
function changedClauseId(
  filters: Readonly<Record<string, FilterClause>>,
  event: { readonly previous?: { readonly filters?: Readonly<Record<string, FilterClause>> } } | undefined,
): string | undefined {
  const previous = event?.previous?.filters ?? {};
  for (const key of Object.keys(filters)) if (filters[key] !== previous[key]) return key;
  for (const key of Object.keys(previous)) if (!(key in filters)) return key;
  return undefined;
}

/**
 * The verb-targeting rules, and the honest reasons a binding cannot run in
 * Studio yet. Each string names the missing capability rather than saying
 * "unsupported", because "unsupported" alone is not actionable.
 */
function unsupportedReason(
  interaction: CompositionInteraction,
  components: StudioInteractionComponents | undefined,
): string | undefined {
  if (interaction.on.event !== "change") {
    return `"${interaction.on.event}" bindings are not compiled yet — honua-studio#25 wires the control "change" half of ADR-0030; the map/widget event halves are the next issue's scope. The binding is held in the composition, not dropped.`;
  }
  const doRef = parseInteractionRef(interaction.do.ref);
  if (!doRef) return `"${interaction.do.ref}" is not a component reference.`;

  switch (interaction.do.verb) {
    case "setViewport":
      if (doRef.kind !== "map") return `setViewport targets the map, not "${interaction.do.ref}".`;
      return components?.map?.setViewport ? undefined : "This canvas exposes no camera to move.";
    case "runWidgetQuery":
      if (doRef.kind !== "widget") return `runWidgetQuery targets a widget, not "${interaction.do.ref}".`;
      return "Studio widgets fetch their own bounded rows (honua-studio#24's data loader) and expose no query verb — runWidgetQuery has nothing to call.";
    case "setVisibility":
      if (doRef.kind === "map") return "setVisibility cannot target the map.";
      if (doRef.kind === "layer") {
        return components?.layers?.[doRef.id ?? ""]?.setVisibility
          ? undefined
          : `Layer "${doRef.id}" exposes no visibility control.`;
      }
      return "Composition state models visibility for layers only — a widget or control has no `visible` field to set.";
    case "selectFeature":
      if (doRef.kind === "control") return "selectFeature cannot target a control.";
      if (doRef.kind === "layer") {
        return components?.layers?.[doRef.id ?? ""]?.selectFeature
          ? undefined
          : `Layer "${doRef.id}" exposes no selection control.`;
      }
      return undefined;
    case "setFilter":
      if (doRef.kind === "layer") {
        return components?.layers?.[doRef.id ?? ""]?.setFilter
          ? undefined
          : `Layer "${doRef.id}" exposes no filter control.`;
      }
      if (doRef.kind === "widget") {
        return components?.widgets?.[doRef.id ?? ""]?.setFilter
          ? undefined
          : `Widget "${doRef.id}" exposes no filter control.`;
      }
      // A `setFilter` onto `map` or another control falls back to the shared
      // exploration slice, which every component reads — the SDK's own
      // fallback, and always available.
      return undefined;
  }
}

function applyVerb(
  verb: CompositionInteractionVerb,
  ref: ParsedInteractionRef,
  args: Readonly<Record<string, unknown>>,
  payload: ControlChangePayload,
  components: StudioInteractionComponents | undefined,
): boolean {
  switch (verb) {
    case "setViewport": {
      const viewport = readViewport(args);
      if (!viewport || !components?.map?.setViewport) return false;
      components.map.setViewport(viewport);
      return true;
    }
    case "setVisibility": {
      if (ref.kind !== "layer" || !ref.id) return false;
      const layer = components?.layers?.[ref.id];
      if (!layer?.setVisibility) return false;
      layer.setVisibility(readVisible(args, payload));
      return true;
    }
    case "selectFeature": {
      if (ref.kind !== "layer" || !ref.id) return false;
      const layer = components?.layers?.[ref.id];
      const featureId = args.featureId ?? args.id ?? payload.value;
      if (!layer?.selectFeature || (typeof featureId !== "string" && typeof featureId !== "number")) return false;
      layer.selectFeature(featureId);
      return true;
    }
    case "setFilter": {
      const clause = readClause(args, payload);
      if (ref.kind === "layer" && ref.id) {
        const layer = components?.layers?.[ref.id];
        if (!layer?.setFilter) return false;
        layer.setFilter(clause);
        return true;
      }
      if (ref.kind === "widget" && ref.id) {
        const widget = components?.widgets?.[ref.id];
        if (!widget?.setFilter) return false;
        widget.setFilter(clause);
        return true;
      }
      return false;
    }
    case "runWidgetQuery":
      return false;
  }
}

function readViewport(args: Readonly<Record<string, unknown>>): InteractionViewport | undefined {
  const source = isPlainObject(args.view) ? args.view : isPlainObject(args.viewport) ? args.viewport : args;
  const viewport: Record<string, unknown> = {};
  for (const key of ["bbox", "center", "zoom", "pitch", "bearing"]) {
    if (source[key] !== undefined) viewport[key] = source[key];
  }
  return Object.keys(viewport).length > 0 ? (viewport as InteractionViewport) : undefined;
}

function readVisible(args: Readonly<Record<string, unknown>>, payload: ControlChangePayload): boolean {
  if (typeof args.visible === "boolean") return args.visible;
  if (typeof payload.value === "boolean") return payload.value;
  return Boolean(payload.value);
}

/**
 * The clause a `setFilter` verb applies. Static `args` win over the event's
 * own clause, so a binding can rewrite the field it filters on ("when the
 * district picker changes, filter parcels on `district_id`") — the exact
 * shape of the issue's second user workflow.
 */
function readClause(args: Readonly<Record<string, unknown>>, payload: ControlChangePayload): FilterClause | undefined {
  const authored = isPlainObject(args.clause) ? args.clause : undefined;
  const field = typeof args.field === "string" ? args.field : (authored?.field as string | undefined);
  const value = "value" in args ? args.value : authored?.value;
  const operator = (typeof args.operator === "string" ? args.operator : authored?.operator) as
    | FilterClause["operator"]
    | undefined;

  if (field === undefined && payload.clause === undefined) return undefined;
  if (field === undefined) {
    // No override at all: pass the control's own clause through unchanged.
    if (value === undefined && operator === undefined) return payload.clause;
    return {
      ...(payload.clause as FilterClause),
      ...(operator !== undefined ? { operator } : {}),
      ...(value !== undefined ? { value } : {}),
    };
  }
  const resolvedValue = value !== undefined ? value : payload.value;
  if (resolvedValue === undefined || resolvedValue === null || resolvedValue === "") return undefined;
  return {
    field,
    operator: operator ?? payload.operator ?? "=",
    value: resolvedValue,
  };
}
