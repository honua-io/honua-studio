import { composeStyle } from "@honua/sdk-js/runtime";
import { expect, it } from "vitest";
import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { CompositionEditor, type CompositionEditorOptions } from "../../src/app/composition-editor.js";
import { StalenessEpoch } from "../../src/app/staleness-epoch.js";
import { CompositionController } from "../../src/composition/controller.js";
import { StudioLifecycleClient } from "../../src/lifecycle/lifecycle-client.js";
import { WorkspaceDraftBinding } from "../../src/lifecycle/workspace-draft.js";
import { compositionToMapPackage } from "../../src/map/map-package-projection.js";
import { applyStudioDraftBody } from "../../src/mcp/tool-bridge.js";

it.each(["vector", "raster"])(
  "saves catalog %s PMTiles through the authorized editor and reopens without a catalog",
  async (sourceType) => {
    const server = await startMockServer();
    try {
      const client = new StudioLifecycleClient({
        baseUrl: server.url,
        auth: { getAccessToken: async () => mintFixtureAccessToken() },
      });
      const draft = await client.createDraft({
        packageKey: "native-map",
        envelope: {
          family: "map",
          schemaVersion: "1.0",
          format: "honua_map_package.v1",
          body: { layers: [] },
        },
      });
      const binding = new WorkspaceDraftBinding(client);
      const composition = new CompositionController(await binding.observe(draft.draftId));
      const url = "https://archives.example/public.pmtiles";
      const editor = new CompositionEditor({
        authority: { epoch: new StalenessEpoch() },
        drafts: {
          binding,
          enqueue: (task: () => Promise<unknown>) => task(),
          announce: () => {},
          markConflict: () => {},
        },
        composition,
        catalog: {
          catalog: [
            {
              id: "native",
              protocol: "pmtiles",
              geometryType: sourceType === "vector" ? "Polygon" : "Raster",
              locator: { url, sourceType },
            },
          ],
        },
        chrome: { paintHistory: () => {}, setHistoryStatus: () => {} },
        orchestrator: () => ({}),
        hasUnsavedStyleChanges: () => false,
      } as unknown as CompositionEditorOptions);
      expect(
        await editor.dispatch([
          {
            name: "addLayer",
            layer: {
              id: "land",
              sourceId: "native",
              metadata: { honua: { sourceLayer: "land" } },
            },
          },
        ]),
      ).toEqual({ ok: true });
      expect(await editor.applyHistory("undo")).toBe(true);
      expect(composition.state.layers).toEqual([]);
      expect(await editor.applyHistory("redo")).toBe(true);
      expect(composition.history.revisions()).toHaveLength(2);
      // This is the actual serialized server response, without injecting render projection fields.
      const saved = await client.getDraft(draft.draftId);
      const reopened = applyStudioDraftBody(JSON.parse(JSON.stringify(saved.envelope.body)));
      expect(reopened.sourceBindings).toEqual([
        { sourceId: "native", protocol: "pmtiles", locator: { url, sourceType } },
      ]);
      const audience = compositionToMapPackage(reopened, { sourceAuthority: "current-reader" });
      expect(audience.unresolved).toEqual([]);
      const style = await composeStyle(audience.mapPackage, audience.mapPackage.mapSpec, {});
      expect(style.sources.native).toMatchObject({ type: sourceType, url: `pmtiles://${url}` });
      expect(style.layers.find((layer) => layer.id === "land")).toMatchObject({
        type: sourceType === "raster" ? "raster" : "fill",
      });
    } finally {
      await server.close();
    }
  },
  20000,
);
