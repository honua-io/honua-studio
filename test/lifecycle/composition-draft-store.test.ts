/**
 * `DraftSync` over the REAL SDK lifecycle client, against the REAL
 * `mock-server.mjs` REST lifecycle store (honua-studio#30).
 *
 * `composition/history.ts` described this adapter in prose for three
 * releases; nothing checked it, because the pinned SDK had no lifecycle
 * client to check it against. This suite is the check: a composition state
 * goes out through `HonuaStudioLifecycleClient.drafts`, lands in a real
 * `map`-family package envelope, comes back byte-identical, and the
 * generation-conflict path the whole `DraftSync` rebase loop hangs on fires
 * off a real `409` from a real server rather than a hand-rolled stub.
 */
import { HonuaClient } from "@honua/sdk-js/honua";
import { createHonuaStudioLifecycleClient } from "@honua/sdk-js/studio";
import { afterEach, describe, expect, it } from "vitest";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { DraftSync, isCompositionDraftConflict } from "../../src/composition/history.js";
import { type CompositionState, createEmptyCompositionState } from "../../src/composition/model.js";
import { applyCompositionCommand } from "../../src/composition/reducer.js";
import {
  COMPOSITION_DRAFT_ENVELOPE,
  createLifecycleCompositionDraftStore,
} from "../../src/lifecycle/composition-draft-store.js";

let server: Awaited<ReturnType<typeof startMockServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function store() {
  const token = mintFixtureAccessToken();
  const lifecycle = createHonuaStudioLifecycleClient({
    client: new HonuaClient({ baseUrl: server?.url ?? "", auth: async () => token }),
    // The mock (like honua-server) serves the lifecycle API under
    // `/v1/studio`; the SDK's default base path carries the `/api` prefix a
    // deployment puts in front of it.
    basePath: "/v1/studio",
  });
  return createLifecycleCompositionDraftStore({ drafts: lifecycle.drafts });
}

function withLayer(state: CompositionState, id: string): CompositionState {
  return applyCompositionCommand(state, { name: "addLayer", layer: { id, sourceId: `src-${id}` } }).state;
}

describe("lifecycle/composition-draft-store — DraftSync over the SDK lifecycle client", () => {
  it("creates a map-family draft on first apply and replaces it, advancing the generation", async () => {
    server = await startMockServer();
    const sync = new DraftSync({ store: store(), packageKey: "sdk-adapter-parcels" });

    const first = await sync.apply(withLayer(createEmptyCompositionState(), "parcels"));
    expect(first.generation).toBe(1);
    expect(first.envelope.body.layers.map((layer) => layer.id)).toEqual(["parcels"]);

    const second = await sync.apply(withLayer(first.envelope.body, "roads"));
    expect(second.draftId).toBe(first.draftId);
    expect(second.generation).toBe(2);
    expect(second.envelope.body.layers.map((layer) => layer.id)).toEqual(["parcels", "roads"]);
  });

  it("round-trips composition state through the package envelope without losing a field", async () => {
    server = await startMockServer();
    const sync = new DraftSync({ store: store(), packageKey: "sdk-adapter-round-trip" });
    let state = withLayer(createEmptyCompositionState(), "parcels");
    state = applyCompositionCommand(state, { name: "setView", view: { zoom: 7, center: [-157.9, 21.4] } }).state;
    state = applyCompositionCommand(state, {
      name: "addWidget",
      widget: { id: "toc", kind: "toc", title: "Layers" },
    }).state;
    state = applyCompositionCommand(state, { name: "pin", target: { kind: "layer", id: "parcels" } }).state;

    const draft = await sync.apply(state);
    expect(draft.envelope.body).toEqual(state);

    // …and reading it back through a *fresh* store sees the same thing, so
    // nothing survived only because it was still in memory.
    const reloaded = await store().get(draft.draftId);
    expect(reloaded.envelope.body).toEqual(state);
    expect(reloaded.packageKey).toBe("sdk-adapter-round-trip");
  });

  it("stores the composition under the map package family the server advertises", async () => {
    server = await startMockServer();
    const sync = new DraftSync({ store: store(), packageKey: "sdk-adapter-family" });
    const draft = await sync.apply(withLayer(createEmptyCompositionState(), "parcels"));

    const token = mintFixtureAccessToken();
    const raw = await fetch(`${server.url}/v1/studio/package-drafts/${draft.draftId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await raw.json()) as { data: { envelope: { family: string; format: string } } };
    expect(body.data.envelope.family).toBe(COMPOSITION_DRAFT_ENVELOPE.family);
    expect(body.data.envelope.format).toBe(COMPOSITION_DRAFT_ENVELOPE.format);
  });

  it("translates the SDK's 409 into the seam's conflict discriminant, and DraftSync recovers", async () => {
    server = await startMockServer();
    const shared = store();
    const conflicts: number[] = [];
    const sync = new DraftSync({
      store: shared,
      packageKey: "sdk-adapter-conflict",
      onConflict: (conflict) => conflicts.push(conflict.serverGeneration),
    });

    const first = await sync.apply(withLayer(createEmptyCompositionState(), "parcels"));

    // A second client writes the same draft, so `DraftSync`'s cached
    // generation goes stale — the exact race the rebase loop exists for.
    await shared.replace(first.draftId, {
      packageKey: "sdk-adapter-conflict",
      envelope: { body: withLayer(first.envelope.body, "someone-elses-layer") },
      generation: first.generation,
    });

    const recovered = await sync.apply(withLayer(first.envelope.body, "roads"));
    expect(conflicts).toEqual([2]);
    expect(recovered.generation).toBe(3);
    expect(recovered.envelope.body.layers.map((layer) => layer.id)).toEqual(["parcels", "roads"]);
  });

  it("surfaces a stale generation as a conflict rather than a bare error", async () => {
    server = await startMockServer();
    const shared = store();
    const created = await shared.create({
      packageKey: "sdk-adapter-stale",
      envelope: { body: createEmptyCompositionState() },
    });
    const error = await shared
      .replace(created.draftId, {
        packageKey: "sdk-adapter-stale",
        envelope: { body: createEmptyCompositionState() },
        generation: created.generation + 5,
      })
      .catch((thrown: unknown) => thrown);
    expect(isCompositionDraftConflict(error)).toBe(true);
  });

  it("refuses a draft whose envelope body is not composition state", async () => {
    server = await startMockServer();
    const token = mintFixtureAccessToken();
    const created = await fetch(`${server.url}/v1/studio/package-drafts`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        packageKey: "sdk-adapter-foreign",
        envelope: { family: "map", schemaVersion: "1.0", body: { somethingElse: true } },
      }),
    });
    const { data } = (await created.json()) as { data: { draftId: string } };

    await expect(store().get(data.draftId)).rejects.toThrow(/composition state version/);
  });
});
