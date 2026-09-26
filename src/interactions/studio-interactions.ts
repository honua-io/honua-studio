/**
 * The runtime that joins three things honua-studio#25 needs joined: the
 * composition document (which declares controls and bindings), the SDK's
 * exploration context (which is where a control's `change` actually lives),
 * and the map (which has to visibly move as a result).
 *
 * ## One transport, not a third one
 *
 * Every control gesture is published as a `FilterClause` keyed by the
 * control's own id, through `bindFilterControlsToExploration` — the published
 * `@honua/sdk-js/interactions` primitive. That single write is:
 *
 *  - what a `control:{id}` + `change` binding observes (the SDK's
 *    `compileHonuaInteractions` subscribes to the same slice on its own
 *    view), and
 *  - what this runtime reads back to compute the map's *appearance* — per
 *    layer filters and opacity.
 *
 * There is no Studio-private event bus, no second registry, and no direct
 * call from a control into the map. A control writes one clause; everything
 * downstream is a read.
 *
 * ## Why the map reads filters instead of being told
 *
 * `CompositionMapView` re-composes the whole style and hands it to MapLibre's
 * differ on every applied command. A filter set imperatively with
 * `map.setFilter(...)` would be reverted by the very next diff — composition
 * state is correct, the readout is correct, nothing throws, and the map
 * silently drops the filter. So filters and opacity are **projection
 * inputs**, applied where every other visual property is.
 *
 * They are deliberately *not* composition state: `StudioCompositionBody` has
 * no filter or opacity member (honua-server#3002/#3196), and inventing local
 * fields the server cannot persist would put the client's projection out of
 * step with the draft it is a projection of (AD-8). Exploration state is the
 * correct home — it is session state, and the SDK already owns it.
 *
 * @module
 */

import { createExplorationContext } from "@honua/sdk-js/exploration";
import type {
  ExplorationContext,
  ExplorationViewController,
  FeatureSelectionTarget,
  FilterClause,
} from "@honua/sdk-js/exploration";
import { bindFilterControlsToExploration, bindTableSelectionToExploration } from "@honua/sdk-js/interactions";
import {
  type CompileHonuaInteractionsOptions,
  type HonuaCompiledInteractions,
  type HonuaInteractionComponents,
  type HonuaInteractionDispatch,
  compileHonuaInteractions,
} from "@honua/sdk-js/interactions/declarative";

import type { CompositionController } from "../composition/controller.js";
import type { CompositionControl, CompositionState, CompositionTarget } from "../composition/model.js";
import { CONTROL_KIND_EMITS_CHANGE, controlTargetLayers, readControlConfig } from "../controls/control-config.js";
import { type MaplibreFilter, clausesToMaplibreFilter } from "./filter-expression.js";

/**
 * The pseudo-field an `opacity` control publishes under. It is a field name
 * no dataset can collide with, and it is what lets one clause channel carry
 * both "filter parcels to R-1" and "fade parcels to 40%" without the map's
 * filter translator ever seeing the latter — see {@link StudioInteractionRuntime}'s
 * appearance computation.
 */
export const OPACITY_CLAUSE_FIELD = "$honua:opacity";

/** Everything the map renders that composition state does not carry: per-layer filters and per-layer opacity. */
export interface StudioLayerAppearance {
  readonly filters: Readonly<Record<string, MaplibreFilter>>;
  readonly opacity: Readonly<Record<string, number>>;
}

export const EMPTY_LAYER_APPEARANCE: StudioLayerAppearance = { filters: {}, opacity: {} };

export interface StudioInteractionRuntimeOptions {
  readonly controller: CompositionController;
  /** Called whenever the computed appearance changes — the canvas hands it to the map view. */
  readonly onAppearanceChange?: (appearance: StudioLayerAppearance) => void;
  /** Called after every action a binding ran. The activity log's hook. */
  readonly onDispatch?: (dispatch: HonuaInteractionDispatch) => void;
}

