// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapStyleDocument } from "../../src/styles/map-style-edit.js";
import {
  MapStyleEditor,
  type MapStyleEditorOptions,
  type MapStyleEditorScope,
} from "../../src/styles/map-style-editor.js";
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
function setup(
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

function previewThematicBreak(container: ParentNode, listed = "10", fieldName = "speed") {
  const field = container.querySelector<HTMLSelectElement>('select[aria-label="Actual source field"]');
  const mode = container.querySelector<HTMLSelectElement>('select[aria-label="Thematic method"]');
  const values = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Explicit thematic values, one per line"]',
  );
  const apply = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Preview thematic colors",
  );
  if (!field || !mode || !values || !apply) throw new Error("Thematic controls are missing.");
  field.value = fieldName;
  field.dispatchEvent(new Event("change"));
  mode.value = "breaks";
  values.value = listed;
  apply.click();
  return { field, mode, values, apply };
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

it("previews typed categories and numeric breaks over actual fields without JSON, retaining dirty guard", async () => {
  const { container, editor, onPreview, onDirty } = setup(
    { kind: "map-local", detachesSharedStyles: true },
    {
      layers: [{ id: "roads", sourceId: "roads" }],
      getFields: async () => [
        { name: "class", type: "string" },
        { name: "speed", type: "number" },
      ],
    },
  );
  await editor.refreshThematicFields();
  const fields = container.querySelector<HTMLSelectElement>('select[aria-label="Actual source field"]')!;
  const mode = container.querySelector<HTMLSelectElement>('select[aria-label="Thematic method"]')!;
  const values = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Explicit thematic values, one per line"]',
  )!;
  const apply = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Preview thematic colors",
  )!;
  values.value = " Residential \nCommercial";
  values.dispatchEvent(new Event("input"));
  expect(editor.dirty).toBe(true);
  expect(onDirty).toHaveBeenCalledWith(true);
  apply.click();
  expect(onPreview).toHaveBeenLastCalledWith(
    expect.objectContaining({
      layers: [
        expect.objectContaining({
          paint: {
            "line-color": ["match", ["get", "class"], " Residential ", "#eff3ff", "Commercial", "#c6dbef", "#9ecae1"],
          },
        }),
      ],
    }),
  );
  fields.value = "speed";
  fields.dispatchEvent(new Event("change"));
  mode.value = "breaks";
  mode.dispatchEvent(new Event("change"));
  values.value = "10\n25";
  apply.click();
  expect(onPreview).toHaveBeenLastCalledWith(
    expect.objectContaining({
      layers: [
        expect.objectContaining({
          paint: { "line-color": ["step", ["to-number", ["get", "speed"]], "#eff3ff", 10, "#c6dbef", 25, "#9ecae1"] },
        }),
      ],
    }),
  );
  values.value = "10\noops";
  values.dispatchEvent(new Event("input"));
  apply.click();
  expect(container.textContent).toContain("finite numeric value");
  expect(editor.dirty).toBe(true);
  await editor.discard();
  expect(editor.dirty).toBe(false);
});

it("keeps the chosen actual field on refresh and refuses a removed field until explicit reselection", async () => {
  let currentFields = [
    { name: "class", type: "string" },
    { name: "speed", type: "number" },
  ];
  const { container, editor, onPreview, onSave } = setup(
    { kind: "map-local", detachesSharedStyles: true },
    { layers: [{ id: "roads", sourceId: "roads" }], getFields: async () => currentFields },
  );
  await editor.refreshThematicFields();
  const field = container.querySelector<HTMLSelectElement>('select[aria-label="Actual source field"]')!;
  const mode = container.querySelector<HTMLSelectElement>('select[aria-label="Thematic method"]')!;
  const values = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Explicit thematic values, one per line"]',
  )!;
  const apply = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Preview thematic colors",
  )!;
  field.value = "speed";
  field.dispatchEvent(new Event("change"));
  mode.value = "breaks";
  values.value = "10\n20";
  currentFields = [
    { name: "status", type: "string" },
    { name: "speed", type: "number" },
  ];
  await editor.refreshThematicFields();
  expect(field.value).toBe("speed");
  apply.click();
  expect(onPreview).toHaveBeenCalledOnce();
  currentFields = [{ name: "status", type: "string" }];
  await editor.refreshThematicFields();
  expect(field.value).toBe("");
  expect(apply.disabled).toBe(true);
  expect(container.textContent).toContain("selected source field is unavailable");
  expect(onPreview).toHaveBeenCalledOnce();
  await editor.save();
  expect(onSave).not.toHaveBeenCalled();
  expect(editor.dirty).toBe(true);
  expect(container.textContent).toContain("no longer available");
  field.value = "status";
  field.dispatchEvent(new Event("change"));
  expect(apply.disabled).toBe(false);
  apply.click();
  expect(container.textContent).toContain("actual numeric field");
  expect(onPreview).toHaveBeenCalledOnce();
});

