// Plain JavaScript so the client reducer and the Node mock server share one rule.

/**
 * The first control or widget, controls before widgets, that removing `layerId` would leave reading a
 * source no remaining layer declares; honua-server applies the same rule and message.
 */
export function layerRemovalBlocker(composition, layerId) {
  const removed = composition.layers.find((layer) => layer.id === layerId);
  if (!removed) return undefined;
  const remaining = composition.layers.filter((layer) => layer.id !== layerId);
  const orphaned = (sourceId) =>
    sourceId !== undefined &&
    (sourceId === removed.id || sourceId === removed.sourceId) &&
    !remaining.some((layer) => layer.sourceId === sourceId);
  const control = (composition.controls ?? []).find((candidate) => orphaned(candidate.sourceId));
  const widget = control ? undefined : (composition.widgets ?? []).find((candidate) => orphaned(candidate.sourceId));
  const [role, consumer] = control ? ["control", control] : widget ? ["widget", widget] : [];
  if (!consumer) return undefined;
  return {
    role,
    consumerId: consumer.id,
    sourceId: consumer.sourceId,
    message: `Cannot remove layer '${layerId}' because ${role} '${consumer.id}' still uses sourceId '${consumer.sourceId}'. Remove or rebind the ${role} first.`,
  };
}
