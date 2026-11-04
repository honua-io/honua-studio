// @vitest-environment happy-dom
/**
 * `addPublishedLayer` discovers a catalog asynchronously. A map or session replacement queued right after
 * that discovery resolves must never receive the predecessor's catalog or layer.
 */
import { describe, expect, it, vi } from "vitest";

import { CompositionEditor, type CompositionEditorOptions } from "../../src/app/composition-editor.js";
import { StalenessEpoch } from "../../src/app/staleness-epoch.js";
import type { CatalogDataset } from "../../src/client/studio-client.js";
import { CompositionController } from "../../src/composition/controller.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioAppElement } from "../../src/elements/studio-app-element.js";

const ROADS: CatalogDataset[] = [
  { id: "roads", locator: { layerId: 0, url: "/rest/services/roads/FeatureServer" } } as unknown as CatalogDataset,
];
const PUBLISHED_ROADS = { layerId: 0, serviceName: "roads" };

function deferredCatalog() {
  let resolve!: (catalog: readonly CatalogDataset[]) => void;
  const read = new Promise<readonly CatalogDataset[]>((done) => {
    resolve = done;
  });
  return { read, resolve };
}

function fixtureSession(token: string) {
  return { getToken: async () => token, onExpired: () => () => {} };
}

describe("published-layer discovery across a replacement", () => {
  it("never writes the discovered layer into a map that replaced the original one", async () => {
    const discovery = deferredCatalog();
    const originalWrite = vi.fn(async (state: unknown) => state);
    const replacementWrite = vi.fn(async (state: unknown) => state);
    const drafts = {
      activeMap: new StalenessEpoch(),
      binding: { replace: originalWrite } as unknown,
      enqueue: <T>(task: () => Promise<T>) => Promise.resolve().then(task),
      announce: vi.fn(),
      markConflict: vi.fn(),
    };
    const editor = new CompositionEditor({
      authority: {
        auth: {},
        epoch: new StalenessEpoch(),
        lease: new StalenessEpoch(),
        studioClient: { listCatalog: () => discovery.read },
      },
      drafts,
      composition: new CompositionController(createEmptyCompositionState()),
      catalog: { apply: vi.fn() },
      hasUnsavedStyleChanges: () => false,
    } as unknown as CompositionEditorOptions);

    const outcome = editor.addPublishedLayer(PUBLISHED_ROADS);
    discovery.resolve(ROADS);
    queueMicrotask(() => {
      drafts.activeMap.next();
      drafts.binding = { replace: replacementWrite };
    });

    expect(await outcome).toEqual({ ok: false, reason: "The active map changed before the edit began." });
    expect(replacementWrite).not.toHaveBeenCalled();
    expect(originalWrite).not.toHaveBeenCalled();
  });

  it("leaves a replacement session's composition and catalog untouched", async () => {
    registerAllStudioElements();
    const app = document.createElement("honua-studio-app") as HonuaStudioAppElement;
    app.session = fixtureSession("fixture-a");
    const discovery = deferredCatalog();
    app.studioClient = { listCatalog: () => discovery.read } as unknown as HonuaStudioAppElement["studioClient"];

    const outcome = app.addPublishedLayer(PUBLISHED_ROADS);
    discovery.resolve(ROADS);
    queueMicrotask(() => {
      app.session = fixtureSession("fixture-b");
    });
    await outcome;

    expect(app.composition.state.layers).toEqual([]);
    expect(app.sourceCatalog).toBeUndefined();
  });
});
