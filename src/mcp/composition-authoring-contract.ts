import { McpClient, type McpToolsCallResult } from "@honua/sdk-js/studio-agent";
import { validateCompositionCommand } from "../composition/commands.js";
import { COMPOSITION_CONTROL_KINDS, COMPOSITION_WIDGET_KINDS } from "../composition/model.js";
import { readControlConfig } from "../controls/control-config.js";
import { readChartConfig } from "../widgets/widget-config.js";

/** Host rendering guidance supplements real discovery; it never supplies tool definitions or source identifiers. */
export function compositionAuthoringGuidance(): string {
  return [
    "Studio host composition contracts (use only tools actually discovered):",
    `Widget kinds: ${COMPOSITION_WIDGET_KINDS.join(", ")}. The layer list is kind toc; layerList and filter are not widget kinds.`,
    'Charts use kind chart, sourceId from the trusted catalog, and config {groupBy: "<actual field>", chartType: "bar"}. Use the requested chart type and actual field; groupBy is the canonical category axis. Existing categoryField and other documented renderer aliases remain supported. A count needs no measure; other aggregates use measure {fn, field}. Histograms use binField and optional bins.',
    `Control kinds: ${COMPOSITION_CONTROL_KINDS.join(", ")}. Controls are separate from widgets.`,
    'Numeric thresholds, including numeric year fields, use filterSlider with config {field: "<actual field>", min: <known numeric domain>, max: <known numeric domain>, step: <positive step>, operator: ">="}. max must exceed min. Never invent a field or domain; inspect source metadata or ask when unavailable.',
    "timeSlider is temporal and needs config.field plus config.from and config.to as actual dates, with optional stepDays. It is not a numeric year threshold slider.",
    'Data controls emit change. For an explicit declarative filter binding, add the control first, then bind on {ref: "control:<actual control id>", event: "change"} to do {ref: "layer:<actual layer id>", verb: "setFilter", args: {field: "<actual field>", operator: ">=", value: "$event.value"}}. Choose the requested operator and matching control config. References use existing component IDs, not source IDs.',
    "Set a trusted sourceId for intrinsic own-source filtering. Studio intrinsically applies a valid control clause to its own source layers. A control without sourceId needs a fully declared domain and an explicit target binding. Explicit interactions declare the target and are required for cross-layer behavior. Do not claim an explicit binding exists until its tool succeeds. Map navigation and toc visibility toggles are intrinsic.",
  ].join("\n");
}

/** Validate model-authored additions before a durable call, without rewriting signed argument bytes or imported drafts. */
export function compositionAuthoringError(name: string, args: Record<string, unknown>): McpToolsCallResult | undefined {
  const commandName =
    name === "honua_studio_add_widget" ? "addWidget" : name === "honua_studio_add_control" ? "addControl" : undefined;
  if (!commandName) return undefined;
  const validation = validateCompositionCommand({ ...args, name: commandName });
  let reason: string | undefined;
  if (!validation.ok) reason = validation.errors.join("; ");
  else if (validation.command.name === "addWidget" && validation.command.widget.kind === "chart") {
    const result = readChartConfig(validation.command.widget);
    if (!result.ok) reason = result.reason;
    else if (!validation.command.widget.sourceId?.trim())
      reason = "Chart requires a non-empty sourceId from the trusted catalog.";
  } else if (validation.command.name === "addControl") {
    const result = readControlConfig(validation.command.control);
    if (!result.ok) reason = result.reason;
    else if (
      result.config.kind === "filterSelect" &&
      result.config.config.options.length === 0 &&
      !validation.command.control.sourceId?.trim()
    )
      reason = "Filter select requires sourceId to discover its domain, or explicit config.options.";
  }
  return reason
    ? { isError: true, content: [{ type: "text", text: `Studio cannot render this authored component: ${reason}` }] }
    : undefined;
}

/** The normal SDK discovery/auth transport with host admission only at the verified tool-dispatch boundary. */
export class StudioAuthoringMcpClient extends McpClient {
  public override callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolsCallResult> {
    const error = compositionAuthoringError(name, args);
    return error ? Promise.resolve(error) : super.callTool(name, args);
  }
}
