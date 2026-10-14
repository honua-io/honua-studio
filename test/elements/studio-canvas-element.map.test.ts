// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthSession } from "../../src/auth/types.js";
import { CompositionController } from "../../src/composition/controller.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioCanvasElement } from "../../src/elements/studio-canvas-element.js";
import type { HonuaStudioSelectionChangeDetail } from "../../src/elements/types.js";
import type {
  CompositionMapFactory,
  CompositionMapFactoryOptions,
  CompositionMapLike,
} from "../../src/map/composition-map-view.js";
import type { CompositionSourceDescriptor } from "../../src/map/source-resolution.js";
import { installRuntimeConfig, runtimeConfig } from "../../src/runtime-config.js";

registerAllStudioElements();

/**
 * Generous on purpose. Starting the map means awaiting a *dynamic* import of
 * `src/map/index.js`, which Vitest transforms on first use — 86 KB of vendored
 * basemap geometry included. On a loaded machine that first transform alone
 * can take seconds, and a tight bound here would flake for reasons that have
 * nothing to do with what these tests assert.
 */
const MAP_START_TIMEOUT_MS = 20_000;

const CATALOG: readonly CompositionSourceDescriptor[] = [
  { id: "hi-parcels", title: "Parcels", protocol: "ogc-features", geometryType: "Polygon" },
  { id: "hi-imagery", title: "Imagery", protocol: "stac", geometryType: "Raster" },
];

interface FakeMap extends CompositionMapLike {
  styles: { layers: { id: string }[] }[];
  emit(type: string, event: unknown): void;
  setRenderedFeatures(features: readonly unknown[]): void;
  removed: boolean;
}

