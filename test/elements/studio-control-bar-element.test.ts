// @vitest-environment happy-dom
/**
 * `<honua-studio-control-bar>` — honua-studio#25's acceptance criteria at the
 * element level:
 *
 *  - every upstream kind renders **or** reports explicit unsupported
 *    (REQ-001), with the reason visible in the DOM rather than in a console;
 *  - intrinsic behavior needs no authored interaction (REQ-003) — and where
 *    it mutates the composition it goes through the reducer, not around it;
 *  - a `change` publishes through the interaction runtime (REQ-002).
 *
 * The map is a plain object literal satisfying {@link ControlBarMapBridge} —
 * the same injection discipline `mapFactory` (honua-studio#23) and
 * `dataLoader` (honua-studio#24) established, so every intrinsic affordance
 * is exercised in `environment: "node"`-style isolation without a renderer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompositionController } from "../../src/composition/controller.js";
import { COMPOSITION_CONTROL_KINDS, createEmptyCompositionState } from "../../src/composition/model.js";
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type {
  ControlBarMapBridge,
  HonuaStudioControlBarElement,
} from "../../src/elements/studio-control-bar-element.js";
import type { HonuaStudioControlChangeDetail } from "../../src/elements/types.js";
import { StudioInteractionRuntime } from "../../src/interactions/studio-interactions.js";
import type { WidgetDataLoader } from "../../src/widgets/widget-data.js";

registerAllStudioElements();

const nudge = vi.fn();
const setBasemap = vi.fn();

function mapBridge(overrides: Partial<ControlBarMapBridge> = {}): ControlBarMapBridge {
  return {
    available: true,
    camera: () => ({ zoom: 10, center: [-157.8, 21.3], bearing: 0 }),
    nudge,
    container: () => document.body,
    attributions: () => ["Natural Earth (public domain) · vendored offline"],
    setBasemap,
    ...overrides,
  };
}

function controllerWithParcels(): CompositionController {
  const controller = new CompositionController(createEmptyCompositionState());
  controller.apply({ name: "addLayer", layer: { id: "parcels", sourceId: "src-parcels" } });
  return controller;
}

function mount(
  controller: CompositionController,
  options: { runtime?: StudioInteractionRuntime; map?: ControlBarMapBridge; loader?: WidgetDataLoader } = {},
): HonuaStudioControlBarElement {
  const element = document.createElement("honua-studio-control-bar") as HonuaStudioControlBarElement;
  document.body.appendChild(element);
  if (options.loader) element.dataLoader = options.loader;
  element.map = options.map ?? mapBridge();
  if (options.runtime) element.interactions = options.runtime;
  element.composition = controller;
  return element;
}

function card(element: HonuaStudioControlBarElement, controlId: string): HTMLElement | null {
  return element.shadowRoot?.querySelector<HTMLElement>(`[data-control-id="${controlId}"]`) ?? null;
}

function query<T extends Element>(element: HonuaStudioControlBarElement, selector: string): T | null {
  return element.shadowRoot?.querySelector<T>(selector) ?? null;
}

async function flush(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  document.body.innerHTML = "";
  nudge.mockReset();
  setBasemap.mockReset();
});

describe("<honua-studio-control-bar>", () => {
  it("takes no space at all when the composition declares no controls", () => {
    const element = mount(controllerWithParcels());
    expect(element.dataset.empty).toBe("true");
  });

  it("REQ-001: renders or explicitly reports every kind in the closed vocabulary — nothing is dropped", async () => {
    const controller = controllerWithParcels();
    for (const kind of COMPOSITION_CONTROL_KINDS) {
      controller.apply({ name: "addControl", control: { id: kind, kind } });
    }
    const runtime = new StudioInteractionRuntime({ controller });
    const element = mount(controller, { runtime });
    await flush();

    expect(element.shadowRoot?.querySelectorAll("[data-testid='studio-control']")).toHaveLength(
      COMPOSITION_CONTROL_KINDS.length,
    );
    for (const kind of COMPOSITION_CONTROL_KINDS) {
      const article = card(element, kind);
      expect(article, kind).not.toBeNull();
      // Either it drew a body, or it says why it did not. Never neither.
      const hasBody = article?.querySelector(".control-body") !== null;
      const hasReason = article?.querySelector("[data-testid='studio-control-unsupported']") !== null;
      expect(hasBody || hasReason, `${kind} rendered nothing and said nothing`).toBe(true);
    }
    runtime.dispose();
  });

  it("marks search unsupported and names the upstream gap on the card", () => {
    const controller = controllerWithParcels();
    controller.apply({ name: "addControl", control: { id: "find", kind: "search" } });
    const element = mount(controller);
    expect(card(element, "find")?.dataset.state).toBe("unsupported");
    expect(card(element, "find")?.textContent).toContain("no search provider");
  });

  describe("REQ-003 — intrinsic behavior, with no authored binding", () => {
    it("zooms and resets bearing straight on the camera", () => {
      const controller = controllerWithParcels();
      controller.apply({ name: "addControl", control: { id: "nav", kind: "navigation" } });
      const element = mount(controller);
      const stateBefore = controller.state;
      query<HTMLButtonElement>(element, "[data-testid='studio-control-zoom-in']")?.click();
      query<HTMLButtonElement>(element, "[data-testid='studio-control-zoom-out']")?.click();
      query<HTMLButtonElement>(element, "[data-testid='studio-control-reset-north']")?.click();
      expect(nudge.mock.calls.map(([patch]) => patch)).toEqual([{ zoomBy: 1 }, { zoomBy: -1 }, { bearing: 0 }]);
      // A camera nudge is not a document edit — composition state is untouched
      // (identity, not just equality: no command ran at all).
      expect(controller.state).toBe(stateBefore);
    });

    it("draws a scale bar from the live camera, and reports when the camera cannot be read", () => {
      const controller = controllerWithParcels();
      controller.apply({ name: "addControl", control: { id: "scale", kind: "scale" } });
      const element = mount(controller);
      expect(query(element, "[data-testid='studio-control-scale-label']")?.textContent).toMatch(/(m|km)$/);

      element.map = mapBridge({ camera: () => undefined });
      expect(card(element, "scale")?.textContent).toContain("needs a live map");
    });

    it("travels to a bookmark through the reducer — the same write path an agent's setView takes", () => {
      const controller = controllerWithParcels();
      controller.apply({
        name: "addControl",
        control: {
          id: "places",
          kind: "bookmarks",
          config: { bookmarks: [{ label: "Oʻahu", bbox: [-158.3, 21.2, -157.6, 21.8] }] },
        },
      });
      const element = mount(controller);
      query<HTMLButtonElement>(element, "[data-testid='studio-control-bookmark']")?.click();
      expect(controller.state.view.bbox).toEqual([-158.3, 21.2, -157.6, 21.8]);
      expect(controller.canUndo()).toBe(true);
    });

    it("surfaces a refused intrinsic mutation on the card instead of swallowing it", () => {
      const controller = controllerWithParcels();
      controller.apply({
        name: "addControl",
        control: {
          id: "places",
          kind: "bookmarks",
          config: { bookmarks: [{ label: "Bad", center: [0, 0], zoom: 99 }] },
        },
      });
      const element = mount(controller);
      query<HTMLButtonElement>(element, "[data-testid='studio-control-bookmark']")?.click();
      expect(query(element, "[data-testid='studio-control-error']")?.textContent).toContain("out of bounds");
    });

    it("switches the basemap and announces it in the SDK kit's own change vocabulary", () => {
      const controller = controllerWithParcels();
      controller.apply({ name: "addControl", control: { id: "base", kind: "basemapSwitcher" } });
      const element = mount(controller);
      const details: HonuaStudioControlChangeDetail[] = [];
      element.addEventListener("honua-studio-control-change", (event) => {
        details.push((event as CustomEvent<HonuaStudioControlChangeDetail>).detail);
      });
      const options = element.shadowRoot?.querySelectorAll<HTMLButtonElement>(
        "[data-testid='studio-control-basemap-option']",
      );
      expect(options).toHaveLength(2);
      options?.[1]?.click();
      expect(setBasemap).toHaveBeenCalledWith(expect.objectContaining({ id: "honua-offline-dark", theme: "dark" }));
      expect(details[0]?.value).toEqual({
        value: "honua-offline-dark",
        kind: "vector",
        previousValue: "honua-offline-light",
      });
    });

    it("lists the composed attributions", () => {
      const controller = controllerWithParcels();
      controller.apply({ name: "addControl", control: { id: "credits", kind: "attribution" } });
      const element = mount(controller);
      expect(query(element, "[data-testid='studio-control-attribution']")?.textContent).toContain("Natural Earth");
    });

    it("measures from forwarded map clicks and persists nothing to the composition", () => {
      const controller = controllerWithParcels();
      controller.apply({ name: "addControl", control: { id: "ruler", kind: "measure" } });
      const element = mount(controller);
      const stateBefore = controller.state;
      expect(element.isMeasuring()).toBe(false);

      query<HTMLButtonElement>(element, "[data-testid='studio-control-measure-toggle']")?.click();
      expect(element.isMeasuring()).toBe(true);
      element.appendMeasurePoint({ lng: 0, lat: 0 });
      element.appendMeasurePoint({ lng: 0, lat: 1 });
      expect(query(element, "[data-testid='studio-control-measure-value']")?.textContent).toContain("km");

      query<HTMLButtonElement>(element, "[data-testid='studio-control-measure-clear']")?.click();
      expect(query(element, "[data-testid='studio-control-measure-value']")?.textContent).toBe("—");
      // ADR-0031 admits measure precisely because it is transient: it computes
      // on the client and persists nothing.
      expect(controller.state.annotations).toEqual([]);
      expect(controller.state).toBe(stateBefore);
    });
  });

  describe("REQ-002 — change publishes through the interaction runtime", () => {
    it("publishes a filterSelect pick, and the bound layer's filter follows", async () => {
      const controller = controllerWithParcels();
      controller.apply({
        name: "addControl",
        control: {
          id: "zoning",
          kind: "filterSelect",
          sourceId: "src-parcels",
          config: { field: "zoning_code", options: ["R-5", "B-2"] },
        },
      });
      const runtime = new StudioInteractionRuntime({ controller });
      const element = mount(controller, { runtime });
      const details: HonuaStudioControlChangeDetail[] = [];
      element.addEventListener("honua-studio-control-change", (event) => {
        details.push((event as CustomEvent<HonuaStudioControlChangeDetail>).detail);
      });

      const select = query<HTMLSelectElement>(element, "[data-testid='studio-control-filter-select']");
      expect(select?.options).toHaveLength(3); // "All" + two values
      if (select) {
        select.value = "R-5";
        select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      }
      await flush();

      expect(runtime.clauseFor("zoning")).toEqual({ field: "zoning_code", operator: "=", value: "R-5" });
      expect(runtime.appearance.filters.parcels).toEqual(["==", ["get", "zoning_code"], "R-5"]);
      // The DOM event is a notification carrying the gesture's source tag.
      expect(details[0]).toEqual({ controlId: "zoning", kind: "filterSelect", source: "adapter", value: "R-5" });
      runtime.dispose();
    });

    it("clears the filter when the All option is picked", async () => {
      const controller = controllerWithParcels();
      controller.apply({
        name: "addControl",
        control: {
          id: "zoning",
          kind: "filterSelect",
          sourceId: "src-parcels",
          config: { field: "zoning_code", options: ["R-5"] },
        },
      });
      const runtime = new StudioInteractionRuntime({ controller });
      const element = mount(controller, { runtime });
      const select = query<HTMLSelectElement>(element, "[data-testid='studio-control-filter-select']");
      if (select) {
        select.value = "R-5";
        select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        select.value = "";
        select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      }
      await flush();
      expect(runtime.clauseFor("zoning")).toBeUndefined();
      expect(runtime.appearance.filters.parcels).toBeUndefined();
      runtime.dispose();
    });

    it("derives a select's domain from the bound source when the agent authored no options", async () => {
      const controller = controllerWithParcels();
      controller.apply({
        name: "addControl",
        control: { id: "zoning", kind: "filterSelect", sourceId: "src-parcels", config: { field: "zoning_code" } },
      });
      const loader: WidgetDataLoader = vi.fn(async () => ({
        ok: true as const,
        truncated: false,
        rows: [
          { featureId: 1, properties: { zoning_code: "R-5" } },
          { featureId: 2, properties: { zoning_code: "B-2" } },
          { featureId: 3, properties: { zoning_code: "R-5" } },
        ],
      }));
      const runtime = new StudioInteractionRuntime({ controller });
      const element = mount(controller, { runtime, loader });
      await flush();

      const options = [
        ...(query<HTMLSelectElement>(element, "[data-testid='studio-control-filter-select']")?.options ?? []),
      ];
      expect(options.map((option) => option.value)).toEqual(["", "B-2", "R-5"]);
      expect(loader).toHaveBeenCalledTimes(1);
      runtime.dispose();
    });

    it("publishes an opacity value that becomes paint, never a filter", async () => {
      const controller = controllerWithParcels();
      controller.apply({ name: "addControl", control: { id: "fade", kind: "opacity", sourceId: "parcels" } });
      const runtime = new StudioInteractionRuntime({ controller });
      const element = mount(controller, { runtime });
      const slider = query<HTMLInputElement>(element, "[data-testid='studio-control-opacity']");
      if (slider) {
        slider.value = "0.4";
        slider.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      }
      await flush();
      expect(runtime.appearance.opacity).toEqual({ parcels: 0.4 });
      expect(runtime.appearance.filters).toEqual({});
      runtime.dispose();
    });

    it("reports a change-emitting control that has no runtime to publish to", () => {
      const controller = controllerWithParcels();
      controller.apply({
        name: "addControl",
        control: {
          id: "zoning",
          kind: "filterSelect",
          sourceId: "src-parcels",
          config: { field: "z", options: ["A"] },
        },
      });
      const element = mount(controller);
      expect(card(element, "zoning")?.textContent).toContain("no interaction runtime");
    });

    it("notes an unbound change-emitting control rather than leaving the user to discover it", () => {
      const controller = controllerWithParcels();
      controller.apply({
        name: "addControl",
        control: {
          id: "zoning",
          kind: "filterSelect",
          sourceId: "src-parcels",
          config: { field: "z", options: ["A"] },
        },
      });
      const runtime = new StudioInteractionRuntime({ controller });
      const element = mount(controller, { runtime });
      expect(query(element, "[data-testid='studio-control-note']")?.textContent).toContain("no interaction binds it");
      runtime.dispose();
    });
  });

  it("cleans up its subscription on disconnect (the leak probe every Studio element carries)", () => {
    const controller = controllerWithParcels();
    controller.apply({ name: "addControl", control: { id: "nav", kind: "navigation" } });
    const element = mount(controller);
    const probe = element.constructor as unknown as { instanceCount: number };
    const before = probe.instanceCount;
    element.remove();
    expect(probe.instanceCount).toBe(before - 1);
  });
});
