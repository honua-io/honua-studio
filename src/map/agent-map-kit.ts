/**
 * Studio's composition, exposed to a model as the SDK's own agent tool
 * surface (honua-studio#23 REQ-002: "consume `createHonuaAiMapKit` and the
 * SDK runtime adapters rather than growing a parallel rendering path").
 *
 * The SDK's `HonuaAgentRuntime` is a small duck-typed interface, which is
 * exactly what makes this honest rather than ceremonial: Studio's composition
 * controller *is* a map runtime, so it is adapted to that interface rather
 * than wrapped in a translation layer that pretends to be one. Every mutating
 * method here routes back through `controller.apply(...)` — the same reducer
 * the chat's tool calls, the fixture conversations, and undo/redo all use.
 * There is no second write path, so nothing an agent does through the kit can
 * bypass pin enforcement, history, or draft sync.
 *
 * What that buys, today, from published `@honua/sdk-js`:
 *
 *  - `kit.tools` / `kit.mcpTools` / `kit.providerTools` — tool definitions in
 *    Honua, MCP, and OpenAI shapes, so the same composition is drivable from
 *    the server AI proxy, an external MCP client, or a provider-native
 *    function-calling loop (#1 REQ-010).
 *  - `kit.context()` / `kit.systemPrompt()` — the capability-aware semantic
 *    map context that stops a model inventing layers or capabilities
 *    (#1 REQ-001).
 *  - `kit.execute(call)` — policy-gated execution (`readOnly`, `allowActions`,
 *    `allowedTools`, audit hooks) rather than Studio hand-rolling its own
 *    permission checks.
 *
 * **Seam for sdk-js#1259.** That PR adds a `StudioAgentSession` plus five
 * composition verbs and the declarative interaction compiler; it is unmerged,
 * so this repo pins and builds against what is published. When it lands, the
 * change is confined to {@link createStudioAiMapKit}: construct the session
 * and hand it this same runtime. Nothing outside this module knows how the
 * kit was built — `<honua-studio-app>` only reads `.aiMapKit`.
 *
 * @module
 */

import {
  type HonuaAgentLayerSummary,
  type HonuaAgentMapSnapshot,
  type HonuaAgentRuntime,
  type HonuaAgentSourceSummary,
  type HonuaAgentViewport,
  type HonuaAiMapKit,
  type HonuaAiMapKitPolicy,
  createHonuaAiMapKit,
} from "@honua/sdk-js/agent-tools";

import type { CompositionController } from "../composition/controller.js";
import type { CompositionTarget, CompositionView } from "../composition/model.js";
import { DEFAULT_MAP_PACKAGE_ID } from "./constants.js";
import type { CompositionSourceDescriptor } from "./source-resolution.js";

export interface CompositionAgentRuntimeOptions {
  readonly controller: CompositionController;
  /** Sources the server advertises. The agent may only reference what is in here — #1 REQ-001's "never inventing data". */
  readonly catalog?: readonly CompositionSourceDescriptor[];
  readonly mapPackageId?: string;
}

function viewportFromView(view: CompositionView): HonuaAgentViewport {
  return {
    ...(view.bbox !== undefined ? { bbox: view.bbox } : {}),
    ...(view.center !== undefined ? { center: view.center } : {}),
    ...(view.zoom !== undefined ? { zoom: view.zoom } : {}),
    ...(view.pitch !== undefined ? { pitch: view.pitch } : {}),
    ...(view.bearing !== undefined ? { bearing: view.bearing } : {}),
  };
}

function viewFromViewport(viewport: HonuaAgentViewport): Partial<CompositionView> {
  return {
    ...(viewport.bbox !== undefined ? { bbox: viewport.bbox as readonly [number, number, number, number] } : {}),
    ...(viewport.center !== undefined ? { center: viewport.center as readonly [number, number] } : {}),
    ...(viewport.zoom !== undefined ? { zoom: viewport.zoom } : {}),
    ...(viewport.pitch !== undefined ? { pitch: viewport.pitch } : {}),
    ...(viewport.bearing !== undefined ? { bearing: viewport.bearing } : {}),
  };
}

