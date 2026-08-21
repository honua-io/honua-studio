/**
 * The tool-name translation table (honua-studio#7 — the module `tool-call.ts`
 * names as this issue's job, spec REQ-002/AD-8). ONE table resolves BOTH
 * vocabularies a tool-call intent may arrive in:
 *
 *  - This engine's own vocabulary (`../composition/commands.ts`'s
 *    `CompositionCommandName` — `addLayer`, `removeLayer`, …) — the shape
 *    `../composition/fixture-conversation.ts`'s `toolCallToCommand` already
 *    handles; entries here just add server-tool-name metadata to it.
 *  - honua-studio#6's chat-fixture vocabulary (snake_case —
 *    `add_layer`/`add_chart`, argument shapes like `{ datasetId, styleBy }`)
 *    — see `../composition/tool-call.ts`'s module doc for the exact mismatch
 *    this closes.
 *  - honua-server#3002's MCP tool names (`honua_studio_add_layer`, …,
 *    `../mcp/studio-tools.ts`'s wire argument shapes) — needed both for the
 *    AD-8 authoritative path (this app calling those tools itself) and for
 *    interpreting an inbound `tools/call` request the SAME way an external
 *    MCP client's request would be interpreted (the parity test in
 *    `test/mcp/external-client-parity.test.ts` exercises exactly this).
 *
 * Every entry resolves to the SAME composition semantics — a
 * {@link CompositionCommand} — via `commands.ts`'s
 * {@link validateCompositionCommand}, so a command built here is validated
 * exactly the same way a `../composition/reducer.ts`-applied command always
 * is; this module never invents a second validation path.
 *
 * `resolveToolCall` never throws and never silently drops an unrecognized or
 * unsupported tool: every outcome is a typed, stated-reason
 * {@link ToolBridgeResolution} — `"unknown-tool"` (never heard of it),
 * `"unsupported"` (recognized, but no composition semantics exist for it —
 * e.g. a read-only query tool, or a filter concept this engine's v0 command
 * set doesn't have), or `"invalid-arguments"` (recognized and in-scope, but
 * this specific call's arguments don't translate).
 *
 * @module
 */
import type { CompositionCommand, CompositionCommandName } from "../composition/commands.js";
import { validateCompositionCommand } from "../composition/commands.js";
import type { CompositionState, CompositionStyleRef, CompositionTarget } from "../composition/model.js";
import { createEmptyCompositionState } from "../composition/model.js";
import type { CompositionToolCall } from "../composition/tool-call.js";
import type {
  StudioCompositionBodyWire,
  StudioMcpControlInput,
  StudioMcpDraft,
  StudioMcpInteractionInput,
  StudioMcpLayerInput,
  StudioMcpToolName,
  StudioMcpViewInput,
  StudioMcpWidgetInput,
} from "./studio-tools.js";

// ---------------------------------------------------------------------------
// Resolution result
// ---------------------------------------------------------------------------

export type ToolBridgeVocabulary = "composition" | "chat-fixture" | "server-mcp";

export type ToolBridgeErrorCode = "unknown-tool" | "unsupported" | "invalid-arguments";

export interface ToolBridgeFailure {
  readonly ok: false;
  readonly toolName: string;
  readonly code: ToolBridgeErrorCode;
  readonly reason: string;
}

export interface ToolBridgeSuccess {
  readonly ok: true;
  readonly toolName: string;
  readonly vocabulary: ToolBridgeVocabulary;
  readonly command: CompositionCommand;
  /**
   * The `honua_studio_*` tool this command maps to for the AD-8 authoritative
   * path, or `undefined` when the command has no server-side counterpart
   * (`addAnnotation`/`removeAnnotation`/`pin`/`unpin` — annotations and pins
   * are not part of the server's `StudioCompositionBody` wire schema at all;
   * they stay local-only regardless of session mode — see
   * `orchestrator.ts`'s module doc).
   */
  readonly serverToolName?: StudioMcpToolName;
}

export type ToolBridgeResolution = ToolBridgeSuccess | ToolBridgeFailure;