it("treats an actual OID field as numeric categories", async () => {
  const { container, editor, onPreview } = setup(
    { kind: "map-local", detachesSharedStyles: true },
    {
      layers: [{ id: "roads", sourceId: "roads" }],
      getFields: async () => [{ name: "OBJECTID", type: "esriFieldTypeOID" }],
    },
  );
  await editor.refreshThematicFields();
  const field = container.querySelector<HTMLSelectElement>('select[aria-label="Actual source field"]')!;
  field.value = "OBJECTID";
  field.dispatchEvent(new Event("change"));
  const values = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Explicit thematic values, one per line"]',
  )!;
  values.value = "1\n2";
  const apply = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Preview thematic colors",
  )!;
  apply.click();
  expect(onPreview).toHaveBeenLastCalledWith(
    expect.objectContaining({
      layers: [
        expect.objectContaining({
          paint: { "line-color": ["match", ["get", "OBJECTID"], 1, "#eff3ff", 2, "#c6dbef", "#9ecae1"] },
        }),
      ],
    }),
  );
});

it("revalidates every applied owner after frame flush before save", async () => {
  const twoLayers = {
    version: 8,
    sources: { roads: style.sources.roads, water: style.sources.roads },
    layers: [style.layers[0], { id: "water", type: "line", source: "water", paint: { "line-color": "#0000ff" } }],
  };
  let roadFields = [
    { name: "speed", type: "number" },
    { name: "other", type: "number" },
  ];
  const { container, editor, onSave } = setup(
    { kind: "map-local", detachesSharedStyles: true },
    {
      layers: [
        { id: "roads", sourceId: "roads" },
        { id: "water", sourceId: "water" },
      ],
      getFields: async (sourceId) => (sourceId === "roads" ? roadFields : [{ name: "quality", type: "string" }]),
    },
    twoLayers,
  );
  await editor.refreshThematicFields();
  const owner = container.querySelector<HTMLSelectElement>('select[aria-label="Map layer for styling"]')!;
  const field = container.querySelector<HTMLSelectElement>('select[aria-label="Actual source field"]')!;
  const mode = container.querySelector<HTMLSelectElement>('select[aria-label="Thematic method"]')!;
  const values = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Explicit thematic values, one per line"]',
  )!;
  const apply = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Preview thematic colors",
  )!;
  field.value = "speed";
  field.dispatchEvent(new Event("change"));
  mode.value = "breaks";
  values.value = "10";
  apply.click();
  owner.value = "water";
  owner.dispatchEvent(new Event("change"));
  await editor.refreshThematicFields();
  field.value = "quality";
  field.dispatchEvent(new Event("change"));
  mode.value = "categories";
  values.value = "Good";
  apply.click();
  roadFields = [{ name: "other", type: "number" }];
  await editor.save();
  expect(onSave).not.toHaveBeenCalled();
  expect(editor.dirty).toBe(true);
  expect(container.textContent).toContain("no longer available");
  apply.click();
  await editor.save();
  expect(onSave).not.toHaveBeenCalled();
  owner.value = "roads";
  owner.dispatchEvent(new Event("change"));
  await editor.refreshThematicFields();
  field.value = "other";
  field.dispatchEvent(new Event("change"));
  mode.value = "breaks";
  values.value = "15";
  apply.click();
  await editor.save();
  expect(onSave).toHaveBeenCalledOnce();
  expect(editor.dirty).toBe(false);
});

