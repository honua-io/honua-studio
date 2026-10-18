import { afterEach, expect, it } from "vitest";
import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import { StudioLifecycleClient } from "../../src/lifecycle/lifecycle-client.js";
import { WorkspaceDraftBinding } from "../../src/lifecycle/workspace-draft.js";

let server: Awaited<ReturnType<typeof startMockServer>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

it("observes actual native draft, preserves metadata and rejects stale human writes without retry", async () => {
  server = await startMockServer();
  const client = new StudioLifecycleClient({
    baseUrl: server.url,
    auth: { getAccessToken: async () => mintFixtureAccessToken() },
  });
  const draft = await client.createDraft({
    packageKey: "shared-map",
    envelope: {
      family: "map",
      schemaVersion: "1.0",
      format: "honua_map_package.v1",
      body: { layers: [], retained: { native: true } },
    },
  });
  const human = new WorkspaceDraftBinding(client);
  expect((await human.observe(draft.draftId)).layers).toEqual([]);
  await human.replace({ ...createEmptyCompositionState(), view: { center: [12, 34], zoom: 5 } });
  const saved = await client.getDraft(draft.draftId);
  expect((saved.envelope.body as Record<string, unknown>).retained).toEqual({ native: true });
  expect(human.identity).toEqual({
    draftId: draft.draftId,
    generation: saved.generation,
    packageKey: saved.packageKey,
  });
  await client.replaceDraft(draft.draftId, {
    packageKey: saved.packageKey,
    generation: saved.generation,
    envelope: { ...saved.envelope, body: { ...(saved.envelope.body as Record<string, unknown>), nativeChange: true } },
  });
  await expect(human.replace(createEmptyCompositionState())).rejects.toThrow();
  expect(((await client.getDraft(draft.draftId)).envelope.body as Record<string, unknown>).nativeChange).toBe(true);
  await human.observe(draft.draftId);
  await human.replace(createEmptyCompositionState());
  expect(((await client.getDraft(draft.draftId)).envelope.body as Record<string, unknown>).nativeChange).toBe(true);
}, 20000);
