/**
 * Browser-agent allow-list. Tools must be advertised by the connected server
 * and match one of these families; a name match alone never invents a tool.
 *
 * Esri GPServer tasks intentionally share the GP lane with OGC Processes.
 * Studio forwards the advertised schema/result and does not own a second Esri
 * translator. The three exact Esri tool names below are the server contract;
 * each task schema (for example Buffer) remains server-advertised.
 */
const STUDIO_MUTATION_TOOLS = new Set([
  "honua_studio_add_layer",
  "honua_studio_remove_layer",
  "honua_studio_set_layer_style",
  "honua_studio_set_layer_visibility",
  "honua_studio_set_view",
  "honua_studio_add_widget",
  "honua_studio_remove_widget",
  "honua_studio_add_control",
  "honua_studio_remove_control",
  "honua_studio_bind_interaction",
  "honua_studio_remove_interaction",
  "honua_studio_validate_draft",
  "honua_studio_preview_draft",
  "honua_studio_propose_publication",
]);

const ESRI_GP_TOOL_NAMES = new Set([
  "honua_esri_gp_list_tasks",
  "honua_esri_gp_describe_task",
  "honua_esri_gp_execute_task",
]);

const GP_TOOL_PREFIXES = ["honua_gp_", "honua_geoprocessing_", "honua_esri_gpserver_", "esri_gpserver_"] as const;

export function isGovernedStudioAgentTool(name: string): boolean {
  return STUDIO_MUTATION_TOOLS.has(name) || isGpAgentTool(name);
}

export function isGpAgentTool(name: string): boolean {
  return ESRI_GP_TOOL_NAMES.has(name) || GP_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}
