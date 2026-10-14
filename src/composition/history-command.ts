import { toStudioCompositionBody } from "../mcp/tool-bridge.js";
import type { CompositionCommand } from "./commands.js";
import { type CompositionState, canonicalCompositionJson } from "./model.js";
import { applyCompositionCommand } from "./reducer.js";

/** Return a single bounded inverse only when the reducer proves it recreates the target exactly. */
export function historyCommand(before: CompositionState, target: CompositionState): CompositionCommand | undefined {
  const candidates: CompositionCommand[] = [];
  for (const layer of before.layers) {
    if (!target.layers.some((entry) => entry.id === layer.id))
      candidates.push({ name: "removeLayer", target: { kind: "layer", id: layer.id } });
  }
  for (const [index, layer] of target.layers.entries()) {
    if (!before.layers.some((entry) => entry.id === layer.id))
      candidates.push({
        name: "addLayer",
        layer,
        ...(target.layers[index + 1] ? { beforeId: target.layers[index + 1].id } : {}),
      });
    else {
      candidates.push({ name: "setVisibility", target: { kind: "layer", id: layer.id }, visible: layer.visible });
      candidates.push({ name: "setLayerStyleRef", target: { kind: "layer", id: layer.id }, styleRef: layer.styleRef });
    }
  }
  for (const widget of before.widgets) {
    if (!target.widgets.some((entry) => entry.id === widget.id))
      candidates.push({ name: "removeWidget", target: { kind: "component", id: widget.id } });
  }
  for (const widget of target.widgets) {
    if (!before.widgets.some((entry) => entry.id === widget.id)) candidates.push({ name: "addWidget", widget });
  }
  for (const control of before.controls) {
    if (!target.controls.some((entry) => entry.id === control.id))
      candidates.push({ name: "removeControl", target: { kind: "control", id: control.id } });
  }
  for (const control of target.controls) {
    if (!before.controls.some((entry) => entry.id === control.id)) candidates.push({ name: "addControl", control });
  }
  for (const interaction of before.interactions) {
    if (!target.interactions.some((entry) => entry.id === interaction.id))
      candidates.push({ name: "removeInteraction", interactionId: interaction.id });
  }
  for (const interaction of target.interactions) {
    if (!before.interactions.some((entry) => entry.id === interaction.id))
      candidates.push({ name: "bindInteraction", interaction });
  }
  candidates.push({ name: "setView", view: target.view });
  const expected = canonicalCompositionJson(toStudioCompositionBody(target));
  return candidates.find((command) => {
    try {
      return (
        canonicalCompositionJson(toStudioCompositionBody(applyCompositionCommand(before, command).state)) === expected
      );
    } catch {
      return false;
    }
  });
}
