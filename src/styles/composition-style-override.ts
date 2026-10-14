import type { HonuaStyleRefLayerOverride } from "@honua/sdk-js/runtime";

/** Canonical styling stays subordinate to explicit composition visibility and active controls. */
export function compositionStyleOverride(
  canonical: HonuaStyleRefLayerOverride,
  layerType: string,
  visible: boolean,
  appearance?: { readonly filter?: unknown; readonly opacity?: number },
): HonuaStyleRefLayerOverride {
  const paint = { ...canonical.paint };
  if (appearance?.opacity !== undefined) {
    const multiplier = Math.min(1, Math.max(0, appearance.opacity));
    const key = `${layerType}-opacity`;
    const opacity = paint[key] ?? 1;
    paint[key] = typeof opacity === "number" ? opacity * multiplier : ["*", opacity, multiplier];
  }
  const filter =
    appearance?.filter === undefined
      ? canonical.filter
      : canonical.filter === undefined
        ? appearance.filter
        : ["all", canonical.filter, appearance.filter];
  return {
    ...canonical,
    paint,
    ...(canonical.layout || !visible
      ? { layout: { ...canonical.layout, ...(!visible ? { visibility: "none" } : {}) } }
      : {}),
    ...(filter !== undefined ? { filter } : {}),
  };
}
