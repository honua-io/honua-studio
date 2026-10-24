import type { HonuaCompiledInteractions } from "@honua/sdk-js/interactions/declarative";
import type { CompositionState, CompositionTarget } from "../composition/model.js";
import { compositionDataSource } from "../composition/source-reference.js";
import {
  CONTROL_KIND_EMITS_CHANGE,
  controlTargetLayers,
  describeControl,
  readControlConfig,
} from "../controls/control-config.js";
import { resolveVisualLayerOwner } from "../map/visual-layer-owner.js";
import type { MapStyleField } from "../styles/map-style-edit.js";
import {
  readChartConfig,
  readCompareConfig,
  readLegendConfig,
  readTableConfig,
  readTimeConfig,
  readTocConfig,
} from "../widgets/widget-config.js";

export type DesignStatus = "supported" | "unsupported" | "unresolved" | "disabled";
export interface DesignConsumer {
  readonly ref: string;
  readonly title: string;
  readonly target: CompositionTarget;
  readonly sourceReference?: string;
  readonly sourceId?: string;
  readonly fields: readonly string[];
  readonly note?: string;
  readonly constraints: readonly string[];
}
export interface DesignConnection {
  readonly origin: "authored" | "intrinsic";
  readonly id: string;
  readonly authoredInteractionId?: string;
  readonly from: string;
  readonly event: string;
  readonly to: string;
  readonly action: string;
  readonly behavior: "shared exploration" | "one-shot gesture" | "intrinsic";
  readonly status: DesignStatus;
  readonly reason: string;
}
export type SourceDescription =
  | { readonly status: "ready"; readonly fields: readonly MapStyleField[] }
  | { readonly status: "loading" | "unavailable"; readonly reason: string };

/** Read only the expressions the existing MapLibre document actually authors. */
function expressionFields(value: unknown, fields = new Set<string>()): Set<string> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const legacy = value as Record<string, unknown>;
    if (typeof legacy.property === "string" && Array.isArray(legacy.stops)) fields.add(legacy.property);
  }
  if (!Array.isArray(value)) return fields;
  if (value[0] === "literal") return fields;
  if ((value[0] === "get" || value[0] === "has") && value.length === 2 && typeof value[1] === "string")
    fields.add(value[1]);
  for (const child of value) expressionFields(child, fields);
  return fields;
}

function filterFields(value: unknown, fields: Set<string>): void {
  expressionFields(value, fields);
  if (!Array.isArray(value)) return;
  if (["all", "any", "none"].includes(value[0])) {
    for (const child of value.slice(1)) filterFields(child, fields);
  } else if (
    ["==", "!=", ">", ">=", "<", "<=", "in", "!in", "has", "!has"].includes(value[0]) &&
    typeof value[1] === "string" &&
    !["$id", "$type"].includes(value[1])
  )
    fields.add(value[1]);
}

function hasDynamicField(value: unknown): boolean {
  if (!Array.isArray(value) || value[0] === "literal") return false;
  if ((value[0] === "get" || value[0] === "has") && value.length === 2 && typeof value[1] !== "string") return true;
  return value.some(hasDynamicField);
}

