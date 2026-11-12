import { vi } from "vitest";
import type { MapStyleDocument } from "../../src/styles/map-style-edit.js";
import {
  MapStyleEditor,
  type MapStyleEditorOptions,
  type MapStyleEditorScope,
} from "../../src/styles/map-style-editor.js";
export const style = {
  version: 8,
  sources: { roads: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
  layers: [{ id: "roads", type: "line", source: "roads", paint: { "line-color": "#ff0000" } }],
};
const editors: MapStyleEditor[] = [];
/** Register with `afterEach` in every file that calls {@link setup}. */
export function disposeEditors(): void {
  for (const editor of editors.splice(0)) editor.dispose();
  document.body.innerHTML = "";
}
export function setup(
  scope: MapStyleEditorScope = { kind: "map-local", detachesSharedStyles: true },
  thematic: Pick<MapStyleEditorOptions, "layers" | "getFields"> = {},
  documentStyle: MapStyleDocument = style,
) {
  const container = document.createElement("section");
  document.body.append(container);
  const onSave = vi.fn(async (style: MapStyleDocument) => style);
  const onPreview = vi.fn();
  const onDirty = vi.fn();
  const editor = new MapStyleEditor({
    container,
    document: documentStyle,
    assetsUrl: "/maputnik/index.html",
    onSave,
    onPreview,
    onDirty,
    onDiscard: async () => documentStyle,
    scope,
    ...thematic,
  });
  editors.push(editor);
  const frame = container.querySelector("iframe")!;
  const channel = new URLSearchParams(new URL(frame.src).hash.slice(1)).get("channel");
  let latest: unknown = documentStyle;
  const send = (candidate: unknown, overrides: Partial<MessageEventInit> = {}) => {
    latest = candidate;
    return window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "null",
        data: { type: "honua:style-change", channel, style: candidate },
        ...overrides,
      }),
    );
  };
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((message: unknown) => {
    const value = message as { type: string; requestId: string; style?: unknown };
    if (value.type === "honua:style-load") latest = value.style;
    if (value.type === "honua:style-flush")
      queueMicrotask(() =>
        window.dispatchEvent(
          new MessageEvent("message", {
            source: frame.contentWindow,
            origin: "null",
            data: { type: "honua:style-flushed", channel, requestId: value.requestId, settled: true, style: latest },
          }),
        ),
      );
  });
  return { container, frame, editor, onSave, onPreview, onDirty, send };
}
