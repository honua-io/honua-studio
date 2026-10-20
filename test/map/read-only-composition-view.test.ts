// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { HonuaStudioWidgetDeckElement } from "../../src/elements/studio-widget-deck-element.js";
import type { CompositionMapFactoryOptions, CompositionMapLike } from "../../src/map/composition-map-view.js";
import { createReadOnlyCompositionView } from "../../src/map/read-only-composition-view.js";

const origin = "https://console.test";
const sourceRoot = `${origin}/api/studio/viewer/data`;
const catalog = [
  {
    id: "service/1",
    title: "Parcels",
    protocol: "geoservices-feature-service",
    geometryType: "Polygon",
    locator: { serviceId: "service", layerId: 1, url: `${sourceRoot}/rest/services/parcels/FeatureServer` },
  },
];

function body(widgets: readonly Record<string, unknown>[] = [{ id: "layers", kind: "toc" }]) {
  return {
    layers: [{ id: "parcels", sourceId: "service/1", type: "fill", visible: true, title: "Parcels" }],
    widgets,
    view: { center: [-157.85, 21.3], zoom: 10 },
  };
}

function mapHarness() {
  const constructed: CompositionMapFactoryOptions[] = [];
  const maps: CompositionMapLike[] = [];
  const removed: ReturnType<typeof vi.fn>[] = [];
  const factory = vi.fn(async (options: CompositionMapFactoryOptions): Promise<CompositionMapLike> => {
    constructed.push(options);
    const remove = vi.fn();
    removed.push(remove);
    const map: CompositionMapLike = {
      setStyle: vi.fn(),
      jumpTo: vi.fn(),
      easeTo: vi.fn(),
      fitBounds: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      resize: vi.fn(),
      remove,
      queryRenderedFeatures: vi.fn(() => []),
    };
    maps.push(map);
    return map;
  });
  return { constructed, factory, maps, removed };
}

function hosts() {
  const map = document.createElement("div");
  const widgets = document.createElement("div");
  document.body.append(map, widgets);
  return { map, widgets };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(predicate()).toBe(true);
}

function deck(container: HTMLElement) {
  return container.querySelector("honua-studio-widget-deck");
}