export function designConsumers(
  state: CompositionState,
  inferredTableFields: Readonly<Record<string, readonly string[]>> = {},
): readonly DesignConsumer[] {
  const consumers: DesignConsumer[] = [];
  const owners = new Set(state.layers.map((layer) => layer.id));
  for (const layer of state.layers) {
    const fields = new Set<string>();
    const constraints: string[] = [];
    let dynamicFields = false;
    const styleLayers = [
      ...(Array.isArray(state.mapSpec?.layers) ? state.mapSpec.layers : []),
      ...Object.entries(state.styleRefs?.find((ref) => ref.styleId === layer.styleRef?.styleId)?.body ?? {}).map(
        ([id, properties]) => ({ id, ...properties }),
      ),
    ];
    for (const value of styleLayers) {
      if (!value || typeof value !== "object") continue;
      const style = value as Record<string, unknown>;
      if (
        typeof style.id !== "string" ||
        resolveVisualLayerOwner({ id: style.id, metadata: style.metadata }, owners) !== layer.id
      )
        continue;
      for (const property of [style.paint, style.layout]) {
        if (property && typeof property === "object" && !Array.isArray(property)) {
          for (const expression of Object.values(property)) {
            expressionFields(expression, fields);
            dynamicFields ||= hasDynamicField(expression);
          }
        }
      }
      if (style.filter !== undefined) {
        constraints.push(JSON.stringify(style.filter));
        filterFields(style.filter, fields);
        dynamicFields ||= hasDynamicField(style.filter);
      }
    }
    const notes = [
      ...(dynamicFields
        ? ["Dynamic field references are unresolved; the inventory lists only statically named fields."]
        : []),
      ...(layer.styleRef && !state.styleRefs?.find((ref) => ref.styleId === layer.styleRef?.styleId)?.body
        ? ["Shared style fields are unavailable until its canonical definition is described."]
        : []),
    ];
    consumers.push({
      ref: `layer:${layer.id}`,
      title: layer.title ?? layer.id,
      target: { kind: "layer", id: layer.id },
      sourceReference: layer.sourceId,
      sourceId: compositionDataSource(state, layer.sourceId),
      fields: [...fields],
      constraints,
      ...(notes.length ? { note: notes.join(" ") } : {}),
    });
  }
  for (const widget of state.widgets) {
    const fields: string[] = [];
    let note: string | undefined;
    if (widget.kind === "table") {
      const config = readTableConfig(widget);
      if (config.ok) {
        fields.push(...(config.config.fields.length ? config.config.fields : (inferredTableFields[widget.id] ?? [])));
        if (config.config.primaryKey) fields.push(config.config.primaryKey);
        if (!config.config.fields.length)
          note = "Columns inferred from loaded rows (at most 8); no authored field list.";
      } else note = config.reason;
    }
    if (widget.kind === "chart") {
      const config = readChartConfig(widget);
      if (config.ok) {
        for (const field of [config.config.groupBy, config.config.field, config.config.measure.field])
          if (field && field !== "*") fields.push(field);
      } else note = config.reason;
    }
    if (widget.kind === "time" && widget.config?.field)
      note = "Field-based time filtering is not implemented by this widget.";
    consumers.push({
      ref: `widget:${widget.id}`,
      title: widget.title ?? widget.id,
      target: { kind: "component", id: widget.id },
      ...(widget.sourceId
        ? { sourceReference: widget.sourceId, sourceId: compositionDataSource(state, widget.sourceId) }
        : {}),
      fields: [...new Set(fields)],
      constraints: [],
      ...(note ? { note } : {}),
    });
  }
  for (const control of state.controls) {
    const config = readControlConfig(control);
    const field = config.ok && "field" in config.config.config ? config.config.config.field : undefined;
    const status = describeControl(state, control);
    consumers.push({
      ref: `control:${control.id}`,
      title: control.title ?? control.id,
      target: { kind: "control", id: control.id },
      ...(control.sourceId
        ? { sourceReference: control.sourceId, sourceId: compositionDataSource(state, control.sourceId) }
        : {}),
      fields: typeof field === "string" ? [field] : [],
      constraints: [],
      ...(status.state === "unsupported" ? { note: status.reason } : {}),
    });
  }
  return consumers.map((consumer) => {
    const fields = new Set(consumer.fields);
    // Intrinsic source filters also consume their field on every matching map/table/chart.
    for (const control of state.controls) {
      const config = readControlConfig(control);
      if (
        !control.sourceId ||
        !config.ok ||
        !["filterSelect", "filterSlider", "filterDateRange", "timeSlider"].includes(control.kind)
      )
        continue;
      if (
        consumer.sourceId &&
        compositionDataSource(state, control.sourceId) === consumer.sourceId &&
        "field" in config.config.config &&
        typeof config.config.config.field === "string"
      )
        fields.add(config.config.config.field);
    }
    for (const interaction of state.interactions) {
      if (interaction.do.ref !== consumer.ref || interaction.do.verb !== "setFilter") continue;
      const args = interaction.do.args;
      const clause =
        args?.clause && typeof args.clause === "object" ? (args.clause as Record<string, unknown>) : undefined;
      const field = clause?.field ?? args?.field;
      if (typeof field === "string" && !field.startsWith("$event")) fields.add(field);
      if (field === "$event.field" || args?.clause === "$event.clause") {
        const producer = consumers.find((entry) => entry.ref === interaction.on.ref);
        if (producer?.target.kind === "control") for (const field of producer.fields) fields.add(field);
      }
    }
    return { ...consumer, fields: [...fields] };
  });
}