it("enables save after a valid thematic preview replaces an invalid binding", async () => {
  let fields = [{ name: "speed", type: "number" }];
  const { container, editor, onSave } = setup(
    { kind: "map-local", detachesSharedStyles: true },
    { layers: [{ id: "roads", sourceId: "roads" }], getFields: async () => fields },
  );
  await editor.refreshThematicFields();
  const { apply } = previewThematicBreak(container);
  const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Save map style");
  if (!save) throw new Error("Save is missing.");
  expect(save.disabled).toBe(false);
  fields = [{ name: "class", type: "string" }];
  await editor.refreshThematicFields();
  expect(save.disabled).toBe(true);
  const field = container.querySelector<HTMLSelectElement>('select[aria-label="Actual source field"]')!;
  const mode = container.querySelector<HTMLSelectElement>('select[aria-label="Thematic method"]')!;
  const values = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Explicit thematic values, one per line"]',
  )!;
  field.value = "class";
  field.dispatchEvent(new Event("change"));
  mode.value = "categories";
  values.value = "Residential";
  apply.click();
  expect(save.disabled).toBe(false);
  await editor.save();
  expect(onSave).toHaveBeenCalledOnce();
});

it("refuses a same-name thematic field whose actual type changed", async () => {
  let fieldType = "number";
  const { container, editor, onSave } = setup(
    { kind: "map-local", detachesSharedStyles: true },
    {
      layers: [{ id: "roads", sourceId: "roads" }],
      getFields: async () => [{ name: "speed", type: fieldType }],
    },
  );
  await editor.refreshThematicFields();
  const field = container.querySelector<HTMLSelectElement>('select[aria-label="Actual source field"]')!;
  field.value = "speed";
  field.dispatchEvent(new Event("change"));
  const mode = container.querySelector<HTMLSelectElement>('select[aria-label="Thematic method"]')!;
  const values = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Explicit thematic values, one per line"]',
  )!;
  const apply = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Preview thematic colors",
  )!;
  mode.value = "breaks";
  values.value = "10";
  apply.click();
  fieldType = "string";
  await editor.refreshThematicFields();
  await editor.save();
  expect(onSave).not.toHaveBeenCalled();
  expect(editor.dirty).toBe(true);
  expect(container.textContent).toContain("no longer available");
});

it("blocks saving an applied thematic preview while its field refresh is pending", async () => {
  let resolveRefresh: ((fields: readonly { name: string; type: string }[]) => void) | undefined;
  let reads = 0;
  const getFields = vi.fn(async () => {
    reads++;
    if (reads === 3)
      return await new Promise<readonly { name: string; type: string }[]>((resolve) => {
        resolveRefresh = resolve;
      });
    return [{ name: "speed", type: "number" }];
  });
  const { container, editor, onSave } = setup(
    { kind: "map-local", detachesSharedStyles: true },
    { layers: [{ id: "roads", sourceId: "roads" }], getFields },
  );
  await editor.refreshThematicFields();
  const field = container.querySelector<HTMLSelectElement>('select[aria-label="Actual source field"]')!;
  field.value = "speed";
  field.dispatchEvent(new Event("change"));
  const mode = container.querySelector<HTMLSelectElement>('select[aria-label="Thematic method"]')!;
  const values = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Explicit thematic values, one per line"]',
  )!;
  const apply = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Preview thematic colors",
  )!;
  mode.value = "breaks";
  values.value = "10";
  apply.click();
  const refresh = editor.refreshThematicFields();
  await editor.save();
  expect(onSave).not.toHaveBeenCalled();
  expect(editor.dirty).toBe(true);
  resolveRefresh!([{ name: "speed", type: "number" }]);
  await refresh;
  await editor.save();
  expect(onSave).toHaveBeenCalledOnce();
});

it("recovers when the field source throws before returning a promise", async () => {
  let reads = 0;
  const getFields = vi.fn(() => {
    reads++;
    if (reads >= 3) throw new Error("The field source failed before it could answer.");
    return Promise.resolve([{ name: "speed", type: "number" }]);
  });
  const { container, editor, onSave } = setup(
    { kind: "map-local", detachesSharedStyles: true },
    { layers: [{ id: "roads", sourceId: "roads" }], getFields },
  );
  await editor.refreshThematicFields();
  const { apply } = previewThematicBreak(container);
  await editor.refreshThematicFields();
  const status = container.querySelector("[role='status']")!;
  expect(status.textContent).toContain("The field source failed before it could answer.");
  await editor.save();
  expect(onSave).not.toHaveBeenCalled();
  expect(status.textContent).toContain("no longer available");
  expect(status.textContent).not.toContain("Wait for the current thematic field refresh");
  apply.click();
  expect(status.textContent).not.toContain("Wait for the current field refresh.");
});

