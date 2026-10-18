// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapStyleDocument } from "../../src/styles/map-style-edit.js";
import { MapStyleEditor, type MapStyleEditorScope } from "../../src/styles/map-style-editor.js";
const style = {
  version: 8,
  sources: { roads: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
  layers: [{ id: "roads", type: "line", source: "roads", paint: { "line-color": "#ff0000" } }],
};
const editors: MapStyleEditor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
  document.body.innerHTML = "";
});
function setup(scope: MapStyleEditorScope = { kind: "map-local", detachesSharedStyles: true }) {
  const container = document.createElement("section");
  document.body.append(container);
  const onSave = vi.fn(async (style: MapStyleDocument) => style);
  const onPreview = vi.fn();
  const onDirty = vi.fn();
  const editor = new MapStyleEditor({
    container,
    document: style,
    assetsUrl: "/maputnik/index.html",
    onSave,
    onPreview,
    onDirty,
    onDiscard: async () => style,
    scope,
  });
  editors.push(editor);
  const frame = container.querySelector("iframe")!;
  const channel = new URLSearchParams(new URL(frame.src).hash.slice(1)).get("channel");
  let latest: unknown = style;
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
    const value = message as { type: string; requestId: string };
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
describe("credential-free controlled Maputnik frame", () => {
  it("uses scripts-only sandbox and a source/channel bound data protocol", () => {
    const { frame, editor, send, onPreview } = setup();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    const next = structuredClone(style);
    next.layers[0].paint["line-color"] = "#000000";
    send(next, { origin: location.origin });
    expect(editor.dirty).toBe(false);
    send(next, { source: window });
    expect(editor.dirty).toBe(false);
    send(next, { data: { type: "honua:style-change", channel: "wrong", style: next } });
    expect(editor.dirty).toBe(false);
    send(next);
    expect(editor.dirty).toBe(true);
    expect(onPreview).toHaveBeenCalledWith(next);
  });
  it("keeps failed/conflicting saves dirty and never reports success", async () => {
    const { editor, onSave, send, container } = setup();
    onSave.mockRejectedValueOnce(new Error("Stale draft generation"));
    const next = structuredClone(style);
    next.layers[0].paint["line-color"] = "#000000";
    send(next);
    await editor.save();
    expect(editor.dirty).toBe(true);
    expect(container.textContent).toContain("Stale draft generation");
    await editor.save();
    expect(editor.dirty).toBe(false);
    expect(onSave).toHaveBeenCalledTimes(2);
  });
  it("rejects invalid newer edits rather than saving an older candidate", async () => {
    const { editor, onSave, send } = setup();
    const next = structuredClone(style);
    next.layers[0].paint["line-color"] = "#000000";
    send(next);
    send({ ...next, glyphs: "https://example.com/secret/{fontstack}/{range}.pbf" });
    await editor.save();
    expect(onSave).not.toHaveBeenCalled();
    expect(editor.dirty).toBe(true);
    await editor.discard();
    expect(editor.dirty).toBe(false);
  });
  it("keeps dirty context blocked when the frame never confirms its current buffer", async () => {
    vi.useFakeTimers();
    try {
      const { editor, frame, send, onSave, container } = setup();
      vi.mocked(frame.contentWindow!.postMessage).mockImplementation(() => {});
      const next = structuredClone(style);
      next.layers[0].paint["line-color"] = "#000000";
      send(next);
      const pending = editor.save();
      await vi.advanceTimersByTimeAsync(5001);
      await pending;
      expect(onSave).not.toHaveBeenCalled();
      expect(editor.dirty).toBe(true);
      expect(container.textContent).toContain("did not confirm its latest buffer");
      const channel = new URLSearchParams(new URL(frame.src).hash.slice(1)).get("channel");
      window.dispatchEvent(
        new MessageEvent("message", {
          source: frame.contentWindow,
          origin: "null",
          data: { type: "honua:style-flushed", channel, requestId: "late", settled: true, style: next },
        }),
      );
      expect(onSave).not.toHaveBeenCalled();
      expect(editor.dirty).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it("preserves dirty text when an external agent changes the saved document", () => {
    const { editor, send, onPreview } = setup();
    const next = structuredClone(style);
    next.layers[0].paint["line-color"] = "#000000";
    send(next);
    editor.observeSavedDocument({ ...style, name: "External edit" });
    expect(editor.dirty).toBe(true);
    expect(onPreview).toHaveBeenLastCalledWith(next);
  });
});

it("shared visual save uses canonical callback readback without injecting map ownership", async () => {
  const { editor, onSave, send, container } = setup({
    kind: "shared-style",
    styleId: "shared",
    version: 4,
    impactHash: "a".repeat(64),
    visibleConsumerCount: 2,
    canEdit: true,
    impactComplete: true,
  });
  const candidate = {
    ...style,
    layers: [...style.layers, { id: "labels", type: "symbol", source: "roads", layout: { "text-field": "Road" } }],
  };
  send(candidate);
  await editor.save();
  expect(onSave).toHaveBeenCalledOnce();
  expect(onSave.mock.calls[0]![0].layers).toEqual(candidate.layers);
  expect(editor.dirty).toBe(false);
  expect(container.textContent).toContain("2 visible consumers");
});
it("shared style permission and incomplete impact prevent the save callback", async () => {
  const { editor, onSave, send } = setup({
    kind: "shared-style",
    styleId: "shared",
    version: 4,
    impactHash: "a".repeat(64),
    visibleConsumerCount: 0,
    canEdit: true,
    impactComplete: false,
  });
  send({ ...style, name: "Unsaved" });
  await editor.save();
  expect(onSave).not.toHaveBeenCalled();
  expect(editor.dirty).toBe(true);
});
it("missing canonical save readback retains dirty buffer", async () => {
  const { editor, onSave, send } = setup();
  onSave.mockResolvedValueOnce(undefined as unknown as MapStyleDocument);
  send({ ...style, name: "Unsaved" });
  await editor.save();
  expect(editor.dirty).toBe(true);
});
