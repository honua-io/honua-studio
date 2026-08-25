import type { HonuaAgentToolDefinitionLike } from "@honua/sdk-js/agent-tools";

const id = { type: "string", minLength: 1 } as const;
function action(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: readonly string[],
): HonuaAgentToolDefinitionLike {
  return {
    name,
    description,
    mode: "action",
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    } as HonuaAgentToolDefinitionLike["inputSchema"],
  };
}

/**
 * Published-server composition schemas used until sdk-js#1397 supplies the
 * same list through SDK discovery. Draft identity/generation are deliberately
 * omitted from model-visible schemas: StudioAgentSession injects the
 * authoritative binding, so the model can never select another draft.
 */
export const STATIC_STUDIO_AGENT_TOOLS: ReadonlyArray<HonuaAgentToolDefinitionLike> = [
  action(
    "honua_studio_add_layer",
    "Add a catalog-backed layer to the authoritative Studio draft.",
    {
      layer: {
        type: "object",
        properties: {
          id,
          sourceId: id,
          type: { type: "string" },
          title: { type: "string" },
          visible: { type: "boolean" },
          styleRef: { type: "string" },
          metadata: { type: "object" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      beforeId: id,
    },
    ["layer"],
  ),
  action("honua_studio_remove_layer", "Remove a layer from the authoritative Studio draft.", { layerId: id }, [
    "layerId",
  ]),
  action(
    "honua_studio_set_layer_style",
    "Set a layer's governed style reference.",
    { layerId: id, styleRef: { type: "string" } },
    ["layerId"],
  ),
  action(
    "honua_studio_set_layer_visibility",
    "Set a layer's visibility on the authoritative Studio draft.",
    { layerId: id, visible: { type: "boolean" } },
    ["layerId", "visible"],
  ),
  action(
    "honua_studio_set_view",
    "Set the authoritative Studio draft's map view.",
    {
      view: {
        type: "object",
        properties: {
          bbox: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
          center: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 },
          zoom: { type: "number" },
          pitch: { type: "number" },
          bearing: { type: "number" },
          crs: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    ["view"],
  ),
  action(
    "honua_studio_add_widget",
    "Add a chart, table, or other widget to the authoritative Studio draft.",
    {
      widget: {
        type: "object",
        properties: { id, kind: id, title: { type: "string" }, sourceId: id, config: { type: "object" } },
        required: ["id", "kind"],
        additionalProperties: false,
      },
    },
    ["widget"],
  ),
  action("honua_studio_remove_widget", "Remove a widget from the authoritative Studio draft.", { widgetId: id }, [
    "widgetId",
  ]),
  action(
    "honua_studio_bind_interaction",
    "Bind a declarative interaction in the authoritative Studio draft.",
    {
      interaction: {
        type: "object",
        properties: {
          id,
          on: {
            type: "object",
            properties: { ref: id, event: id },
            required: ["ref", "event"],
            additionalProperties: false,
          },
          do: {
            type: "object",
            properties: { ref: id, verb: id, args: { type: "object" } },
            required: ["ref", "verb"],
            additionalProperties: false,
          },
          disabled: { type: "boolean" },
        },
        required: ["id", "on", "do"],
        additionalProperties: false,
      },
    },
    ["interaction"],
  ),
  action(
    "honua_studio_remove_interaction",
    "Remove a declarative interaction from the authoritative Studio draft.",
    { interactionId: id },
    ["interactionId"],
  ),
];