/** Adapts one {@link CompositionController} (plus the catalog it may draw from) to the SDK's `HonuaAgentRuntime`. */
export function createCompositionAgentRuntime(options: CompositionAgentRuntimeOptions): HonuaAgentRuntime {
  const { controller } = options;

  const listSources = (): readonly HonuaAgentSourceSummary[] =>
    (options.catalog ?? []).map((descriptor) => ({
      id: descriptor.id,
      ...(descriptor.title !== undefined ? { title: descriptor.title } : {}),
      ...(descriptor.protocol !== undefined
        ? { protocol: descriptor.protocol as HonuaAgentSourceSummary["protocol"] }
        : {}),
      ...(descriptor.geometryType !== undefined ? { metadata: { geometryType: descriptor.geometryType } } : {}),
    }));

  const listLayers = (): readonly HonuaAgentLayerSummary[] =>
    controller.state.layers.map((layer) => ({
      id: layer.id,
      sourceId: layer.sourceId,
      visible: layer.visible,
      ...(layer.title !== undefined ? { title: layer.title } : {}),
      ...(layer.styleRef !== undefined ? { metadata: { styleId: layer.styleRef.styleId } } : {}),
    }));

  // Feature selection lives in the SDK's exploration context, not in
  // composition state (see `../composition/model.ts`'s CompositionTargetKind
  // note), so this reports the ephemeral selection the canvas set rather
  // than pretending composition owns it.
  const selectedFeatureTargets = () =>
    controller.selection
      .filter(
        (target): target is Extract<CompositionController["selection"][number], { kind: "feature" }> =>
          target.kind === "feature",
      )
      .map((target) => ({ sourceId: target.sourceId, id: target.featureId }));

  const snapshot = (): HonuaAgentMapSnapshot => ({
    mapPackageId: options.mapPackageId ?? DEFAULT_MAP_PACKAGE_ID,
    viewport: viewportFromView(controller.state.view),
    sources: listSources(),
    layers: listLayers(),
    selection: selectedFeatureTargets(),
  });

  return {
    id: "honua-studio-composition",
    inspectMap: () => snapshot(),
    snapshot: () => snapshot(),
    listSources,
    listLayers,
    getViewport: () => viewportFromView(controller.state.view),
    setViewport: (viewport) => {
      // Through the reducer, never around it — see this module's doc.
      controller.apply({ name: "setView", view: viewFromViewport(viewport) });
    },
    addLayer: (layer) => {
      const id = typeof layer.id === "string" ? layer.id : undefined;
      const sourceId = typeof layer.sourceId === "string" ? layer.sourceId : id;
      if (!id || !sourceId) {
        throw new Error("addLayer requires a layer with a string id (and sourceId, when it differs from the id).");
      }
      controller.apply({
        name: "addLayer",
        layer: { id, sourceId, ...(typeof layer.title === "string" ? { title: layer.title } : {}) },
      });
    },
    getSelection: selectedFeatureTargets,
    /**
     * The agent's half of honua-studio#24 REQ-005. A grid row and the SDK's
     * `selectFeature` tool must mean the same thing, so both land on
     * `controller.select(...)` — the same ephemeral deictic selection a map
     * click sets. Without this the tool was simply absent from the kit, and
     * "select the parcel in row 3" had no route back into the composition.
     *
     * Selection is ephemeral rather than a command, so it does not go
     * through `apply()`: it is not part of composition state (see
     * `../composition/model.ts`'s CompositionTargetKind note) and must not
     * enter undo history.
     */
    selectFeature: (target, selectOptions) => {
      // `FeatureSelectionTarget` is `FeatureId | SourceQualifiedFeatureSelectionTarget`.
      // A composition `feature` target is source-qualified by definition, so a
      // bare id is rejected rather than guessed at — attributing a feature to
      // the wrong layer would produce a confidently wrong "THIS".
      const qualified = typeof target === "object" && target !== null ? target : undefined;
      const sourceId = typeof qualified?.sourceId === "string" ? qualified.sourceId : undefined;
      const featureId = qualified?.id;
      if (!sourceId || (typeof featureId !== "string" && typeof featureId !== "number")) {
        throw new Error("selectFeature requires a source-qualified target: { sourceId, id }.");
      }
      const next: CompositionTarget = { kind: "feature", sourceId, featureId };
      // `replace` defaults to true, matching the SDK controller's own default
      // and the canvas's click behaviour (one click, one "THIS").
      controller.select(selectOptions?.replace === false ? [...controller.selection, next] : [next]);
      return selectedFeatureTargets();
    },
  };
}

export interface StudioAiMapKitOptions extends CompositionAgentRuntimeOptions {
  readonly policy?: HonuaAiMapKitPolicy;
}

/**
 * Builds the SDK AI map kit over Studio's composition.
 *
 * `allowActions: true` is the default because composing IS the product — the
 * SDK's executor is conservative by design (an action-mode tool is denied
 * unless the host opts in), and a Studio whose agent could only *read* the
 * map would be pointless. The safety story does not rest on this flag: the
 * data plane is read-only regardless (#1 REQ-005 / server ADR-0028), every
 * write goes through the reducer's validation and pin enforcement, and the
 * caller's own `policy` is spread last so a host can still narrow to
 * `readOnly`, an allow-list, or a dry run without Studio inventing a
 * parallel permission model.
 */
export function createStudioAiMapKit(options: StudioAiMapKitOptions): HonuaAiMapKit {
  const runtime = createCompositionAgentRuntime(options);
  return createHonuaAiMapKit({ runtime, policy: { allowActions: true, ...(options.policy ?? {}) } });
}