it("refuses save when disposal happens during post-flush field revalidation", async () => {
  let resolveRevalidation: ((fields: readonly { name: string; type: string }[]) => void) | undefined;
  let reads = 0;
  const getFields = vi.fn(async () => {
    reads++;
    if (reads === 3)
      return await new Promise<readonly { name: string; type: string }[]>((resolve) => {
        resolveRevalidation = resolve;
      });
    return [{ name: "speed", type: "number" }];
  });
  const { container, editor, onSave } = setup(
    { kind: "map-local", detachesSharedStyles: true },
    { layers: [{ id: "roads", sourceId: "roads" }], getFields },
  );
  await editor.refreshThematicFields();
  const field = container.querySelector<HTMLSelectElement>('select[aria-label="Actual source field"]')!;
  field.value = "speed";
  field.dispatchEvent(new Event("change"));
  const mode = container.querySelector<HTMLSelectElement>('select[aria-label="Thematic method"]')!;
  const values = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Explicit thematic values, one per line"]',
  )!;
  const apply = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Preview thematic colors",
  )!;
  mode.value = "breaks";
  values.value = "10";
  apply.click();
  const save = editor.save();
  await vi.waitFor(() => expect(resolveRevalidation).toBeDefined());
  editor.dispose();
  resolveRevalidation!([{ name: "speed", type: "number" }]);
  await save;
  expect(onSave).not.toHaveBeenCalled();
});

it("allows an unrelated advanced Maputnik replacement after removing its thematic expression", async () => {
  let fields = [{ name: "speed", type: "number" }];
  const { container, editor, onSave, onPreview, send } = setup(
    { kind: "map-local", detachesSharedStyles: true },
    { layers: [{ id: "roads", sourceId: "roads" }], getFields: async () => fields },
  );
  await editor.refreshThematicFields();
  const field = container.querySelector<HTMLSelectElement>('select[aria-label="Actual source field"]')!;
  field.value = "speed";
  field.dispatchEvent(new Event("change"));
  const mode = container.querySelector<HTMLSelectElement>('select[aria-label="Thematic method"]')!;
  const values = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Explicit thematic values, one per line"]',
  )!;
  const apply = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Preview thematic colors",
  )!;
  mode.value = "breaks";
  values.value = "10";
  apply.click();
  const advanced = structuredClone(onPreview.mock.lastCall![0]) as typeof style;
  advanced.layers[0].paint["line-color"] = "#224466";
  send(advanced);
  fields = [];
  await editor.refreshThematicFields();
  await editor.save();
  expect(onSave).toHaveBeenCalledOnce();
  expect(editor.dirty).toBe(false);
});

