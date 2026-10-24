import { type CompositionState, createEmptyCompositionState } from "../../src/composition/model.js";

export function designFixture(): CompositionState {
  return {
    ...createEmptyCompositionState(),
    layers: [
      { id: "places", sourceId: "source-a", title: "Places", visible: true },
      { id: "elsewhere", sourceId: "source-b", title: "Places", visible: true },
    ],
    widgets: [
      { id: "table", kind: "table", sourceId: "places", config: { fields: ["name", "missing"], primaryKey: "id" } },
      {
        id: "chart",
        kind: "chart",
        sourceId: "source-a",
        config: { groupBy: "category", measure: { fn: "sum", field: "amount" } },
      },
      { id: "compare", kind: "compare", config: { left: "places", right: "elsewhere", title: "unrelated" } },
    ],
    controls: [
      { id: "filter", kind: "filterSelect", sourceId: "source-a", config: { field: "category", options: ["A", "B"] } },
    ],
    interactions: [
      {
        id: "hide",
        on: { ref: "control:filter", event: "change" },
        do: { ref: "layer:places", verb: "setVisibility", args: { visible: false } },
      },
      {
        id: "query",
        on: { ref: "control:filter", event: "change" },
        do: { ref: "widget:table", verb: "runWidgetQuery" },
      },
      {
        id: "disabled",
        disabled: true,
        on: { ref: "control:filter", event: "change" },
        do: { ref: "layer:places", verb: "setVisibility", args: { visible: true } },
      },
    ],
    mapSpec: {
      version: 8,
      sources: {},
      layers: [
        {
          id: "places",
          type: "circle",
          source: "source-a",
          paint: { "circle-radius": ["get", "amount"] },
          filter: ["==", ["get", "category"], "A"],
        },
        { id: "elsewhere", source: "source-b", paint: { "circle-radius": ["get", "other"] } },
      ],
    },
  };
}