/**
 * Holds one exploration context for the life of a composition session and
 * recompiles the interaction block whenever the document changes.
 *
 * Three exploration views, and the split matters:
 *
 *  - `controls` (role `filter`) — what control gestures publish through.
 *  - `interactions` (role `custom`) — what the SDK compiler subscribes on.
 *    Separate from `controls` so a verb's own write cannot wake the compiler:
 *    bound views ignore their own notifications.
 *  - `appearance` (role `map`) — what this runtime reads the merged filter
 *    state back through, to project onto the map.
 */
export class StudioInteractionRuntime {
  readonly #controller: CompositionController;
  readonly #context: ExplorationContext;
  readonly #controlsView: ExplorationViewController;
  readonly #compilerView: ExplorationViewController;
  readonly #appearanceView: ExplorationViewController;
  readonly #controlChannel: ReturnType<typeof bindFilterControlsToExploration>;
  readonly #options: StudioInteractionRuntimeOptions;
  #unsubscribeAppearance: (() => void) | undefined;
  #unsubscribeComposition: (() => void) | undefined;
  #unsubscribeSelection: (() => void) | undefined;
  #compiled: HonuaCompiledInteractions | undefined;
  /** Clauses a `setFilter` verb wrote, keyed `layerId` -> `interactionId` -> clause. Never published into the shared slice — that would be an action emitting an event. */
  readonly #verbFilters = new Map<string, Map<string, FilterClause>>();
  #appearance: StudioLayerAppearance = EMPTY_LAYER_APPEARANCE;
  #documentKey = "";
  #disposed = false;

