import type { CompositionState } from "../composition/model.js";
import { toStudioCompositionBody } from "./tool-bridge.js";

/** Canonical map-family metadata; composition blocks are preserved alongside it. */
export const MAP_COMPOSITION_ENVELOPE = {
  family: "map",
  schemaVersion: "1.0",
  format: "honua_map_package.v1",
} as const;

/** Update only composition-owned members; keep the stored package identity and other durable metadata. */
export function toCompositionDraftBody(
  state: CompositionState,
  packageKey: string,
  family = "map",
  previous: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const body = { ...previous };
  // Omitted optional composition blocks mean removal, not retention.
  for (const key of ["layers", "view", "widgets", "controls", "interactions"]) delete body[key];
  return {
    ...(family === "map" ? { mapPackageId: packageKey, format: MAP_COMPOSITION_ENVELOPE.format } : {}),
    ...body,
    ...toStudioCompositionBody(state),
  };
}