/** A compiled binding alone does not prove that its event producer or target consumer exists. */
export function designConnections(
  state: CompositionState,
  compiled?: HonuaCompiledInteractions,
  mapAvailable = false,
): readonly DesignConnection[] {
  const result: DesignConnection[] = state.interactions.map((interaction): DesignConnection => {
    let status: DesignStatus = "unresolved";
    let reason = "The interaction runtime has not compiled this document.";
    if (compiled?.issues.length)
      reason = `No bindings installed: ${compiled.issues.map((issue) => issue.message).join("; ")}`;
    else if (interaction.disabled) {
      status = "disabled";
      reason = "Disabled in the authored document.";
    } else {
      const unsupported = compiled?.unsupported.find((entry) => entry.interactionId === interaction.id);
      if (unsupported) {
        status = "unsupported";
        reason = unsupported.reason;
      } else if (compiled?.bindings.some((entry) => entry.interactionId === interaction.id)) {
        status = "supported";
        reason = "Installed by the current interaction runtime.";
        const producer = state.controls.find((control) => interaction.on.ref === `control:${control.id}`);
        if (interaction.on.event === "change" && (!producer || !CONTROL_KIND_EMITS_CHANGE[producer.kind])) {
          status = "unsupported";
          reason = "This component does not publish control change events.";
        } else if (producer && describeControl(state, producer).state === "unsupported") {
          status = "unresolved";
          reason = "The source control is unavailable; inspect its data binding.";
        } else if (interaction.on.event === "selection" || interaction.on.event === "viewportChange") {
          status = "unsupported";
          reason = "The canvas does not publish this gesture into the compiled exploration view.";
        } else if (interaction.do.verb === "setFilter" && !interaction.do.ref.startsWith("layer:")) {
          status = "unsupported";
          reason = "The compiler writes a shared clause, but this target has no filter consumer in Studio.";
        }
        if (producer && state.pins.some((pin) => pin.kind === "control" && pin.id === producer.id)) {
          status = "disabled";
          reason = "The source control is pinned; its gesture is disabled.";
        } else if (
          interaction.do.verb === "setVisibility" &&
          state.pins.some((pin) => pin.kind === "layer" && interaction.do.ref === `layer:${pin.id}`)
        ) {
          status = "disabled";
          reason = "The target layer is pinned; the existing reducer refuses this visibility command.";
        }
      }
    }
    return {
      origin: "authored",
      id: interaction.id,
      authoredInteractionId: interaction.id,
      from: interaction.on.ref,
      event: interaction.on.event,
      to: interaction.do.ref,
      action: interaction.do.verb,
      behavior: interaction.do.verb === "setFilter" ? "shared exploration" : "one-shot gesture",
      status,
      reason,
    };
  });
  for (const control of state.controls) {
    const described = describeControl(state, control);
    const pinned = state.pins.some((pin) => pin.kind === "control" && pin.id === control.id);
    if (!CONTROL_KIND_EMITS_CHANGE[control.kind]) {
      result.push({
        origin: "intrinsic",
        id: `intrinsic:${control.id}:map`,
        from: `control:${control.id}`,
        event: "gesture",
        to: "map",
        action: control.kind,
        behavior: "intrinsic",
        status: described.state === "unsupported" ? "unsupported" : pinned || !mapAvailable ? "disabled" : "supported",
        reason:
          described.state === "unsupported"
            ? described.reason
            : pinned
              ? "The control is pinned."
              : mapAvailable
                ? "Intrinsic map affordance; no authored interaction required."
                : "The map bridge is currently unavailable.",
      });
    }
    const config = readControlConfig(control);
    if (config.ok && config.config.kind === "opacity") {
      for (const id of config.config.config.layerIds)
        result.push({
          origin: "intrinsic",
          id: `intrinsic:${control.id}:layer:${id}`,
          from: `control:${control.id}`,
          event: "change",
          to: `layer:${id}`,
          action: "opacity",
          behavior: "intrinsic",
          status:
            !state.layers.some((layer) => layer.id === id) || !compiled
              ? "unresolved"
              : pinned
                ? "disabled"
                : "supported",
          reason: "Temporary layer appearance through the existing exploration channel.",
        });
    }
    if (!["filterSelect", "filterSlider", "filterDateRange", "timeSlider"].includes(control.kind)) continue;
    const source = control.sourceId ? compositionDataSource(state, control.sourceId) : undefined;
    const refs = [
      ...controlTargetLayers(state, control.sourceId).map((id) => `layer:${id}`),
      ...state.widgets
        .filter(
          (widget) =>
            (widget.kind === "table" || widget.kind === "chart") &&
            widget.sourceId &&
            compositionDataSource(state, widget.sourceId) === source &&
            source !== undefined,
        )
        .map((widget) => `widget:${widget.id}`),
    ];
    for (const ref of refs)
      result.push({
        origin: "intrinsic",
        id: `intrinsic:${control.id}:${ref}`,
        from: `control:${control.id}`,
        event: "change",
        to: ref,
        action: "source filter",
        behavior: "intrinsic",
        status: !compiled
          ? "unresolved"
          : described.state === "unsupported"
            ? "unresolved"
            : pinned
              ? "disabled"
              : "supported",
        reason:
          described.state === "unsupported"
            ? described.reason
            : pinned
              ? "The source control is pinned."
              : "Temporary source filter shared by the map and bounded table/chart rows; no authored binding required.",
      });
  }
  for (const widget of state.widgets) {
    let ids: readonly string[] = [];
    if (widget.kind === "toc") {
      const config = readTocConfig(widget);
      if (config.ok)
        ids = config.config.layerIds.length ? config.config.layerIds : state.layers.map((layer) => layer.id);
    }
    if (widget.kind === "compare") {
      const config = readCompareConfig(widget);
      if (config.ok) ids = [config.config.left, config.config.right];
    }
    if (widget.kind === "time") {
      const config = readTimeConfig(widget);
      if (config.ok) ids = config.config.steps.map((step) => step.layerId);
    }
    for (const id of ids) {
      const exists = state.layers.some((layer) => layer.id === id);
      const pinned = state.pins.some((pin) => pin.kind === "layer" && pin.id === id);
      result.push({
        origin: "intrinsic",
        id: `intrinsic:widget:${widget.id}:layer:${id}`,
        from: `widget:${widget.id}`,
        event: "gesture",
        to: `layer:${id}`,
        action: "setVisibility",
        behavior: "intrinsic",
        status: !exists ? "unresolved" : pinned ? "disabled" : "supported",
        reason: !exists
          ? "The referenced layer is absent."
          : pinned
            ? "Pinned layer; visibility changes are refused."
            : "Intrinsic widget action through existing typed visibility commands.",
      });
    }
  }
  return result;
}

