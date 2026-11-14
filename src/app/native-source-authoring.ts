import type { HonuaMapPackageSourceBinding } from "@honua/sdk-js/runtime";
import type { CompositionState } from "../composition/model.js";
import {
  type CompositionSourceDescriptor,
  findCompositionSourceDescriptor,
  resolveCompositionSource,
} from "../map/source-resolution.js";

/** Capture public native locators only inside an authorized draft edit, never during rendering. */
export function bindNativeAuthoringSources(
  state: CompositionState,
  catalog: readonly CompositionSourceDescriptor[] = [],
): CompositionState {
  const bindings = new Map(state.sourceBindings?.map((binding) => [binding.sourceId, binding]));
  let changed = false;
  const layers = state.layers.map((layer) => {
    if (findCompositionSourceDescriptor(layer.sourceId, catalog)?.protocol !== "pmtiles") return layer;
    const resolution = resolveCompositionSource(layer, { catalog });
    if ("reason" in resolution || !resolution.binding) return layer;
    changed = true;
    bindings.set(layer.sourceId, resolution.binding as HonuaMapPackageSourceBinding);
    const metadata = layer.metadata?.honua;
    const honua = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
    return {
      ...layer,
      type: resolution.layerType,
      metadata: {
        ...layer.metadata,
        honua: { ...honua, source: resolution.source },
      },
    };
  });
  return changed ? { ...state, layers, sourceBindings: [...bindings.values()] } : state;
}
