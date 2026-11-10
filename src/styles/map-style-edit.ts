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
