import type { HonuaStyleRefLayerOverride } from "@honua/sdk-js/runtime";
import { validateHonuaStyle } from "@honua/sdk-js/style";
import { canonicalCompositionJson } from "../composition/model.js";

/** Composition owners captured by a map-local snapshot; later additions remain dynamic. */
export const COMPOSITION_STYLE_LAYER_IDS = "honua:compositionLayerIds";

export type MapStyleDocument = Readonly<Record<string, unknown>>;
export type InlineStyleBody = Readonly<Record<string, Readonly<Record<string, unknown>>>>;
/** Structural projection of the SDK-owned optional portable binding wire contract. */
export interface CompositionStyleLayerBinding {
  readonly styleLayerId: string;
  readonly targetLayerId: string;
  readonly layerType: string;
  readonly properties?: readonly (keyof HonuaStyleRefLayerOverride | "visibility")[];
}
export interface CompositionStyleDefinition {
  readonly styleId: string;
  readonly body?: InlineStyleBody;
  readonly layerBindings?: readonly CompositionStyleLayerBinding[];
  readonly [key: string]: unknown;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Inline overrides never alter renderer identity or source authority. */
export function validateInlineStyleBody(layerId: string, value: unknown): string[] {
  if (!object(value)) return ["Style overrides must be an object."];
  const permitted = new Set(["paint", "layout", "filter", "minzoom", "maxzoom", "metadata"]);
  for (const [id, override] of Object.entries(value)) {
    if (id !== layerId && id !== `${layerId}__outline`) return ["Style overrides must target the selected layer only."];
    if (!object(override) || Object.keys(override).some((key) => !permitted.has(key)))
      return ["Style overrides cannot change layer identity or sources."];
  }
  return JSON.stringify(value).length <= 262144 ? [] : ["Style overrides exceed the 256 KiB limit."];
}

/** A visual editor may change appearance, never expand its source/resource authority. */
export function validateMapStyleEdit(anchor: MapStyleDocument, candidate: unknown): string[] {
  try {
    return validateMapStyleDocument(anchor, candidate);
  } catch {
    return ["Expected bounded JSON style data."];
  }
}
function validateMapStyleDocument(anchor: MapStyleDocument, candidate: unknown): string[] {
  if (!object(candidate) || candidate.version !== 8 || !object(candidate.sources) || !Array.isArray(candidate.layers))
    return ["Expected a MapLibre v8 style document."];
  if (new TextEncoder().encode(JSON.stringify(candidate)).length > 1048576)
    return ["Map style exceeds the 1 MiB limit."];
  const mutable = new Set(["layers", "name", "metadata", "transition", "light", "lights", "fog"]);
  for (const key of new Set([...Object.keys(anchor), ...Object.keys(candidate)])) {
    if (
      !mutable.has(key) &&
      canonicalCompositionJson(anchor[key] ?? null) !== canonicalCompositionJson(candidate[key] ?? null)
    )
      return [`The editor cannot change protected style member '${key}'.`];
  }
  const previous = new Map(
    (Array.isArray(anchor.layers) ? anchor.layers : []).filter(object).map((layer) => [layer.id, layer]),
  );
  for (const layer of candidate.layers) {
    if (!object(layer) || typeof layer.id !== "string") return ["Every render layer needs an identity."];
    const existing = previous.get(layer.id);
    if (
      existing &&
      (layer.source !== existing.source ||
        layer["source-layer"] !== existing["source-layer"] ||
        (existing.metadata as Record<string, unknown> | undefined)?.["honua:compositionLayerId"] !==
          (layer.metadata as Record<string, unknown> | undefined)?.["honua:compositionLayerId"])
    )
      return ["Existing render-layer source bindings cannot change."];
    if (
      layer.source !== undefined &&
      (typeof layer.source !== "string" || !Object.hasOwn(candidate.sources, layer.source))
    )
      return ["Render layers must use an existing authorized source."];
  }
  const errors = validateHonuaStyle(candidate);
  return errors.map((error) => error.message);
}

export interface MapStyleLayerOwner {
  readonly id: string;
  readonly sourceId: string;
  readonly title?: string;
}
export interface MapStyleField {
  readonly name: string;
  readonly type: string;
}

/** Numeric source types used by both thematic entry and expression validation. */
export function isNumericMapStyleField(field: MapStyleField): boolean {
  return (
    /int|number|decimal|double|float|numeric|single/i.test(field.type) || /^(?:esriFieldType)?OID$/i.test(field.type)
  );
}

/** New render layers require an explicit/unique owner from the actual composition. */
export function bindNewRenderLayerOwners(
  anchor: MapStyleDocument,
  candidate: MapStyleDocument,
  owners: readonly MapStyleLayerOwner[],
  selectedOwner?: string,
): MapStyleDocument {
  const result = structuredClone(candidate) as Record<string, unknown>;
  if (!Array.isArray(result.layers)) throw new Error("The style has no render-layer array.");
  const existing = new Set((Array.isArray(anchor.layers) ? anchor.layers : []).filter(object).map((layer) => layer.id));
  result.layers = result.layers.map((value) => {
    if (!object(value) || existing.has(value.id) || typeof value.source !== "string") return value;
    const metadata = object(value.metadata) ? value.metadata : {};
    if (metadata["honua:compositionLayerId"] !== undefined) return value;
    const matches = owners.filter((owner) => owner.sourceId === value.source);
    const owner =
      matches.find((owner) => owner.id === selectedOwner) ?? (matches.length === 1 ? matches[0] : undefined);
    if (!owner) throw new Error("Select the composed owner for the new render layer.");
    return { ...value, metadata: { ...metadata, "honua:compositionLayerId": owner.id } };
  });
  return result;
}

/** Manual thematic classes over an actual described field; no inferred values or code. */
export function thematicMapStyle(
  style: MapStyleDocument,
  owner: MapStyleLayerOwner,
  field: MapStyleField,
  mode: "categories" | "breaks",
  values: unknown,
  palette: readonly string[],
): MapStyleDocument {
  if (!Array.isArray(values) || values.length === 0 || values.length > 5 || palette.length < values.length + 1)
    throw new Error("Provide one to five explicit categories or numeric breaks.");
  if (palette.some((color) => !/^#[a-fA-F0-9]{6}$/.test(color))) throw new Error("Choose a valid thematic palette.");
  let expression: unknown[];
  if (mode === "breaks") {
    if (
      !isNumericMapStyleField(field) ||
      values.some(
        (value, index) =>
          typeof value !== "number" || !Number.isFinite(value) || (index > 0 && values[index - 1] >= value),
      )
    )
      throw new Error("Graduated styling requires an actual numeric field and increasing numeric breaks.");
    expression = [
      "step",
      ["to-number", ["get", field.name]],
      palette[0],
      ...values.flatMap((value, index) => [value, palette[index + 1]]),
    ];
  } else {
    if (
      values.some((value) => !(typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))) ||
      new Set(values.map((value) => JSON.stringify(value))).size !== values.length
    )
      throw new Error("Categories must be distinct explicit strings or numbers.");
    expression = [
      "match",
      ["get", field.name],
      ...values.flatMap((value, index) => [value, palette[index]]),
      palette[values.length],
    ];
  }
  const result = structuredClone(style) as Record<string, unknown>;
  if (!Array.isArray(result.layers)) throw new Error("The style has no render-layer array.");
  let changed = false;
  result.layers = result.layers.map((value) => {
    if (!object(value) || value.id !== owner.id || value.source !== owner.sourceId) return value;
    const key =
      value.type === "symbol"
        ? "text-color"
        : ["fill", "line", "circle"].includes(String(value.type))
          ? `${value.type}-color`
          : undefined;
    if (!key) throw new Error("This render layer does not support thematic color controls.");
    changed = true;
    return { ...value, paint: { ...(object(value.paint) ? value.paint : {}), [key]: expression } };
  });
  if (!changed) throw new Error("The selected composed layer has no primary render layer. Add one in Maputnik first.");
  return result;
}

/** Ramp for one-to-five thematic classes plus the fallback class. */
export const THEMATIC_PALETTE = ["#eff3ff", "#c6dbef", "#9ecae1", "#6baed6", "#3182bd", "#08519c"] as const;

export interface MapStyleLegendEntry {
  readonly label: string;
  readonly color: string;
}

/** Legend rows for exactly the classes `thematicMapStyle` paints with {@link THEMATIC_PALETTE}. */
export function thematicLegend(
  mode: "categories" | "breaks",
  values: readonly (string | number)[],
): readonly MapStyleLegendEntry[] {
  if (mode === "categories")
    return [
      ...values.map((value, index) => ({ label: String(value), color: THEMATIC_PALETTE[index] })),
      { label: "Other", color: THEMATIC_PALETTE[values.length] },
    ];
  const entries: MapStyleLegendEntry[] = [{ label: `Below ${values[0]}`, color: THEMATIC_PALETTE[0] }];
  for (let index = 0; index < values.length - 1; index += 1)
    entries.push({ label: `${values[index]} to below ${values[index + 1]}`, color: THEMATIC_PALETTE[index + 1] });
  entries.push({ label: `${values[values.length - 1]} or more`, color: THEMATIC_PALETTE[values.length] });
  return entries;
}

export type MapStyleGeometry = "circle" | "line" | "fill";

/** One directly editable paint property, or the reason it needs the advanced editor. */
export interface MapStyleAppearanceProperty {
  readonly layerId: string;
  readonly key: string;
  readonly value: unknown;
  readonly refusal?: string;
}

export interface MapStyleAppearance {
  readonly geometry: MapStyleGeometry;
  readonly color: MapStyleAppearanceProperty;
  readonly opacity: MapStyleAppearanceProperty;
  /** Circle radius, line width, or a polygon's outline width; absent for a polygon without an outline layer. */
  readonly strokeOrSize?: MapStyleAppearanceProperty & { readonly kind: "size" | "stroke" };
}

export interface MapStyleAppearancePatch {
  readonly color?: string;
  readonly opacity?: number;
  readonly strokeOrSize?: number;
}

function ownerRenderLayer(style: MapStyleDocument, owner: MapStyleLayerOwner, id = owner.id) {
  const layers = Array.isArray(style.layers) ? style.layers : [];
  return layers.find((value) => object(value) && value.id === id && value.source === owner.sourceId) as
    | Record<string, unknown>
    | undefined;
}

function appearanceProperty(layer: Record<string, unknown>, key: string): MapStyleAppearanceProperty {
  const value = object(layer.paint) ? layer.paint[key] : undefined;
  return {
    layerId: String(layer.id),
    key,
    value,
    ...(Array.isArray(value)
      ? {
          refusal:
            value[0] === "match" || value[0] === "step"
              ? "Uses field-based classes. Change them under Color by field or in the advanced editor."
              : "Uses an advanced expression. Edit it in the advanced editor.",
        }
      : {}),
  };
}

/** The selected layer's common paint, read from its primary render layer; undefined when it has none. */
export function layerAppearance(style: MapStyleDocument, owner: MapStyleLayerOwner): MapStyleAppearance | undefined {
  const layer = ownerRenderLayer(style, owner);
  const geometry = layer?.type;
  if (!layer || (geometry !== "circle" && geometry !== "line" && geometry !== "fill")) return undefined;
  const outline = geometry === "fill" ? ownerRenderLayer(style, owner, `${owner.id}__outline`) : undefined;
  const strokeLayer = geometry === "fill" ? outline : layer;
  const strokeOrSize = strokeLayer
    ? {
        kind: geometry === "circle" ? ("size" as const) : ("stroke" as const),
        ...appearanceProperty(strokeLayer, geometry === "circle" ? "circle-radius" : "line-width"),
      }
    : undefined;
  return {
    geometry,
    color: appearanceProperty(layer, `${geometry}-color`),
    opacity: appearanceProperty(layer, `${geometry}-opacity`),
    ...(strokeOrSize ? { strokeOrSize } : {}),
  };
}

/** Writes literal common paint; refuses to flatten an expression rather than lose it. */
export function withLayerAppearance(
  style: MapStyleDocument,
  owner: MapStyleLayerOwner,
  patch: MapStyleAppearancePatch,
): MapStyleDocument {
  const appearance = layerAppearance(style, owner);
  if (!appearance) throw new Error("The selected layer has no point, line or polygon render layer.");
  const writes: [MapStyleAppearanceProperty | undefined, unknown][] = [];
  if (patch.color !== undefined) {
    if (!/^#[a-fA-F0-9]{6}$/.test(patch.color)) throw new Error("Choose a valid color.");
    writes.push([appearance.color, patch.color]);
  }
  if (patch.opacity !== undefined) {
    if (!Number.isFinite(patch.opacity) || patch.opacity < 0 || patch.opacity > 1)
      throw new Error("Opacity must be between 0 and 100 percent.");
    writes.push([appearance.opacity, patch.opacity]);
  }
  if (patch.strokeOrSize !== undefined) {
    if (!appearance.strokeOrSize) throw new Error("This polygon has no outline to resize.");
    if (!Number.isFinite(patch.strokeOrSize) || patch.strokeOrSize < 0 || patch.strokeOrSize > 50)
      throw new Error("Size and stroke width must be between 0 and 50 pixels.");
    writes.push([appearance.strokeOrSize, patch.strokeOrSize]);
  }
  const result = structuredClone(style) as Record<string, unknown>;
  for (const [property, value] of writes) {
    if (!property) continue;
    if (property.refusal) throw new Error(property.refusal);
    result.layers = (result.layers as unknown[]).map((layer) =>
      object(layer) && layer.id === property.layerId && layer.source === owner.sourceId
        ? { ...layer, paint: { ...(object(layer.paint) ? layer.paint : {}), [property.key]: value } }
        : layer,
    );
  }
  return result;
}

/** The field the owner's label layer reads, when it is a plain `["get", field]` label. */
export function featureLabelField(style: MapStyleDocument, owner: MapStyleLayerOwner): string | undefined {
  const label = ownerRenderLayer(style, owner, `${owner.id}__labels`);
  const text = object(label?.layout) ? label.layout["text-field"] : undefined;
  return Array.isArray(text) && text[0] === "get" && typeof text[1] === "string" ? text[1] : undefined;
}

/** Removes the owner's label layer; other layers are untouched. */
export function withoutFeatureLabels(style: MapStyleDocument, owner: MapStyleLayerOwner): MapStyleDocument {
  const result = structuredClone(style) as Record<string, unknown>;
  const labelId = `${owner.id}__labels`;
  result.layers = (Array.isArray(result.layers) ? result.layers : []).filter(
    (layer) => !(object(layer) && layer.id === labelId && layer.source === owner.sourceId),
  );
  return result;
}

/** A symbol label on the selected layer's source, using one described field. */
export function featureLabelStyle(
  style: MapStyleDocument,
  owner: MapStyleLayerOwner,
  field: MapStyleField,
): MapStyleDocument {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name)) throw new Error("Choose a described field name for labels.");
  const result = structuredClone(style) as Record<string, unknown>;
  if (!Array.isArray(result.layers)) throw new Error("The style has no render-layer array.");
  const layers = result.layers;
  const primary = layers.find(
    (value): value is Record<string, unknown> =>
      object(value) && value.id === owner.id && value.source === owner.sourceId,
  );
  if (!primary) throw new Error("The selected composed layer has no primary render layer. Add one in Maputnik first.");
  const labelId = `${owner.id}__labels`;
  const textField = ["get", field.name];
  const sourceLayer = primary["source-layer"];
  let found = false;
  const next = layers.map((value) => {
    if (!object(value) || value.id !== labelId) return value;
    found = true;
    if (value.source !== owner.sourceId) throw new Error("The label layer does not use the selected source.");
    const metadata = object(value.metadata) ? value.metadata : {};
    if (metadata["honua:compositionLayerId"] !== undefined && metadata["honua:compositionLayerId"] !== owner.id)
      throw new Error("The label layer belongs to another composed layer.");
    return {
      ...value,
      layout: { ...(object(value.layout) ? value.layout : {}), "text-field": textField },
    };
  });
  if (!found) {
    next.push({
      id: labelId,
      type: "symbol",
      source: owner.sourceId,
      ...(typeof sourceLayer === "string" ? { "source-layer": sourceLayer } : {}),
      ...(primary.filter !== undefined ? { filter: structuredClone(primary.filter) } : {}),
      layout: { "text-field": textField },
      metadata: { "honua:compositionLayerId": owner.id },
    });
  }
  result.layers = next;
  return result;
}