it("refreshes actual fields without replacing advanced dirty Maputnik edits", async () => {
  const pending: Array<(fields: readonly { name: string; type: string }[]) => void> = [];
  const getFields = vi.fn(
    () => new Promise<readonly { name: string; type: string }[]>((resolve) => pending.push(resolve)),
  );
  const { container, editor, send, onPreview } = setup(
    { kind: "map-local", detachesSharedStyles: true },
    { layers: [{ id: "roads", sourceId: "roads" }], getFields },
  );
  const older = editor.refreshThematicFields();
  const newer = editor.refreshThematicFields();
  pending[2]!([{ name: "current", type: "string" }]);
  await newer;
  pending[0]!([{ name: "stale", type: "string" }]);
  pending[1]!([{ name: "also stale", type: "string" }]);
  await older;
  const field = container.querySelector<HTMLSelectElement>('select[aria-label="Actual source field"]')!;
  expect(field.textContent).toContain("current");
  const advanced = structuredClone(style);
  advanced.layers[0].paint["line-color"] = "#000000";
  send(advanced);
  const refresh = editor.refreshThematicFields();
  pending[3]!([{ name: "new field", type: "number" }]);
  await refresh;
  expect(editor.dirty).toBe(true);
  expect(onPreview).toHaveBeenLastCalledWith(advanced);
  expect(field.textContent).toContain("new field");
  const afterDispose = editor.refreshThematicFields();
  editor.dispose();
  pending[4]!([{ name: "late", type: "string" }]);
  await afterDispose;
  expect(field.textContent).not.toContain("late");
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
it("saves host-authored feature labels when the visual frame never becomes ready", async () => {
  const { container, editor, frame, onSave, onPreview } = setup(
    { kind: "map-local", detachesSharedStyles: false },
    {
      layers: [{ id: "roads", sourceId: "roads" }],
      getFields: async () => [{ name: "name", type: "string" }],
    },
  );
  vi.mocked(frame.contentWindow!.postMessage).mockImplementation(() => {});
  await editor.refreshThematicFields();
  const labels = [...container.querySelectorAll("label")]
    .find((label) => label.textContent?.startsWith("Labels"))!
    .querySelector("select")!;
  expect(labels.disabled).toBe(false);
  expect([...labels.options].map((option) => option.value)).toEqual(["", "name"]);
  labels.value = "name";
  labels.dispatchEvent(new Event("change"));
  expect(onPreview).toHaveBeenLastCalledWith(
    expect.objectContaining({
      layers: expect.arrayContaining([expect.objectContaining({ id: "roads__labels", type: "symbol" })]),
    }),
  );
  labels.value = "";
  labels.dispatchEvent(new Event("change"));
  expect((onPreview.mock.lastCall?.[0] as { layers: { id: string }[] }).layers.map((layer) => layer.id)).toEqual([
    "roads",
  ]);
  labels.value = "name";
  labels.dispatchEvent(new Event("change"));
  await editor.save();
  expect(onSave).toHaveBeenCalledOnce();
  expect(editor.dirty).toBe(false);
  expect(container.textContent).toContain("Map style saved to the authorized draft.");
});
it("missing canonical save readback retains dirty buffer", async () => {
  const { editor, onSave, send } = setup();
  onSave.mockResolvedValueOnce(undefined as unknown as MapStyleDocument);
  send({ ...style, name: "Unsaved" });
  await editor.save();
  expect(editor.dirty).toBe(true);
});

it("ignores unsolicited flush acknowledgments without an active matching request", () => {
  const { editor, frame, onSave, onPreview } = setup();
  const channel = new URLSearchParams(new URL(frame.src).hash.slice(1)).get("channel");
  expect(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "null",
        data: { type: "honua:style-flushed", channel, settled: true, style },
      }),
    ),
  ).not.toThrow();
  expect(editor.dirty).toBe(false);
  expect(onSave).not.toHaveBeenCalled();
  expect(onPreview).not.toHaveBeenCalled();
});