describe("read-only published composition view", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("mounts only the widget deck and lets a local TOC toggle update the same map without editing the body", async () => {
    const host = hosts();
    const map = mapHarness();
    const original = body();
    const durable = structuredClone(original);
    const network = vi.spyOn(globalThis, "fetch");
    const view = createReadOnlyCompositionView({
      container: host.map,
      widgetContainer: host.widgets,
      body: original,
      projection: { catalog, baseUrl: sourceRoot },
      sourceAuthBaseUrl: sourceRoot,
      documentUrl: `${origin}/maps/published/map/map-1`,
      mapFactory: map.factory,
      getAudienceTransport: () => undefined,
    });
    await view.settled();
    expect(view.status).toBe("ready");
    const mapAuth = map.constructed[0]?.getAuth?.();
    expect(mapAuth).toBeDefined();
    expect(await mapAuth?.getAccessToken()).toBeUndefined();
    await expect(mapAuth?.fetchRequest?.(`${sourceRoot}/rest/services/parcels/FeatureServer/1/query`)).rejects.toThrow(
      "Current-reader map transport is unavailable",
    );
    expect(deck(host.widgets)?.shadowRoot?.querySelectorAll('[data-testid="studio-widget-toc-row"]')).toHaveLength(1);
    expect(customElements.get("honua-studio-app")).toBeUndefined();

    const toggle = deck(host.widgets)?.shadowRoot?.querySelector<HTMLInputElement>(
      '[data-testid="studio-widget-toc-toggle"]',
    );
    expect(toggle?.checked).toBe(true);
    toggle!.checked = false;
    toggle!.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await view.settled();
    expect(
      deck(host.widgets)?.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="studio-widget-toc-toggle"]')
        ?.checked,
    ).toBe(false);
    expect(view.projection?.mapPackage.mapSpec.layers.find((layer) => layer.id === "parcels")?.layout?.visibility).toBe(
      "none",
    );
    expect(map.maps[0]?.setStyle).toHaveBeenCalled();
    expect(original).toEqual(durable);
    expect(network).not.toHaveBeenCalled();
    view.dispose();
    expect(map.removed[0]).toHaveBeenCalledTimes(1);
    expect(deck(host.widgets)).toBeNull();
    network.mockRestore();
  });

  it("reads table rows only through the exact current-reader catalog URL and host transport", async () => {
    const host = hosts();
    const map = mapHarness();
    const fetchRequest = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        `${sourceRoot}/rest/services/parcels/FeatureServer/1/query?where=1%3D1&outFields=*&f=geojson&resultRecordCount=500`,
      );
      expect(init?.method).toBe("GET");
      expect(init?.headers).toEqual({ Accept: "application/geo+json, application/json" });
      return new Response(
        JSON.stringify({
          type: "FeatureCollection",
          features: [{ type: "Feature", id: 7, properties: { name: "Parcel Seven" }, geometry: null }],
        }),
        { headers: { "content-type": "application/geo+json" } },
      );
    });
    const transport = { fetchRequest };
    const view = createReadOnlyCompositionView({
      container: host.map,
      widgetContainer: host.widgets,
      body: body([{ id: "grid", kind: "table", sourceId: "service/1" }]),
      projection: { catalog, baseUrl: sourceRoot },
      sourceAuthBaseUrl: sourceRoot,
      documentUrl: `${origin}/maps/published/map/map-1`,
      getAudienceTransport: () => transport,
      mapFactory: map.factory,
    });
    await view.settled();
    await until(() => !!deck(host.widgets)?.shadowRoot?.querySelector('[data-testid="studio-widget-grid-row"]'));
    expect(deck(host.widgets)?.shadowRoot?.textContent).toContain("Parcel Seven");
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    expect(fetchRequest.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization");
    view.dispose();
  });

  it("shows denied widget metadata and makes zero data or auth calls", async () => {
    const host = hosts();
    const map = mapHarness();
    const fetchRequest = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      throw new Error("Denied widget attempted a read.");
    });
    const getAudienceTransport = vi.fn(() => ({ fetchRequest }));
    const view = createReadOnlyCompositionView({
      container: host.map,
      widgetContainer: host.widgets,
      body: body([{ id: "denied", kind: "table", sourceId: "private/9" }]),
      projection: { catalog, baseUrl: sourceRoot },
      sourceAuthBaseUrl: sourceRoot,
      documentUrl: `${origin}/maps/published/map/map-1`,
      getAudienceTransport,
      mapFactory: map.factory,
    });
    await view.settled();
    await until(() =>
      (deck(host.widgets)?.shadowRoot?.textContent ?? "").includes("not in the current-reader catalog"),
    );
    expect(fetchRequest).not.toHaveBeenCalled();
    expect(getAudienceTransport).not.toHaveBeenCalled();
    view.dispose();
  });

  it("cleans a detached widget deck when map style preflight fails, then reloads without stale work", async () => {
    const host = hosts();
    const map = mapHarness();
    const fetchRequest = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      throw new Error("Preflight failure attempted a read.");
    });
    const getAudienceTransport = vi.fn(() => ({ fetchRequest }));
    const createElement = vi.spyOn(document, "createElement");
    const original = {
      ...body([{ id: "grid", kind: "table", sourceId: "service/1" }]),
      layers: [
        {
          id: "parcels",
          sourceId: "service/1",
          type: "fill",
          visible: true,
          title: "Parcels",
          styleRef: "unreadable",
        },
      ],
    };
    const durable = structuredClone(original);
    const before = HonuaStudioWidgetDeckElement.instanceCount;
    const view = createReadOnlyCompositionView({
      container: host.map,
      widgetContainer: host.widgets,
      body: original,
      projection: { catalog, baseUrl: sourceRoot },
      sourceAuthBaseUrl: sourceRoot,
      documentUrl: `${origin}/maps/published/map/map-1`,
      getAudienceTransport,
      mapFactory: map.factory,
    });
    await expect(view.settled()).rejects.toThrow("authoritative style reader");
    const created = createElement.mock.results.find((result) => result.value instanceof HonuaStudioWidgetDeckElement)
      ?.value as HonuaStudioWidgetDeckElement | undefined;
    expect(created).toBeInstanceOf(HonuaStudioWidgetDeckElement);
    expect(created?.isConnected).toBe(false);
    expect(created?.composition).toBeUndefined();
    expect(created?.dataLoader).toBeUndefined();
    expect(HonuaStudioWidgetDeckElement.instanceCount).toBe(before);
    expect(deck(host.widgets)).toBeNull();
    expect(map.factory).not.toHaveBeenCalled();
    expect(getAudienceTransport).not.toHaveBeenCalled();
    expect(fetchRequest).not.toHaveBeenCalled();
    expect(original).toEqual(durable);
    expect(view.status).toBe("unavailable");

    await view.reload({ body: body(), projection: { catalog, baseUrl: sourceRoot } });
    await view.settled();
    expect(view.status).toBe("ready");
    expect(deck(host.widgets)).toBeTruthy();
    view.dispose();
    createElement.mockRestore();
  });

  it("aborts an old widget read on reload and discards its late answer", async () => {
    const host = hosts();
    const map = mapHarness();
    let finish!: (response: Response) => void;
    let oldSignal: AbortSignal | undefined;
    const fetchRequest = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      oldSignal = init?.signal ?? undefined;
      return await new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    const transport = { fetchRequest };
    const view = createReadOnlyCompositionView({
      container: host.map,
      widgetContainer: host.widgets,
      body: body([{ id: "grid", kind: "table", sourceId: "service/1" }]),
      projection: { catalog, baseUrl: sourceRoot },
      sourceAuthBaseUrl: sourceRoot,
      documentUrl: `${origin}/maps/published/map/map-1`,
      getAudienceTransport: () => transport,
      mapFactory: map.factory,
    });
    await view.settled();
    await until(() => fetchRequest.mock.calls.length === 1);
    await view.reload({ body: body([{ id: "layers", kind: "toc" }]), projection: { catalog, baseUrl: sourceRoot } });
    expect(oldSignal?.aborted).toBe(true);
    finish(
      new Response(
        JSON.stringify({
          type: "FeatureCollection",
          features: [{ type: "Feature", id: 1, properties: { name: "Stale" } }],
        }),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deck(host.widgets)?.shadowRoot?.textContent).not.toContain("Stale");
    expect(deck(host.widgets)?.shadowRoot?.querySelector('[data-testid="studio-widget-toc-row"]')).toBeTruthy();
    expect(map.removed[0]).toHaveBeenCalledTimes(1);
    view.dispose();
    expect(map.removed[1]).toHaveBeenCalledTimes(1);
  });

  it("rejects a late widget answer when the reader transport epoch changes", async () => {
    const host = hosts();
    const map = mapHarness();
    let finish!: (response: Response) => void;
    const oldFetch = vi.fn(
      async () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const newFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            type: "FeatureCollection",
            features: [{ type: "Feature", id: 2, properties: { name: "Current" }, geometry: null }],
          }),
          { headers: { "content-type": "application/geo+json" } },
        ),
    );
    const oldTransport = { fetchRequest: oldFetch };
    const newTransport = { fetchRequest: newFetch };
    let active = oldTransport;
    const original = body([{ id: "grid", kind: "table", sourceId: "service/1" }]);
    const view = createReadOnlyCompositionView({
      container: host.map,
      widgetContainer: host.widgets,
      body: original,
      projection: { catalog, baseUrl: sourceRoot },
      sourceAuthBaseUrl: sourceRoot,
      documentUrl: `${origin}/maps/published/map/map-1`,
      getAudienceTransport: () => active,
      mapFactory: map.factory,
    });
    await view.settled();
    await until(() => oldFetch.mock.calls.length === 1);
    const oldMapAuth = map.constructed[0]?.getAuth?.();
    active = newTransport;
    expect(map.constructed[0]?.getAuth?.()).not.toBe(oldMapAuth);
    finish(
      new Response(
        JSON.stringify({
          type: "FeatureCollection",
          features: [{ type: "Feature", id: 1, properties: { name: "Stale" }, geometry: null }],
        }),
      ),
    );
    await until(() => (deck(host.widgets)?.shadowRoot?.textContent ?? "").includes("viewer authority changed"));
    expect(deck(host.widgets)?.shadowRoot?.textContent).not.toContain("Stale");

    await view.reload({ body: original, projection: { catalog, baseUrl: sourceRoot } });
    await until(() => (deck(host.widgets)?.shadowRoot?.textContent ?? "").includes("Current"));
    expect(newFetch).toHaveBeenCalledTimes(1);
    expect(deck(host.widgets)?.shadowRoot?.textContent).not.toContain("Stale");
    view.dispose();
  });

  it("removes a map whose factory finishes after disposal", async () => {
    const host = hosts();
    let finish!: (map: CompositionMapLike) => void;
    const remove = vi.fn();
    const factory = vi.fn(
      () =>
        new Promise<CompositionMapLike>((resolve) => {
          finish = resolve;
        }),
    );
    const view = createReadOnlyCompositionView({
      container: host.map,
      widgetContainer: host.widgets,
      body: body(),
      projection: { catalog, baseUrl: sourceRoot },
      sourceAuthBaseUrl: sourceRoot,
      documentUrl: `${origin}/maps/published/map/map-1`,
      mapFactory: factory,
      getAudienceTransport: () => undefined,
    });
    await until(() => factory.mock.calls.length === 1);
    view.dispose();
    finish({
      setStyle: vi.fn(),
      jumpTo: vi.fn(),
      easeTo: vi.fn(),
      fitBounds: vi.fn(),
      on: vi.fn(),
      resize: vi.fn(),
      remove,
    });
    await view.settled();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(deck(host.widgets)).toBeNull();
  });
});