function createFakeMap(): FakeMap {
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  let renderedFeatures: readonly unknown[] = [];
  return {
    styles: [],
    removed: false,
    setStyle(style) {
      (this as FakeMap).styles.push(style as { layers: { id: string }[] });
      return undefined;
    },
    jumpTo: () => undefined,
    easeTo: () => undefined,
    fitBounds: () => undefined,
    on(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      return undefined;
    },
    queryRenderedFeatures: () => renderedFeatures,
    resize: () => undefined,
    remove() {
      (this as FakeMap).removed = true;
    },
    emit(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    setRenderedFeatures(features) {
      renderedFeatures = features;
    },
  } as FakeMap;
}

/** Mounts a canvas already wired to an injected map, and waits for the async start to settle. */
async function mountWithMap(options: { catalog?: readonly CompositionSourceDescriptor[] } = {}) {
  const map = createFakeMap();
  const factoryCalls: CompositionMapFactoryOptions[] = [];
  const factory: CompositionMapFactory = async (factoryOptions) => {
    factoryCalls.push(factoryOptions);
    map.setStyle(factoryOptions.style);
    return map;
  };
  const element = document.createElement("honua-studio-canvas") as HonuaStudioCanvasElement;
  const controller = new CompositionController(createEmptyCompositionState());
  element.mapFactory = factory;
  element.viewTransitionMs = 0;
  element.sourceCatalog = options.catalog ?? CATALOG;
  element.composition = controller;
  document.body.appendChild(element);
  await vi.waitUntil(() => element.mapView?.status === "ready", { timeout: MAP_START_TIMEOUT_MS, interval: 5 });
  return { element, controller, map, factoryCalls };
}

function readoutText(element: HonuaStudioCanvasElement, testId: string): string {
  return element.shadowRoot?.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

afterEach(() => {
  installRuntimeConfig(undefined);
  document.body.innerHTML = "";
});

describe("<honua-studio-canvas> map surface (honua-studio#23)", () => {
  it("resolves the latest inherited session while preserving a direct override", () => {
    const element = document.createElement("honua-studio-canvas") as HonuaStudioCanvasElement;
    const first = { getAccessToken: async () => "first" } as AuthSession;
    const next = { getAccessToken: async () => "next" } as AuthSession;
    const host = { auth: first };
    vi.spyOn(element, "closest").mockReturnValue(host as unknown as Element);
    expect(element.auth).toBe(first);
    host.auth = next;
    expect(element.auth).toBe(next);
    element.auth = first;
    expect(element.auth).toBe(first);
    element.auth = undefined;
    expect(element.auth).toBe(next);
  });

  it("authenticates against the configured data root even when the API root differs", async () => {
    installRuntimeConfig({
      ...runtimeConfig(),
      serverBaseUrl: "https://api.test/admin/api",
      mcpBaseUrl: "https://data.test/honua",
    });
    const { factoryCalls } = await mountWithMap();
    expect(factoryCalls[0]?.sourceBaseUrl).toBe("https://data.test/honua");
    expect(factoryCalls[0]?.legacySourceBaseUrl).toBe("https://api.test/admin/api");
  });

  it("restarts failed sources when a direct host session arrives and respects a custom data root", async () => {
    const { element, factoryCalls } = await mountWithMap();
    const firstView = element.mapView;
    const auth = { getAccessToken: async () => "late-token" } as AuthSession;
    element.sourceBaseUrl = "https://custom.test/maps";
    element.auth = auth;
    await vi.waitUntil(() => element.mapView?.status === "ready" && element.mapView !== firstView);
    expect(factoryCalls.at(-1)?.getAuth?.()).toBe(auth);
    expect(factoryCalls.at(-1)?.sourceBaseUrl).toBe("https://custom.test/maps");
    const currentView = element.mapView;
    element.auth = auth;
    expect(element.mapView).toBe(currentView);
  });

  it("renders a map container and starts a map view when one can be constructed", async () => {
    const { element, map } = await mountWithMap();
    expect(element.shadowRoot?.querySelector('[data-testid="studio-canvas-map"]')).toBeTruthy();
    expect(map.styles.length).toBeGreaterThan(0);
    expect(element.mapView?.status).toBe("ready");
  });

  it("keeps the honua-studio#8 readout — and every one of its test ids — alongside the map", async () => {
    const { element, controller } = await mountWithMap();
    controller.apply({ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels", title: "Parcels" } });
    controller.apply({ name: "addWidget", widget: { id: "chart-1", kind: "chart" } });
    controller.apply({ name: "pin", target: { kind: "layer", id: "hi-parcels" } });

    for (const testId of [
      "studio-canvas-readout",
      "studio-canvas-layers",
      "studio-canvas-view",
      "studio-canvas-widgets",
      "studio-canvas-annotations",
      "studio-canvas-pins",
    ]) {
      expect(element.shadowRoot?.querySelector(`[data-testid="${testId}"]`)).toBeTruthy();
    }
    expect(readoutText(element, "studio-canvas-layers")).toContain("Parcels");
    expect(readoutText(element, "studio-canvas-widgets")).toContain("chart-1");
    // Never hidden: the readout is the map's accessible description.
    const readout = element.shadowRoot?.querySelector<HTMLElement>('[data-testid="studio-canvas-readout"]');
    expect(readout?.hidden).toBe(false);
    const map = element.shadowRoot?.querySelector<HTMLElement>('[data-testid="studio-canvas-map"]');
    expect(map?.getAttribute("aria-describedby")).toBe(readout?.id);
  });

  it("does NOT rebuild the shell on a composition change — the map node must survive every tool call", async () => {
    const { element, controller, map } = await mountWithMap();
    const container = element.shadowRoot?.querySelector('[data-testid="studio-canvas-map"]');

    controller.apply({ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } });
    controller.apply({ name: "setView", view: { zoom: 9 } });
    await element.mapView?.settled();

    expect(element.shadowRoot?.querySelector('[data-testid="studio-canvas-map"]')).toBe(container);
    expect(map.removed).toBe(false);
  });

  it("switches surfaces without tearing the map down", async () => {
    const { element, map } = await mountWithMap();
    const mapContainer = element.shadowRoot?.querySelector<HTMLElement>('[data-testid="studio-canvas-map"]');
    expect(mapContainer?.hidden).toBe(false);

    element.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="studio-canvas-mode-details"]')?.click();
    expect(element.surface).toBe("details");
    expect(mapContainer?.hidden).toBe(true);
    expect(map.removed).toBe(false);

    element.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="studio-canvas-mode-map"]')?.click();
    expect(mapContainer?.hidden).toBe(false);
  });

  it("turns a map feature click into a selection and a honua-studio-selection-change event", async () => {
    const { element, controller, map } = await mountWithMap();
    controller.apply({ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } });
    await element.mapView?.settled();

    const listener = vi.fn();
    element.addEventListener("honua-studio-selection-change", listener as EventListener);
    map.setRenderedFeatures([{ id: 12, source: "hi-parcels", layer: { id: "hi-parcels" } }]);
    map.emit("click", { point: { x: 5, y: 5 } });

    expect(controller.selection).toEqual([
      { kind: "feature", sourceId: "hi-parcels", featureId: 12 },
      { kind: "layer", id: "hi-parcels" },
    ]);
    const detail = (listener.mock.calls[0]?.[0] as CustomEvent<HonuaStudioSelectionChangeDetail>).detail;
    expect(detail.targets).toHaveLength(2);
  });

  it("flags a layer the map cannot render in the readout rather than dropping it", async () => {
    const { element, controller } = await mountWithMap();
    controller.apply({ name: "addLayer", layer: { id: "hi-imagery", sourceId: "hi-imagery" } });
    await element.mapView?.settled();

    expect(readoutText(element, "studio-canvas-layers")).toContain("hi-imagery");
    expect(element.shadowRoot?.querySelector('[data-testid="studio-canvas-unrendered"]')).toBeTruthy();
    expect(readoutText(element, "studio-canvas-map-status")).toContain("not renderable");
  });

  it("still selects from a readout row — the keyboard-reachable path #8 established", async () => {
    const { element, controller } = await mountWithMap();
    controller.apply({ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } });
    element.shadowRoot
      ?.querySelector<HTMLButtonElement>('[data-target-kind="layer"][data-target-id="hi-parcels"]')
      ?.click();
    expect(controller.selection).toEqual([{ kind: "layer", id: "hi-parcels" }]);
  });

  it("disposes the map on disconnect, leaking nothing", async () => {
    const { element, map } = await mountWithMap();
    element.remove();
    expect(map.removed).toBe(true);
    expect(element.mapView).toBeUndefined();
  });

  it("falls back to the readout, with a reason, when no map can be constructed", async () => {
    const element = document.createElement("honua-studio-canvas") as HonuaStudioCanvasElement;
    element.mapFactory = async () => {
      throw new Error("WebGL context creation failed");
    };
    element.composition = new CompositionController(createEmptyCompositionState());
    document.body.appendChild(element);
    await vi.waitUntil(() => readoutText(element, "studio-canvas-map-status").includes("unavailable"), {
      timeout: MAP_START_TIMEOUT_MS,
      interval: 5,
    });

    expect(readoutText(element, "studio-canvas-map-status")).toContain("Map unavailable");
    expect(element.shadowRoot?.querySelector<HTMLElement>('[data-testid="studio-canvas-map"]')?.hidden).toBe(true);
    expect(element.shadowRoot?.querySelector<HTMLElement>('[data-testid="studio-canvas-readout"]')?.hidden).toBe(false);
    expect(
      element.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="studio-canvas-mode-map"]')?.disabled,
    ).toBe(true);
  });

  it("never starts a map under happy-dom's WebGL-less canvas when no factory is injected", async () => {
    const element = document.createElement("honua-studio-canvas") as HonuaStudioCanvasElement;
    element.composition = new CompositionController(createEmptyCompositionState());
    document.body.appendChild(element);
    await vi.waitUntil(() => readoutText(element, "studio-canvas-map-status").includes("unavailable"), {
      timeout: MAP_START_TIMEOUT_MS,
      interval: 5,
    });
    expect(readoutText(element, "studio-canvas-map-status")).toContain("WebGL");
  });

  it("rebuilds the map around a catalog that arrives after mount", async () => {
    const { element, controller } = await mountWithMap({ catalog: [] });
    controller.apply({ name: "addLayer", layer: { id: "hi-parcels", sourceId: "hi-parcels" } });
    await element.mapView?.settled();
    expect(element.mapView?.projection?.unresolved).toHaveLength(1);

    element.sourceCatalog = CATALOG;
    await vi.waitUntil(() => element.mapView?.projection?.unresolved.length === 0, {
      timeout: MAP_START_TIMEOUT_MS,
      interval: 5,
    });
    expect(element.mapView?.projection?.renderedLayerIds).toEqual(["hi-parcels"]);
  });
});