describe("direct common styling", () => {
  const owners = [
    { id: "stops", sourceId: "stops", title: "Bus stops" },
    { id: "roads", sourceId: "roads", title: "Roads" },
    { id: "parcels", sourceId: "parcels", title: "Parcels" },
  ];
  const geojson = { type: "geojson", data: { type: "FeatureCollection", features: [] } };
  const mixed = {
    version: 8,
    sources: { stops: geojson, roads: geojson, parcels: geojson },
    layers: [
      { id: "stops", type: "circle", source: "stops", paint: { "circle-color": "#112233", "circle-radius": 4 } },
      {
        id: "roads",
        type: "line",
        source: "roads",
        paint: { "line-color": ["interpolate", ["linear"], ["zoom"], 5, "#000000", 10, "#ffffff"], "line-width": 2 },
      },
      { id: "parcels", type: "fill", source: "parcels", paint: { "fill-color": "#445566", "fill-opacity": 0.5 } },
      { id: "parcels__outline", type: "line", source: "parcels", paint: { "line-color": "#000000", "line-width": 1 } },
    ],
  };
  const input = (container: ParentNode, label: string) => {
    const element = [...container.querySelectorAll("label")]
      .find((candidate) => candidate.textContent?.trim().startsWith(label))
      ?.querySelector("input");
    if (!element) throw new Error(`missing ${label}`);
    return element;
  };
  const type = (element: HTMLInputElement, value: string) => {
    element.value = value;
    element.dispatchEvent(new Event("input"));
  };
  const paint = (candidate: unknown, id: string) =>
    ((candidate as typeof mixed).layers.find((layer) => layer.id === id) as { paint: Record<string, unknown> }).paint;
  const owner = (container: ParentNode) =>
    container.querySelector<HTMLSelectElement>('select[aria-label="Map layer for styling"]')!;
  const select = (container: ParentNode, layerId: string) => {
    owner(container).value = layerId;
    owner(container).dispatchEvent(new Event("change"));
  };

  it("previews point, line and polygon color, opacity and size without JSON or a write until Save", async () => {
    const { container, editor, onPreview, onSave } = setup(
      { kind: "map-local", detachesSharedStyles: false },
      { layers: owners },
      mixed,
    );
    expect(input(container, "Point size (px)").value).toBe("4");
    type(input(container, "Color"), "#ff8800");
    type(input(container, "Point size (px)"), "9");
    expect(paint(onPreview.mock.lastCall?.[0], "stops")).toEqual({ "circle-color": "#ff8800", "circle-radius": 9 });

    select(container, "parcels");
    expect(input(container, "Color").value).toBe("#445566");
    expect(input(container, "Opacity").value).toBe("50");
    type(input(container, "Opacity"), "80");
    type(input(container, "Outline width (px)"), "3");
    const previewed = onPreview.mock.lastCall?.[0];
    expect(paint(previewed, "parcels")).toEqual({ "fill-color": "#445566", "fill-opacity": 0.8 });
    expect(paint(previewed, "parcels__outline")).toEqual({ "line-color": "#000000", "line-width": 3 });
    expect(paint(previewed, "stops")).toEqual({ "circle-color": "#ff8800", "circle-radius": 9 });
    expect(onSave).not.toHaveBeenCalled();
    expect(editor.dirty).toBe(true);

    await editor.save();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(paint(onSave.mock.calls[0][0], "parcels")["fill-opacity"]).toBe(0.8);
    expect(container.textContent).toContain("Map style saved to the authorized draft.");
  });

  it("keeps an expression read-only and preserves it through an unrelated direct edit", () => {
    const { container, onPreview } = setup(
      { kind: "map-local", detachesSharedStyles: false },
      { layers: owners, selectedLayerId: "roads" } as Pick<MapStyleEditorOptions, "layers">,
      mixed,
    );
    select(container, "roads");
    expect(input(container, "Color").disabled).toBe(true);
    expect(container.textContent).toContain("Uses an advanced expression or function. Edit it in the advanced editor.");
    type(input(container, "Line width (px)"), "5");
    expect(paint(onPreview.mock.lastCall?.[0], "roads")).toEqual({
      "line-color": ["interpolate", ["linear"], ["zoom"], 5, "#000000", 10, "#ffffff"],
      "line-width": 5,
    });
    type(input(container, "Line width (px)"), "500");
    expect(container.textContent).toContain("between 0 and 50 pixels");
    expect(paint(onPreview.mock.lastCall?.[0], "roads")["line-width"]).toBe(5);
  });

  it("switching layer shows that layer's paint and never retargets the pending edit", () => {
    const { container, onPreview } = setup(
      { kind: "map-local", detachesSharedStyles: false },
      { layers: owners },
      mixed,
    );
    type(input(container, "Color"), "#ff8800");
    select(container, "parcels");
    expect(input(container, "Color").value).toBe("#445566");
    expect(paint(onPreview.mock.lastCall?.[0], "parcels")["fill-color"]).toBe("#445566");
    expect(paint(onPreview.mock.lastCall?.[0], "stops")["circle-color"]).toBe("#ff8800");
  });

  it("discard restores the accepted style and clears the preview without a write", async () => {
    const { container, editor, onPreview, onSave } = setup(
      { kind: "map-local", detachesSharedStyles: false },
      { layers: owners },
      mixed,
    );
    type(input(container, "Color"), "#ff8800");
    await editor.discard();
    expect(onPreview).toHaveBeenLastCalledWith(undefined);
    expect(onSave).not.toHaveBeenCalled();
    expect(input(container, "Color").value).toBe("#112233");
    expect(editor.dirty).toBe(false);
  });

  it("shows a legend that matches the painted classes and hides it once the expression is replaced", async () => {
    const { container, editor, send } = setup(
      { kind: "map-local", detachesSharedStyles: false },
      { layers: owners, getFields: async () => [{ name: "zoning", type: "string" }] },
      mixed,
    );
    select(container, "parcels");
    await editor.refreshThematicFields();
    const values = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Explicit thematic values, one per line"]',
    )!;
    const field = container.querySelector<HTMLSelectElement>('select[aria-label="Actual source field"]')!;
    field.value = "zoning";
    field.dispatchEvent(new Event("change"));
    values.value = "R-1\nB-2";
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Preview thematic colors")!
      .click();
    const legend = container.querySelector<HTMLUListElement>('[data-testid="map-style-legend"]')!;
    expect(legend.hidden).toBe(false);
    expect([...legend.querySelectorAll("li")].map((item) => [item.textContent, item.dataset.color])).toEqual([
      ["R-1", "#eff3ff"],
      ["B-2", "#c6dbef"],
      ["Other", "#9ecae1"],
    ]);
    expect(input(container, "Color").disabled).toBe(true);
    expect(container.textContent).toContain("Uses field-based classes.");
    send({
      ...mixed,
      layers: mixed.layers.map((layer) =>
        layer.id === "parcels" ? { ...layer, paint: { "fill-color": "#000000" } } : layer,
      ),
    });
    expect(legend.hidden).toBe(true);
    expect(input(container, "Color").disabled).toBe(false);
  });
});

