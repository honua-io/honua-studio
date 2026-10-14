// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => {
  const listeners = new Map<string, () => void>();
  return {
    listeners,
    namespace: {
      setWorkerUrl: vi.fn(),
      addProtocol: vi.fn(),
      removeProtocol: vi.fn(),
      Map: class {
        on(type: string, listener: () => void) {
          listeners.set(type, listener);
        }
        remove() {
          listeners.get("remove")?.();
        }
      },
    },
  };
});
// Deliberately no named runtime exports: the supported default namespace must own both Map and protocol hooks.
vi.mock("maplibre-gl", () => ({ default: runtime.namespace }));
vi.mock("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url", () => ({ default: "/test-worker.js" }));

import { defaultCompositionMapFactory } from "../../src/map/composition-map-view.js";

it("uses the default-only MapLibre namespace for authenticated source registration and removal", async () => {
  const map = await defaultCompositionMapFactory({
    container: document.createElement("div"),
    style: { version: 8, sources: {}, layers: [] },
    center: [0, 0],
    zoom: 1,
    attributionText: "Test",
    getAuth: () => undefined,
    sourceBaseUrl: "/api",
  });
  expect(runtime.namespace.setWorkerUrl).toHaveBeenCalledWith("/test-worker.js");
  expect(runtime.namespace.addProtocol).toHaveBeenCalledTimes(1);
  expect(runtime.namespace.addProtocol.mock.calls[0]?.[1]).toBeTypeOf("function");
  map.remove();
  expect(runtime.namespace.removeProtocol).toHaveBeenCalledWith(runtime.namespace.addProtocol.mock.calls[0]?.[0]);
});