function failure(toolName: string, code: ToolBridgeErrorCode, reason: string): ToolBridgeFailure {
  return { ok: false, toolName, code, reason };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

type BuildResult =
  | { readonly ok: true; readonly command: CompositionCommand }
  | { readonly ok: false; readonly reason: string };

/** Runs `commands.ts`'s own structural validator — the ONE validation path every command built here goes through, same as a directly-applied command. */
function finalizeCommand(name: CompositionCommandName, fields: Record<string, unknown>): BuildResult {
  const validation = validateCompositionCommand({ name, ...fields });
  if (!validation.ok) return { ok: false, reason: validation.errors.join("; ") };
  return { ok: true, command: validation.command };
}

function styleRefFromString(styleRef: unknown): CompositionStyleRef | undefined {
  return isNonEmptyString(styleRef) ? { kind: "style-ref", styleId: styleRef } : undefined;
}

// ---------------------------------------------------------------------------
// Bridge table entries
// ---------------------------------------------------------------------------

interface BridgeTableEntry {
  readonly vocabulary: ToolBridgeVocabulary;
  readonly serverToolName?: StudioMcpToolName;
  readonly build: (args: Record<string, unknown>) => BuildResult;
}

/** Recognized tools with NO composition-semantics mapping — a typed, stated reason rather than a generic "unknown tool". */
const UNSUPPORTED_TOOL_REASONS: Readonly<Record<string, string>> = {
  filter_layer:
    'filter_layer has no composition-engine counterpart yet — the v0 command set (see commands.ts\'s COMPOSITION_COMMAND_NAMES) has no "filter" concept.',
  get_feature_attributes:
    "get_feature_attributes is a read-only data query, not a composition mutation — it does not map to any composition command.",
};

function compositionPassthroughEntry(
  name: CompositionCommandName,
  serverToolName?: StudioMcpToolName,
): BridgeTableEntry {
  return {
    vocabulary: "composition",
    serverToolName,
    // Matches `fixture-conversation.ts`'s `toolCallToCommand`: this engine's
    // own vocabulary already IS the command's own field bag.
    build: (args) => finalizeCommand(name, args),
  };
}

const TOOL_BRIDGE_TABLE: Readonly<Record<string, BridgeTableEntry>> = {
  // ---- This engine's own vocabulary (camelCase) --------------------------
  addLayer: compositionPassthroughEntry("addLayer", "honua_studio_add_layer"),
  removeLayer: compositionPassthroughEntry("removeLayer", "honua_studio_remove_layer"),
  setLayerStyleRef: compositionPassthroughEntry("setLayerStyleRef", "honua_studio_set_layer_style"),
  // TOC/compare/time toggles and agent-authored visibility changes delegate
  // to the granular server tool. Removal gate: sdk-js#1288; until the SDK
  // session classifies it, Studio keeps this narrow direct mapping.
  setVisibility: compositionPassthroughEntry("setVisibility", "honua_studio_set_layer_visibility"),
  setView: compositionPassthroughEntry("setView", "honua_studio_set_view"),
  addWidget: compositionPassthroughEntry("addWidget", "honua_studio_add_widget"),
  removeWidget: compositionPassthroughEntry("removeWidget", "honua_studio_remove_widget"),
  // Controls and interactions use their landed granular server tools. They
  // share the sdk-js#1288 removal gate with visibility in the live session.
  addControl: compositionPassthroughEntry("addControl", "honua_studio_add_control"),
  removeControl: compositionPassthroughEntry("removeControl", "honua_studio_remove_control"),
  bindInteraction: compositionPassthroughEntry("bindInteraction", "honua_studio_bind_interaction"),
  removeInteraction: compositionPassthroughEntry("removeInteraction", "honua_studio_remove_interaction"),
  addAnnotation: compositionPassthroughEntry("addAnnotation"),
  removeAnnotation: compositionPassthroughEntry("removeAnnotation"),
  pin: compositionPassthroughEntry("pin"),
  unpin: compositionPassthroughEntry("unpin"),

  // ---- honua-studio#6's chat-fixture vocabulary (snake_case) -------------
  // `src/chat/fixtures/compose-districts-map.json`'s `add_layer`:
  // `{ datasetId, styleBy }`. `styleBy` is treated as a style catalog id —
  // the fixture's own placeholder vocabulary doesn't distinguish "style id"
  // from "classification attribute"; this bridge's interpretation is a
  // style-ref binding, documented here since it's a judgment call.
  add_layer: {
    vocabulary: "chat-fixture",
    serverToolName: "honua_studio_add_layer",
    build: (args) => {
      if (!isNonEmptyString(args.datasetId)) {
        return { ok: false, reason: 'add_layer requires a non-empty string "datasetId".' };
      }
      const layer: Record<string, unknown> = { id: args.datasetId, sourceId: args.datasetId };
      const styleRef = styleRefFromString(args.styleBy);
      if (styleRef) layer.styleRef = styleRef;
      return finalizeCommand("addLayer", { layer });
    },
  },
  // `add_chart`: `{ datasetId, groupBy, chartType }` -> a `chart` widget
  // bound to the dataset, `groupBy`/`chartType` preserved as opaque config
  // (the composition engine's widget `config` is intentionally free-form).
  add_chart: {
    vocabulary: "chat-fixture",
    serverToolName: "honua_studio_add_widget",
    build: (args) => {
      if (!isNonEmptyString(args.datasetId)) {
        return { ok: false, reason: 'add_chart requires a non-empty string "datasetId".' };
      }
      const groupBy = typeof args.groupBy === "string" ? args.groupBy : undefined;
      const chartType = typeof args.chartType === "string" ? args.chartType : undefined;
      const id = groupBy ? `chart-${args.datasetId}-${groupBy}` : `chart-${args.datasetId}`;
      const config: Record<string, unknown> = {};
      if (groupBy !== undefined) config.groupBy = groupBy;
      if (chartType !== undefined) config.chartType = chartType;
      const widget: Record<string, unknown> = { id, kind: "chart", sourceId: args.datasetId };
      if (Object.keys(config).length > 0) widget.config = config;
      return finalizeCommand("addWidget", { widget });
    },
  },

  // ---- honua-server#3002's honua_studio_* vocabulary ----------------------
  honua_studio_add_layer: {
    vocabulary: "server-mcp",
    serverToolName: "honua_studio_add_layer",
    build: (args) => {
      const layerInput = args.layer;
      if (!isPlainObject(layerInput) || !isNonEmptyString(layerInput.id)) {
        return { ok: false, reason: 'honua_studio_add_layer requires "layer.id".' };
      }
      const layer: Record<string, unknown> = {
        id: layerInput.id,
        // The server schema does not require `sourceId`; this engine's
        // AddLayerInput does — default to the layer id itself (an unbound
        // decorative layer is still addressable by its own id).
        sourceId: isNonEmptyString(layerInput.sourceId) ? layerInput.sourceId : layerInput.id,
      };
      if (typeof layerInput.title === "string") layer.title = layerInput.title;
      if (typeof layerInput.visible === "boolean") layer.visible = layerInput.visible;
      const styleRef = styleRefFromString(layerInput.styleRef);
      if (styleRef) layer.styleRef = styleRef;
      if (isPlainObject(layerInput.metadata)) layer.metadata = layerInput.metadata;

      const fields: Record<string, unknown> = { layer };
      if (typeof args.beforeId === "string") fields.beforeId = args.beforeId;
      return finalizeCommand("addLayer", fields);
    },
  },
  honua_studio_remove_layer: {
    vocabulary: "server-mcp",
    serverToolName: "honua_studio_remove_layer",
    build: (args) => {
      if (!isNonEmptyString(args.layerId)) {
        return { ok: false, reason: 'honua_studio_remove_layer requires a non-empty string "layerId".' };
      }
      return finalizeCommand("removeLayer", { target: { kind: "layer", id: args.layerId } });
    },
  },
  honua_studio_set_layer_style: {
    vocabulary: "server-mcp",
    serverToolName: "honua_studio_set_layer_style",
    build: (args) => {
      if (!isNonEmptyString(args.layerId)) {
        return { ok: false, reason: 'honua_studio_set_layer_style requires a non-empty string "layerId".' };
      }
      const fields: Record<string, unknown> = { target: { kind: "layer", id: args.layerId } };
      const styleRef = styleRefFromString(args.styleRef);
      if (styleRef) fields.styleRef = styleRef;
      return finalizeCommand("setLayerStyleRef", fields);
    },
  },
  honua_studio_set_layer_visibility: {
    vocabulary: "server-mcp",
    serverToolName: "honua_studio_set_layer_visibility",
    build: (args) => {
      if (!isNonEmptyString(args.layerId) || typeof args.visible !== "boolean") {
        return { ok: false, reason: 'honua_studio_set_layer_visibility requires "layerId" and boolean "visible".' };
      }
      return finalizeCommand("setVisibility", {
        target: { kind: "layer", id: args.layerId },
        visible: args.visible,
      });
    },
  },
  honua_studio_set_view: {
    vocabulary: "server-mcp",
    serverToolName: "honua_studio_set_view",
    build: (args) => {
      if (!isPlainObject(args.view)) {
        return { ok: false, reason: 'honua_studio_set_view requires a "view" object.' };
      }
      // `crs` has no counterpart in `CompositionView` — dropped, not an error.
      const { bbox, center, zoom, pitch, bearing } = args.view;
      const view: Record<string, unknown> = {};
      if (bbox !== undefined) view.bbox = bbox;
      if (center !== undefined) view.center = center;
      if (zoom !== undefined) view.zoom = zoom;
      if (pitch !== undefined) view.pitch = pitch;
      if (bearing !== undefined) view.bearing = bearing;
      return finalizeCommand("setView", { view });
    },
  },
  honua_studio_add_widget: {
    vocabulary: "server-mcp",
    serverToolName: "honua_studio_add_widget",
    build: (args) => {
      const widgetInput = args.widget;
      if (!isPlainObject(widgetInput) || !isNonEmptyString(widgetInput.id) || !isNonEmptyString(widgetInput.kind)) {
        return { ok: false, reason: 'honua_studio_add_widget requires "widget.id" and "widget.kind".' };
      }
      return finalizeCommand("addWidget", { widget: widgetInput });
    },
  },
  honua_studio_remove_widget: {
    vocabulary: "server-mcp",
    serverToolName: "honua_studio_remove_widget",
    build: (args) => {
      if (!isNonEmptyString(args.widgetId)) {
        return { ok: false, reason: 'honua_studio_remove_widget requires a non-empty string "widgetId".' };
      }
      return finalizeCommand("removeWidget", { target: { kind: "component", id: args.widgetId } });
    },
  },
  // honua-server#3196's tool names, understood on the INBOUND side already:
  // an external MCP client (or the model, once the tools are advertised) may
  // call them against this app's tool plane before this app is calling them
  // outbound, and refusing to interpret a call whose semantics we implement
  // would be the wrong kind of strict.
  honua_studio_add_control: {
    vocabulary: "server-mcp",
    serverToolName: "honua_studio_add_control",
    build: (args) => {
      const controlInput = args.control;
      if (!isPlainObject(controlInput) || !isNonEmptyString(controlInput.id) || !isNonEmptyString(controlInput.kind)) {
        return { ok: false, reason: 'honua_studio_add_control requires "control.id" and "control.kind".' };
      }
      return finalizeCommand("addControl", { control: controlInput });
    },
  },
  honua_studio_remove_control: {
    vocabulary: "server-mcp",
    serverToolName: "honua_studio_remove_control",
    build: (args) => {
      if (!isNonEmptyString(args.controlId)) {
        return { ok: false, reason: 'honua_studio_remove_control requires a non-empty string "controlId".' };
      }
      return finalizeCommand("removeControl", {
        target: { kind: "control", id: args.controlId },
        ...(typeof args.cascadeInteractions === "boolean" ? { cascadeInteractions: args.cascadeInteractions } : {}),
      });
    },
  },
  honua_studio_bind_interaction: {
    vocabulary: "server-mcp",
    serverToolName: "honua_studio_bind_interaction",
    build: (args) => {
      const interaction = args.interaction;
      if (!isPlainObject(interaction)) {
        return { ok: false, reason: 'honua_studio_bind_interaction requires an "interaction" object.' };
      }
      return finalizeCommand("bindInteraction", { interaction });
    },
  },
  honua_studio_remove_interaction: {
    vocabulary: "server-mcp",
    serverToolName: "honua_studio_remove_interaction",
    build: (args) => {
      if (!isNonEmptyString(args.interactionId)) {
        return { ok: false, reason: 'honua_studio_remove_interaction requires a non-empty string "interactionId".' };
      }
      return finalizeCommand("removeInteraction", { interactionId: args.interactionId });
    },
  },
};

// ---------------------------------------------------------------------------
// resolveToolCall
// ---------------------------------------------------------------------------

/**
 * Resolves one `{ toolName, arguments }` tool-call intent — from a chat
 * event, a fixture script, or an inbound `tools/call` request — into a
 * validated {@link CompositionCommand}, or a typed, stated-reason failure.
 * Never throws.
 */
export function resolveToolCall(call: CompositionToolCall): ToolBridgeResolution {
  const unsupportedReason = UNSUPPORTED_TOOL_REASONS[call.toolName];
  if (unsupportedReason) return failure(call.toolName, "unsupported", unsupportedReason);

  const entry = TOOL_BRIDGE_TABLE[call.toolName];
  if (!entry) {
    return failure(
      call.toolName,
      "unknown-tool",
      `"${call.toolName}" is not a tool this bridge (fixture, honua_studio_*, or this engine's own vocabulary) recognizes.`,
    );
  }

  const args = isPlainObject(call.arguments) ? call.arguments : {};
  const built = entry.build(args);
  if (!built.ok) return failure(call.toolName, "invalid-arguments", built.reason);

  return {
    ok: true,
    toolName: call.toolName,
    vocabulary: entry.vocabulary,
    command: built.command,
    serverToolName: entry.serverToolName,
  };
}

/** Every tool name this bridge resolves — useful for tests and for a host that wants to advertise supported tool names. */
export function bridgedToolNames(): readonly string[] {
  return Object.keys(TOOL_BRIDGE_TABLE);
}

// ---------------------------------------------------------------------------
// Server tool argument construction (the AD-8 authoritative path)
// ---------------------------------------------------------------------------

export interface ServerToolInvocation {
  readonly name: StudioMcpToolName;
  readonly arguments: Record<string, unknown>;
}

/**
 * Builds the `honua_studio_*` tool arguments for a resolved command,
 * given the draft this session is composing against. Returns `undefined`
 * when the command has no server-tool counterpart (see
 * {@link ToolBridgeSuccess.serverToolName}'s doc) — callers should check
 * `serverToolName` before calling this, but it degrades gracefully either
 * way rather than throwing.
 */
export function buildServerToolInvocation(
  resolution: ToolBridgeSuccess,
  context: { readonly draftId: string; readonly generation: number },
): ServerToolInvocation | undefined {
  const { command } = resolution;
  const base = { draftId: context.draftId, generation: context.generation };
  switch (command.name) {
    case "addLayer": {
      const layer: Record<string, unknown> = { id: command.layer.id, sourceId: command.layer.sourceId };
      if (command.layer.title !== undefined) layer.title = command.layer.title;
      if (command.layer.visible !== undefined) layer.visible = command.layer.visible;
      if (command.layer.styleRef !== undefined) layer.styleRef = command.layer.styleRef.styleId;
      if (command.layer.metadata !== undefined) layer.metadata = command.layer.metadata;
      return {
        name: "honua_studio_add_layer",
        arguments: { ...base, layer, ...(command.beforeId !== undefined ? { beforeId: command.beforeId } : {}) },
      };
    }
    case "removeLayer":
      return { name: "honua_studio_remove_layer", arguments: { ...base, layerId: targetId(command.target) } };
    case "setLayerStyleRef":
      return {
        name: "honua_studio_set_layer_style",
        arguments: { ...base, layerId: targetId(command.target), styleRef: command.styleRef?.styleId ?? null },
      };
    case "setVisibility":
      return {
        name: "honua_studio_set_layer_visibility",
        arguments: { ...base, layerId: targetId(command.target), visible: command.visible },
      };
    case "setView":
      return { name: "honua_studio_set_view", arguments: { ...base, view: { ...command.view } } };
    case "addWidget":
      return { name: "honua_studio_add_widget", arguments: { ...base, widget: { ...command.widget } } };
    case "removeWidget":
      return { name: "honua_studio_remove_widget", arguments: { ...base, widgetId: targetId(command.target) } };
    case "addControl":
      return { name: "honua_studio_add_control", arguments: { ...base, control: { ...command.control } } };
    case "removeControl":
      return {
        name: "honua_studio_remove_control",
        arguments: {
          ...base,
          controlId: targetId(command.target),
          ...(command.cascadeInteractions !== undefined ? { cascadeInteractions: command.cascadeInteractions } : {}),
        },
      };
    case "bindInteraction":
      return { name: "honua_studio_bind_interaction", arguments: { ...base, interaction: { ...command.interaction } } };
    case "removeInteraction":
      return {
        name: "honua_studio_remove_interaction",
        arguments: { ...base, interactionId: command.interactionId },
      };
    default:
      return undefined;
  }
}

function targetId(target: CompositionTarget): string {
  if (target.kind === "feature") throw new Error("unreachable: feature target has no scalar id");
  return target.id;
}

// ---------------------------------------------------------------------------
// Server draft body -> local composition state (the "local state refresh
// from the returned draft" half of the orchestration flow)
// ---------------------------------------------------------------------------

/**
 * Projects a `StudioCompositionBody` (the server's wire shape for a
 * map/app-family draft's composed layers/view/widgets — honua-server#3002)
 * onto this app's {@link CompositionState}. `pins` and `annotations` are NOT
 * part of the server's wire schema (`StudioCompositionBodyEditor` in
 * honua-server only models `layers`/`view`/`widgets`) — carried over
 * unchanged from `previous`, never cleared by a server sync.
 */
export function applyStudioDraftBody(
  body: StudioCompositionBodyWire | undefined,
  previous?: CompositionState,
): CompositionState {
  const base = previous ?? createEmptyCompositionState();
  if (!body) return base;
  return {
    ...base,
    layers: (body.layers ?? []).map((layer) => studioLayerToComposition(layer)),
    view: studioViewToComposition(body.view),
    widgets: (body.widgets ?? []).map((widget) => studioWidgetToComposition(widget)),
    // Absent blocks mean "unset", not "empty": the server keeps them null
    // until written, so a draft that predates honua-studio#25 must not clear
    // controls the local session has already composed.
    controls: body.controls ? body.controls.map((control) => studioControlToComposition(control)) : base.controls,
    interactions: body.interactions
      ? body.interactions.map((interaction) => studioInteractionToComposition(interaction))
      : base.interactions,
  };
}

/** Convenience: projects a whole {@link StudioMcpDraft}'s envelope body, same rules as {@link applyStudioDraftBody}. */
export function applyStudioDraft(draft: StudioMcpDraft, previous?: CompositionState): CompositionState {
  const body = draft.envelope.body as StudioCompositionBodyWire | undefined;
  return applyStudioDraftBody(body, previous);
}

function studioLayerToComposition(layer: StudioMcpLayerInput): CompositionState["layers"][number] {
  return {
    id: layer.id,
    sourceId: layer.sourceId ?? layer.id,
    visible: layer.visible ?? true,
    ...(layer.title !== undefined ? { title: layer.title } : {}),
    ...(styleRefFromString(layer.styleRef) ? { styleRef: styleRefFromString(layer.styleRef) } : {}),
    ...(layer.metadata !== undefined ? { metadata: layer.metadata } : {}),
  };
}

function studioViewToComposition(view: StudioMcpViewInput | undefined): CompositionState["view"] {
  if (!view) return {};
  const { bbox, center, zoom, pitch, bearing } = view; // crs intentionally dropped — see the module doc.
  return {
    ...(bbox !== undefined ? { bbox } : {}),
    ...(center !== undefined ? { center } : {}),
    ...(zoom !== undefined ? { zoom } : {}),
    ...(pitch !== undefined ? { pitch } : {}),
    ...(bearing !== undefined ? { bearing } : {}),
  };
}

/**
 * The reverse of {@link applyStudioDraftBody}: projects local
 * {@link CompositionState} onto the server's `StudioCompositionBody` wire
 * shape (`layers`/`view`/`widgets` only — `pins`/`annotations` are dropped,
 * same reason as the reverse direction). Used to seed a freshly-created
 * draft with whatever the local session had already composed (e.g. a live
 * MCP session attached mid-conversation, after fixture/local-only commands
 * already ran) — see `orchestrator.ts`'s `#ensureDraft`.
 */
export function toStudioCompositionBody(state: CompositionState): StudioCompositionBodyWire {
  return {
    layers: state.layers.map((layer) => ({
      id: layer.id,
      sourceId: layer.sourceId,
      ...(layer.title !== undefined ? { title: layer.title } : {}),
      visible: layer.visible,
      ...(layer.styleRef !== undefined ? { styleRef: layer.styleRef.styleId } : {}),
      ...(layer.metadata !== undefined ? { metadata: layer.metadata } : {}),
    })),
    view: { ...state.view },
    widgets: state.widgets.map((widget) => ({
      id: widget.id,
      kind: widget.kind,
      ...(widget.title !== undefined ? { title: widget.title } : {}),
      ...(widget.sourceId !== undefined ? { sourceId: widget.sourceId } : {}),
      ...(widget.config !== undefined ? { config: widget.config } : {}),
    })),
    // Omitted entirely when empty — see `StudioCompositionBodyWire`'s note on
    // why the server keeps these blocks nullable.
    ...(state.controls.length > 0
      ? {
          controls: state.controls.map((control) => ({
            id: control.id,
            kind: control.kind,
            ...(control.title !== undefined ? { title: control.title } : {}),
            ...(control.sourceId !== undefined ? { sourceId: control.sourceId } : {}),
            ...(control.config !== undefined ? { config: control.config as Record<string, unknown> } : {}),
          })),
        }
      : {}),
    ...(state.interactions.length > 0
      ? {
          interactions: state.interactions.map((interaction) => ({
            id: interaction.id,
            on: { ...interaction.on },
            do: {
              ref: interaction.do.ref,
              verb: interaction.do.verb,
              ...(interaction.do.args !== undefined ? { args: interaction.do.args as Record<string, unknown> } : {}),
            },
            ...(interaction.disabled !== undefined ? { disabled: interaction.disabled } : {}),
          })),
        }
      : {}),
  };
}

function studioControlToComposition(control: StudioMcpControlInput): CompositionState["controls"][number] {
  return {
    id: control.id,
    kind: control.kind as CompositionState["controls"][number]["kind"],
    ...(control.title !== undefined ? { title: control.title } : {}),
    ...(control.sourceId !== undefined ? { sourceId: control.sourceId } : {}),
    ...(control.config !== undefined ? { config: control.config } : {}),
  };
}

function studioInteractionToComposition(
  interaction: StudioMcpInteractionInput,
): CompositionState["interactions"][number] {
  return {
    id: interaction.id,
    on: { ref: interaction.on.ref, event: interaction.on.event as never },
    do: {
      ref: interaction.do.ref,
      verb: interaction.do.verb as never,
      ...(interaction.do.args !== undefined ? { args: interaction.do.args } : {}),
    },
    ...(interaction.disabled !== undefined ? { disabled: interaction.disabled } : {}),
  };
}

function studioWidgetToComposition(widget: StudioMcpWidgetInput): CompositionState["widgets"][number] {
  return {
    id: widget.id,
    kind: widget.kind as CompositionState["widgets"][number]["kind"],
    ...(widget.title !== undefined ? { title: widget.title } : {}),
    ...(widget.sourceId !== undefined ? { sourceId: widget.sourceId } : {}),
    ...(widget.config !== undefined ? { config: widget.config } : {}),
  };
}