describe("direct styling keeps what it cannot represent", () => {
  const geojson = { type: "geojson", data: { type: "FeatureCollection", features: [] } };
  const owners = [{ id: "parcels", sourceId: "parcels" }];
  const control = (container: ParentNode, label: string) =>
    [...container.querySelectorAll("label")]
      .find((candidate) => candidate.textContent?.trim().startsWith(label))
      ?.querySelector<HTMLInputElement | HTMLSelectElement>("input, select");

  it("refuses to flatten a legacy function and explains a non-hex color", () => {
    const { container } = setup(
      { kind: "map-local", detachesSharedStyles: false },
      { layers: owners },
      {
        version: 8,
        sources: { parcels: geojson },
        layers: [
          {
            id: "parcels",
            type: "fill",
            source: "parcels",
            paint: {
              "fill-color": "rgba(200, 0, 0, 0.5)",
              "fill-opacity": {
                stops: [
                  [10, 0],
                  [14, 1],
                ],
              },
            },
          },
        ],
      },
    );
    expect(control(container, "Opacity")?.disabled).toBe(true);
    expect(control(container, "Color")?.disabled).toBe(false);
    expect(container.textContent).toContain("Uses an advanced expression or function.");
    expect(container.textContent).toContain("Current color rgba(200, 0, 0, 0.5) has no exact swatch");
  });

  it("keeps the pending-classes guard through a direct edit", () => {
    const { container, editor } = setup(
      { kind: "map-local", detachesSharedStyles: false },
      { layers: owners, getFields: async () => [{ name: "zoning", type: "string" }] },
      {
        version: 8,
        sources: { parcels: geojson },
        layers: [{ id: "parcels", type: "fill", source: "parcels", paint: { "fill-color": "#445566" } }],
      },
    );
    const values = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Explicit thematic values, one per line"]',
    )!;
    values.value = "R-1";
    values.dispatchEvent(new Event("input"));
    const opacity = control(container, "Opacity") as HTMLInputElement;
    opacity.value = "40";
    opacity.dispatchEvent(new Event("input"));
    expect(editor.dirty).toBe(true);
    const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Save map style")!;
    expect(save.disabled).toBe(true);
    expect(container.textContent).toContain("Apply or discard the pending thematic values.");
  });

  it("shows a custom label expression as read-only instead of No labels", async () => {
    const { container, editor } = setup(
      { kind: "map-local", detachesSharedStyles: false },
      { layers: owners, getFields: async () => [{ name: "name", type: "string" }] },
      {
        version: 8,
        sources: { parcels: geojson },
        layers: [
          { id: "parcels", type: "fill", source: "parcels" },
          {
            id: "parcels__labels",
            type: "symbol",
            source: "parcels",
            layout: { "text-field": ["concat", ["get", "name"], "!"] },
          },
        ],
      },
    );
    await editor.refreshThematicFields();
    const labels = control(container, "Labels") as HTMLSelectElement;
    expect(labels.disabled).toBe(true);
    expect(labels.selectedOptions[0]?.textContent).toBe("Custom labels (advanced editor)");
  });
});
