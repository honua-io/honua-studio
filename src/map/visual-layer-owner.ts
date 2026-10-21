import { OUTLINE_LAYER_SUFFIX } from "./constants.js";

/** A primary or companion outline ID takes precedence over authored metadata. */
export function resolveVisualLayerOwner(
  layer: { readonly id: string; readonly metadata?: unknown },
  knownOwners: ReadonlySet<string>,
): { readonly owner: string | undefined; readonly conflictingMetadata: boolean } {
  const metadata = layer.metadata;
  const metadataOwner =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>)["honua:compositionLayerId"]
      : undefined;
  const outlineOwner = layer.id.endsWith(OUTLINE_LAYER_SUFFIX)
    ? layer.id.slice(0, -OUTLINE_LAYER_SUFFIX.length)
    : undefined;
  const canonicalOwner = knownOwners.has(layer.id)
    ? layer.id
    : outlineOwner && knownOwners.has(outlineOwner)
      ? outlineOwner
      : undefined;
  return {
    owner:
      canonicalOwner ??
      (typeof metadataOwner === "string" && knownOwners.has(metadataOwner) ? metadataOwner : undefined),
    conflictingMetadata:
      canonicalOwner !== undefined && typeof metadataOwner === "string" && metadataOwner !== canonicalOwner,
  };
}
