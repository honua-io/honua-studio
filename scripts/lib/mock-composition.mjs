// The mock server's composition semantics, mirroring the client reducer (src/composition/reducer.ts);
// test/mcp/mock-reducer-parity.test.ts drives both with the same commands.

const INLINE_STYLE_PREFIX = "honua-inline:";
const STYLE_LAYER_OWNERS_KEY = "honua:compositionLayerIds";
const STYLE_LAYER_OWNER_KEY = "honua:compositionLayerId";
const VIEW_BOUNDS = [
  ["zoom", (value) => value >= 0 && value <= 24, "[0, 24]"],
  ["pitch", (value) => value >= 0 && value <= 85, "[0, 85]"],
  ["bearing", (value) => value >= 0 && value < 360, "[0, 360)"],
];

export function viewBoundsViolation(view) {
  for (const [field, isInBounds, bounds] of VIEW_BOUNDS) {
    const value = view[field];
    if (value !== undefined && !isInBounds(value)) return `'view.${field}' ${value} is out of bounds ${bounds}.`;
  }
  return undefined;
}

/** A source stays bound only while a remaining layer still draws from it. */
function isSourceStillUsed(layers, removedLayerId, sourceId) {
  return layers.some((layer) => layer.id !== removedLayerId && layer.sourceId === sourceId);
}

/** Drops the removed layer's own style layers, its outline and its owner entry from the captured map style. */
function mapSpecWithoutLayer(mapSpec, layers, removedLayer) {
  const metadata = mapSpec.metadata;
  const owners = metadata?.[STYLE_LAYER_OWNERS_KEY];
  const sources = mapSpec.sources && typeof mapSpec.sources === "object" ? mapSpec.sources : undefined;
  return {
    ...mapSpec,
    ...(Array.isArray(owners)
      ? { metadata: { ...metadata, [STYLE_LAYER_OWNERS_KEY]: owners.filter((owner) => owner !== removedLayer.id) } }
      : {}),
    ...(sources
      ? {
          sources: Object.fromEntries(
            Object.entries(sources).filter(
              ([sourceId]) =>
                sourceId !== removedLayer.sourceId || isSourceStillUsed(layers, removedLayer.id, sourceId),
            ),
          ),
        }
      : {}),
    layers: mapSpec.layers.filter(
      (styleLayer) =>
        styleLayer.id !== removedLayer.id &&
        styleLayer.id !== `${removedLayer.id}__outline` &&
        styleLayer.metadata?.[STYLE_LAYER_OWNER_KEY] !== removedLayer.id,
    ),
  };
}

/** The control or widget that would be left reading an unbound source, reported as honua-server reports it. */
export function layerRemovalBlocker(body, removedLayer) {
  const remaining = body.layers.filter((layer) => layer.id !== removedLayer.id);
  const orphaned = (sourceId) =>
    sourceId !== undefined &&
    (sourceId === removedLayer.id || sourceId === removedLayer.sourceId) &&
    !remaining.some((layer) => layer.sourceId === sourceId);
  const control = (body.controls ?? []).find((candidate) => orphaned(candidate.sourceId));
  const widget = control ? undefined : (body.widgets ?? []).find((candidate) => orphaned(candidate.sourceId));
  const [role, offender] = control ? ["control", control] : widget ? ["widget", widget] : [];
  if (!offender) return undefined;
  return `Cannot remove layer '${removedLayer.id}' because ${role} '${offender.id}' still uses sourceId '${offender.sourceId}'. Remove or rebind the ${role} first.`;
}

export function compositionWithoutLayer(body, removedLayer) {
  const { layers } = body;
  return {
    ...body,
    layers: layers.filter((layer) => layer.id !== removedLayer.id),
    ...(body.sourceBindings
      ? {
          sourceBindings: body.sourceBindings.filter((binding) =>
            isSourceStillUsed(layers, removedLayer.id, binding.sourceId),
          ),
        }
      : {}),
    ...(body.styleRefs
      ? { styleRefs: body.styleRefs.filter((ref) => ref.styleId !== `${INLINE_STYLE_PREFIX}${removedLayer.id}`) }
      : {}),
    ...(body.mapSpec && Array.isArray(body.mapSpec.layers)
      ? { mapSpec: mapSpecWithoutLayer(body.mapSpec, layers, removedLayer) }
      : {}),
  };
}

/** A style body is stored as the layer's own inline style; otherwise the layer binds (or clears) a shared one. */
export function compositionWithLayerStyle(body, index, { styleRef, styleBody }) {
  const layers = [...body.layers];
  const { styleRef: _previous, ...layer } = layers[index];
  if (styleBody === undefined) {
    layers[index] = styleRef ? { ...layer, styleRef } : layer;
    return { ...body, layers };
  }
  const inlineId = `${INLINE_STYLE_PREFIX}${layer.id}`;
  layers[index] = { ...layer, styleRef: inlineId };
  return {
    ...body,
    layers,
    styleRefs: [
      ...(body.styleRefs ?? []).filter((ref) => ref.styleId !== inlineId),
      { styleId: inlineId, body: styleBody },
    ],
  };
}