export function designRemovalImpact(state: CompositionState, ref: string): readonly string[] {
  const affected = new Set(
    state.interactions
      .filter((entry) => entry.on.ref === ref || entry.do.ref === ref)
      .map((entry) => `interaction:${entry.id}`),
  );
  const layer = state.layers.find((entry) => ref === `layer:${entry.id}`);
  if (layer) {
    const after = { ...state, layers: state.layers.filter((entry) => entry.id !== layer.id) };
    const afterConsumers = designConsumers(after);
    const affectedFilterSources = new Set<string>();
    for (const control of state.controls) {
      if (
        !controlTargetLayers(state, control.sourceId).includes(layer.id) ||
        controlTargetLayers(after, control.sourceId).length > 0
      )
        continue;
      affected.add(`control:${control.id}`);
      const source = control.sourceId ? compositionDataSource(state, control.sourceId) : undefined;
      if (source && ["filterSelect", "filterSlider", "filterDateRange", "timeSlider"].includes(control.kind))
        affectedFilterSources.add(source);
    }
    for (const consumer of designConsumers(state)) {
      if (consumer.ref === ref) continue;
      const next = afterConsumers.find((entry) => entry.ref === consumer.ref);
      const losesFilter =
        consumer.target.kind === "component" && consumer.sourceId && affectedFilterSources.has(consumer.sourceId);
      if (consumer.sourceId !== next?.sourceId || losesFilter) affected.add(consumer.ref);
    }
  }
  for (const widget of state.widgets) {
    if (!layer) continue;
    let ids: readonly string[] = [];
    if (widget.kind === "toc" || widget.kind === "legend") {
      const config = widget.kind === "toc" ? readTocConfig(widget) : readLegendConfig(widget);
      if (config.ok)
        ids = config.config.layerIds.length ? config.config.layerIds : state.layers.map((entry) => entry.id);
    } else if (widget.kind === "compare") {
      const config = readCompareConfig(widget);
      if (config.ok) ids = [config.config.left, config.config.right];
    } else if (widget.kind === "time") {
      const config = readTimeConfig(widget);
      if (config.ok) ids = config.config.steps.map((step) => step.layerId);
    }
    if (ids.includes(layer.id)) affected.add(`widget:${widget.id}`);
  }
  for (const control of state.controls) {
    const config = readControlConfig(control);
    if (layer && config.ok && config.config.kind === "opacity" && config.config.config.layerIds.includes(layer.id))
      affected.add(`control:${control.id}`);
  }
  affected.delete(ref);
  return [...affected];
}