  public constructor(options: StudioInteractionRuntimeOptions) {
    this.#options = options;
    this.#controller = options.controller;
    this.#context = createExplorationContext({
      datasetId: "honua-studio-composition",
      sourceIds: options.controller.state.layers.map((layer) => layer.sourceId),
    });
    this.#controlsView = this.#context.connectView({ id: "controls", role: "filter" });
    this.#compilerView = this.#context.connectView({ id: "interactions", role: "custom" });
    this.#appearanceView = this.#context.connectView({ id: "appearance", role: "map" });
    this.#controlChannel = bindFilterControlsToExploration(this.#controlsView);

    this.#unsubscribeAppearance = bindFilterControlsToExploration(this.#appearanceView).subscribe(
      () => this.#recomputeAppearance(),
      { includeSelf: true },
    );
    // The SDK compiler's `selectFeature` verb writes source-qualified targets
    // into the shared selection slice rather than calling a component method.
    // Composition selection is what Studio's chat chips and readout render, so
    // the runtime mirrors that one write across — a read, not a second
    // transport, and never a publish back into exploration.
    this.#unsubscribeSelection = bindTableSelectionToExploration(this.#compilerView).subscribe(
      (selection) => this.#onExplorationSelection(selection),
      { includeSelf: true },
    );
    this.#unsubscribeComposition = this.#controller.subscribe(() => this.#onCompositionChanged());
    this.#recompile();
  }

  /** The compiled interaction block, or `undefined` before the first compile. Its `issues`/`unsupported` are what the canvas reports. */
  public get compiled(): HonuaCompiledInteractions | undefined {
    return this.#compiled;
  }

  public get appearance(): StudioLayerAppearance {
    return this.#appearance;
  }

  /** The shared exploration context, for anything that wants to read selection/filters directly. */
  public get context(): ExplorationContext {
    return this.#context;
  }

  /**
   * The single entry point for a control gesture (REQ-002). Publishing a
   * clause under the control's own id is what "the control emitted `change`"
   * means on this transport — the compiler observes it, and the map's
   * appearance is recomputed from it.
   *
   * `undefined` clears the control's clause, which is what an "All" option
   * or a cleared date range means.
   */
  public publishControlChange(controlId: string, clause: FilterClause | undefined): void {
    if (this.#disposed) return;
    if (clause === undefined) this.#controlChannel.clearFilter(controlId);
    else this.#controlChannel.setFilter(controlId, clause);
  }

  /** Convenience for an `opacity` control: publishes its value on the shared channel under {@link OPACITY_CLAUSE_FIELD}. */
  public publishOpacity(controlId: string, value: number): void {
    this.publishControlChange(controlId, { field: OPACITY_CLAUSE_FIELD, operator: "=", value });
  }

  /** The clause a control currently holds, so a re-render can show the control at its live value rather than its authored default. */
  public clauseFor(controlId: string): FilterClause | undefined {
    return this.#controlsView.state.filters[controlId];
  }

  public dispose(): void {
    this.#disposed = true;
    this.#unsubscribeAppearance?.();
    this.#unsubscribeAppearance = undefined;
    this.#unsubscribeComposition?.();
    this.#unsubscribeComposition = undefined;
    this.#unsubscribeSelection?.();
    this.#unsubscribeSelection = undefined;
    this.#compiled?.dispose();
    this.#compiled = undefined;
    this.#context.dispose();
  }

  // -------------------------------------------------------------------------
  // Compilation
  // -------------------------------------------------------------------------

  #onCompositionChanged(): void {
    const key = this.#documentIdentity();
    if (key !== this.#documentKey) this.#recompile();
    // Layers can appear after a control does; the appearance has to follow.
    this.#recomputeAppearance();
  }

  /** A cheap identity over just the parts a compile depends on — recompiling on every camera nudge would tear down live bindings for nothing. */
  #documentIdentity(): string {
    const state = this.#controller.state;
    return JSON.stringify([
      state.interactions,
      state.controls.map((control) => control.id),
      state.layers.map((layer) => layer.id),
      state.widgets.map((widget) => widget.id),
    ]);
  }

  #recompile(): void {
    this.#documentKey = this.#documentIdentity();
    this.#compiled?.dispose();
    this.#verbFilters.clear();
    const options: CompileHonuaInteractionsOptions = {
      view: this.#compilerView,
      components: this.#components(),
      ...(this.#options.onDispatch !== undefined ? { onDispatch: this.#options.onDispatch } : {}),
    };
    this.#compiled = compileHonuaInteractions(this.#controller.state.interactions, options);
  }

  /**
   * Builds the component registry the SDK compiler resolves refs against
   * (`map` / `layers` / `widgets` / `controls`). Each adapter is the one
   * place a compiled verb re-enters Studio: `setVisibility` and `setViewport`
   * become composition commands, `setFilter` becomes a projection input.
   *
   * No layer declares a `map`, so `featureSelect`/`featureHover` bindings
   * come back as `unsupported` with the SDK's own reason rather than binding
   * to a MapLibre handle this runtime does not own — Studio's map click path
   * is `CompositionMapView`'s, and routing it through the compiler is
   * honua-studio#43's scope, not this module's.
   */
  #components(): HonuaInteractionComponents {
    const state = this.#controller.state;
    const layerComponents: Record<string, NonNullable<HonuaInteractionComponents["layers"]>[string]> = {};
    for (const layer of state.layers) {
      layerComponents[layer.id] = {
        sourceId: layer.sourceId,
        setVisibility: (visible: boolean) => {
          this.#applyCommand({ name: "setVisibility", target: { kind: "layer", id: layer.id }, visible });
        },
        setFilter: (clause: FilterClause | undefined) => {
          this.#setVerbFilter(layer.id, clause);
        },
      };
    }
    const widgetComponents: Record<string, NonNullable<HonuaInteractionComponents["widgets"]>[string]> = {};
    for (const widget of state.widgets) widgetComponents[widget.id] = {};
    const controlComponents: Record<string, NonNullable<HonuaInteractionComponents["controls"]>[string]> = {};
    for (const control of state.controls) controlComponents[control.id] = {};

    return {
      map: {
        setViewport: (viewport) => {
          this.#applyCommand({ name: "setView", view: { ...viewport } });
        },
      },
      layers: layerComponents,
      widgets: widgetComponents,
      controls: controlComponents,
    };
  }

  /**
   * Mirrors an exploration selection written by a `selectFeature` verb onto
   * composition selection. Raw (unqualified) feature ids are skipped: Studio
   * is a multi-source app, and a target with no `sourceId` names no layer.
   */
  #onExplorationSelection(selection: ReadonlyArray<FeatureSelectionTarget>): void {
    if (this.#disposed) return;
    const targets: CompositionTarget[] = [];
    for (const entry of selection) {
      if (typeof entry !== "object" || entry === null) continue;
      targets.push({ kind: "feature", sourceId: entry.sourceId, featureId: entry.id });
    }
    this.#controller.select(targets);
  }

  /** Runs an action's composition command. Rejections (a pinned layer above all) are swallowed here by design — an action is not allowed to throw into a control's event handler. */
  #applyCommand(command: unknown): void {
    try {
      this.#controller.apply(command);
    } catch {
      // The reducer already refused; the control re-renders from real state.
    }
  }

  #setVerbFilter(layerId: string, clause: FilterClause | undefined): void {
    const existing = this.#verbFilters.get(layerId) ?? new Map<string, FilterClause>();
    // One slot per layer for verb-driven filters: two bindings both filtering
    // the same layer are a last-write-wins race in any implementation, and
    // pretending otherwise by ANDing them would make the second binding
    // silently unsatisfiable.
    if (clause === undefined) existing.delete("verb");
    else existing.set("verb", clause);
    if (existing.size === 0) this.#verbFilters.delete(layerId);
    else this.#verbFilters.set(layerId, existing);
    this.#recomputeAppearance();
  }

  // -------------------------------------------------------------------------
  // Appearance
  // -------------------------------------------------------------------------

  /**
   * Recomputes per-layer filters and opacity from the shared filter slice.
   *
   * Two sources feed it, and they are kept apart on purpose:
   *
   *  - a control's **own** clause scopes to the layers its `sourceId` names.
   *    A filter bar filters the thing it reads from; that is the plain
   *    reading of ADR-0031's `sourceId` ("the layer whose field values
   *    populate a filterSelect") and it is why a filter control is useful
   *    before anyone authors a binding.
   *  - a **verb-driven** clause scopes to the layer the binding named. That
   *    is the "when the district filter changes, filter the parcels layer"
   *    case, and it is the only way one layer's control reaches another's
   *    features.
   */
  #recomputeAppearance(): void {
    if (this.#disposed) return;
    const state = this.#controller.state;
    const filters = this.#appearanceView.state.filters;
    const perLayer = new Map<string, FilterClause[]>();
    const opacity: Record<string, number> = {};

    for (const control of state.controls) {
      const clause = filters[control.id];
      if (!clause) continue;
      if (clause.field === OPACITY_CLAUSE_FIELD) {
        for (const layerId of opacityTargets(state, control)) {
          const value = typeof clause.value === "number" ? clause.value : Number(clause.value);
          if (Number.isFinite(value)) opacity[layerId] = Math.min(Math.max(value, 0), 1);
        }
        continue;
      }
      if (!CONTROL_KIND_EMITS_CHANGE[control.kind]) continue;
      for (const layerId of controlTargetLayers(state, control.sourceId)) {
        const list = perLayer.get(layerId) ?? [];
        list.push(clause);
        perLayer.set(layerId, list);
      }
    }

    for (const [layerId, clauses] of this.#verbFilters) {
      const list = perLayer.get(layerId) ?? [];
      list.push(...clauses.values());
      perLayer.set(layerId, list);
    }

    const compiledFilters: Record<string, MaplibreFilter> = {};
    for (const [layerId, clauses] of perLayer) {
      const layer = state.layers.find((entry) => entry.id === layerId);
      const expression = clausesToMaplibreFilter(clauses, layer ? [layer.id, layer.sourceId] : [layerId]);
      if (expression) compiledFilters[layerId] = expression;
    }

    const next: StudioLayerAppearance = { filters: compiledFilters, opacity };
    if (appearanceEqual(next, this.#appearance)) return;
    this.#appearance = next;
    this.#options.onAppearanceChange?.(next);
  }
}

/** Layers an `opacity` control drives: its normalized `layerIds`, which already fold in `sourceId`. */
function opacityTargets(state: CompositionState, control: CompositionControl): readonly string[] {
  if (control.kind !== "opacity") return [];
  const normalized = readControlConfig(control);
  if (!normalized.ok || normalized.config.kind !== "opacity") return [];
  return normalized.config.config.layerIds.filter((layerId) => state.layers.some((layer) => layer.id === layerId));
}

function appearanceEqual(a: StudioLayerAppearance, b: StudioLayerAppearance): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Re-exported so a caller needs one import for the whole interaction surface. */
export type { CompositionTarget };
