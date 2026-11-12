// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MapStyleDocument } from "../../src/styles/map-style-edit.js";
import type { MapStyleEditorOptions } from "../../src/styles/map-style-editor.js";
import { disposeEditors, setup } from "./map-style-editor-harness.js";

afterEach(disposeEditors);

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

it("saves a direct edit made moments before Save even though the frame reload is still debounced", async () => {
  const geojson = { type: "geojson", data: { type: "FeatureCollection", features: [] } };
  const { container, editor, frame, onSave } = setup(
    { kind: "map-local", detachesSharedStyles: false },
    { layers: [{ id: "parcels", sourceId: "parcels" }] },
    {
      version: 8,
      sources: { parcels: geojson },
      layers: [{ id: "parcels", type: "fill", source: "parcels", paint: { "fill-opacity": 1 } }],
    },
  );
  window.dispatchEvent(
    new MessageEvent("message", {
      source: frame.contentWindow,
      origin: "null",
      data: {
        type: "honua:style-ready",
        channel: new URLSearchParams(new URL(frame.src).hash.slice(1)).get("channel"),
      },
    }),
  );
  const opacity = [...container.querySelectorAll("label")]
    .find((label) => label.textContent?.trim().startsWith("Opacity"))!
    .querySelector("input")!;
  opacity.value = "30";
  opacity.dispatchEvent(new Event("input"));
  await editor.save();
  const saved = onSave.mock.calls[0]?.[0] as { layers: { paint: Record<string, unknown> }[] };
  expect(saved.layers[0].paint["fill-opacity"]).toBe(0.3);
});

it("a label pick keeps the pending-classes guard", async () => {
  const geojson = { type: "geojson", data: { type: "FeatureCollection", features: [] } };
  const { container, editor } = setup(
    { kind: "map-local", detachesSharedStyles: false },
    { layers: [{ id: "parcels", sourceId: "parcels" }], getFields: async () => [{ name: "name", type: "string" }] },
    { version: 8, sources: { parcels: geojson }, layers: [{ id: "parcels", type: "fill", source: "parcels" }] },
  );
  await editor.refreshThematicFields();
  const values = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Explicit thematic values, one per line"]',
  )!;
  values.value = "R-1";
  values.dispatchEvent(new Event("input"));
  const labels = [...container.querySelectorAll("label")]
    .find((label) => label.textContent?.startsWith("Labels"))!
    .querySelector("select")!;
  labels.value = "name";
  labels.dispatchEvent(new Event("change"));
  const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "Save map style")!;
  expect(save.disabled).toBe(true);
});
