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
import { CompositionController } from "../../src/composition/controller.js";
import { DraftSync, isCompositionDraftConflict } from "../../src/composition/history.js";
import { type CompositionState, createEmptyCompositionState } from "../../src/composition/model.js";
import { applyCompositionCommand } from "../../src/composition/reducer.js";
import {
  COMPOSITION_DRAFT_ENVELOPE,
  type CompositionDraftEnvelopeMetadata,
  createLifecycleCompositionDraftStore,
} from "../../src/lifecycle/composition-draft-store.js";
import { McpClient } from "../../src/mcp/client.js";
import { ToolCallOrchestrator } from "../../src/mcp/orchestrator.js";

let server: Awaited<ReturnType<typeof startMockServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function store(fetchFn?: typeof fetch, envelope?: CompositionDraftEnvelopeMetadata) {
  const token = mintFixtureAccessToken();
  const lifecycle = createHonuaStudioLifecycleClient({
    client: new HonuaClient({ baseUrl: server?.url ?? "", auth: async () => token, fetchFn }),
    // The mock (like honua-server) serves the lifecycle API under
    // `/v1/studio`; the SDK's default base path carries the `/api` prefix a
    // deployment puts in front of it.
    basePath: "/v1/studio",
  });
  return createLifecycleCompositionDraftStore({ drafts: lifecycle.drafts, envelope });
}

/** The raw stored envelope, straight off the REST surface — the mock never validates a map body, so only the literal shape is evidence. */
async function storedEnvelope(draftId: string): Promise<Record<string, unknown> & { body: Record<string, unknown> }> {
  const response = await fetch(`${server?.url}/v1/studio/package-drafts/${draftId}`, {
    headers: { authorization: `Bearer ${mintFixtureAccessToken()}` },
  });
  const { data } = (await response.json()) as {
    data: { envelope: Record<string, unknown> & { body: Record<string, unknown> } };
  };
  return data.envelope;
}

/** Seeds a draft with an arbitrary body, bypassing this adapter — how another client's draft gets into the store. */
async function seedDraft(packageKey: string, body: unknown): Promise<string> {
  const response = await fetch(`${server?.url}/v1/studio/package-drafts`, {
    method: "POST",
    headers: { authorization: `Bearer ${mintFixtureAccessToken()}`, "content-type": "application/json" },
    body: JSON.stringify({
      packageKey,
      envelope: { family: "map", schemaVersion: "1.0", format: "honua_map_package.v1", body },
    }),
  });
  const { data } = (await response.json()) as { data: { draftId: string } };
  return data.draftId;
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

  it("round-trips everything the durable envelope carries, and drops only pins/annotations", async () => {
    server = await startMockServer();
    const sync = new DraftSync({ store: store(), packageKey: "sdk-adapter-round-trip" });
    let state = withLayer(createEmptyCompositionState(), "parcels");
    state = applyCompositionCommand(state, { name: "setView", view: { zoom: 7, center: [-157.9, 21.4] } }).state;
    state = applyCompositionCommand(state, {
      name: "addWidget",
      widget: { id: "toc", kind: "toc", title: "Layers" },
    }).state;
    state = applyCompositionCommand(state, {
      name: "addControl",
      control: { id: "zoning", kind: "filterSelect", sourceId: "src-parcels", config: { field: "zoning_code" } },
    }).state;
    state = applyCompositionCommand(state, { name: "pin", target: { kind: "layer", id: "parcels" } }).state;

    const draft = await sync.apply(state);

    // Layers, view, widgets and controls survive verbatim…
    expect(draft.envelope.body.layers).toEqual(state.layers);
    expect(draft.envelope.body.view).toEqual(state.view);
    expect(draft.envelope.body.widgets).toEqual(state.widgets);
    expect(draft.envelope.body.controls).toEqual(state.controls);
    // …and pins do not, deliberately: honua-studio#30 excludes app-only
    // annotations and pins from the durable envelope, and
    // `StudioCompositionBodyEditor` models neither server-side.
    expect(state.pins).toHaveLength(1);
    expect(draft.envelope.body.pins).toEqual([]);
    expect(draft.envelope.body.annotations).toEqual([]);

    // Reading through a *fresh* store sees the same thing, so nothing
    // survived only because it was still in memory.
    const reloaded = await store().get(draft.draftId);
    expect(reloaded.envelope.body.layers).toEqual(state.layers);
    expect(reloaded.envelope.body.widgets).toEqual(state.widgets);
    expect(reloaded.packageKey).toBe("sdk-adapter-round-trip");
  });

  it("writes canonical map metadata alongside lossless composition blocks", async () => {
    server = await startMockServer();
    const sync = new DraftSync({ store: store(), packageKey: "sdk-adapter-shape" });
    let state = withLayer(createEmptyCompositionState(), "parcels");
    state = applyCompositionCommand(state, { name: "setView", view: { zoom: 7 } }).state;
    const draft = await sync.apply(state);
    const stored = await storedEnvelope(draft.draftId);
    expect(stored).toMatchObject({
      family: "map",
      schemaVersion: "1.0",
      format: "honua_map_package.v1",
      body: {
        mapPackageId: "sdk-adapter-shape",
        format: "honua_map_package.v1",
        layers: [{ id: "parcels", sourceId: "src-parcels", visible: true }],
        view: { zoom: 7 },
        widgets: [],
      },
    });
    for (const key of ["status", "initialView", "mapSpec", "sourceBindings"])
      expect(stored.body).not.toHaveProperty(key);
    expect(stored.schemaVersion).toBe(COMPOSITION_DRAFT_ENVELOPE.schemaVersion);
  });

  it.each([undefined, "deployment-map-format"])(
    "resolves deployment format %s consistently in envelope and map body",
    async (format) => {
      server = await startMockServer();
      const custom = store(undefined, {
        family: "map",
        schemaVersion: "deployment-version",
        ...(format === undefined ? {} : { format }),
      });
      const created = await custom.create({
        packageKey: "custom-format",
        envelope: { body: createEmptyCompositionState() },
      });
      const initial = await storedEnvelope(created.draftId);
      expect(initial).toMatchObject({
        schemaVersion: "deployment-version",
        format: format ?? "honua_map_package.v1",
        body: { mapPackageId: "custom-format", format: format ?? "honua_map_package.v1" },
      });
      await store().replace(created.draftId, {
        packageKey: created.packageKey,
        generation: created.generation,
        envelope: { body: withLayer(createEmptyCompositionState(), "parcels") },
      });
      const replaced = await storedEnvelope(created.draftId);
      expect(replaced.schemaVersion).toBe(initial.schemaVersion);
      expect(replaced.format).toBe(initial.format);
      expect(replaced.body.format).toBe(initial.body.format);
    },
  );

  it("preserves authoritative identity and foreign metadata while removing optional composition blocks", async () => {
    server = await startMockServer();
    const draftId = await seedDraft("foreign-map-key", {
      mapPackageId: "stable-other-client-identity",
      format: "honua_map_package.v1",
      layers: [],
      view: {},
      widgets: [],
      controls: [{ id: "old", kind: "scale" }],
      interactions: [{ id: "old-binding", on: { ref: "map", event: "click" }, do: { ref: "map", verb: "setView" } }],
      sourceBindings: [{ sourceId: "trusted-source", protocol: "ogc_features", locator: { collectionId: "parcels" } }],
      customMetadata: { revision: "from-other-client" },
    });
    const fresh = store();
    const current = await fresh.get(draftId);
    await fresh.replace(draftId, {
      packageKey: "renamed-package-key",
      generation: current.generation,
      envelope: { body: withLayer(createEmptyCompositionState(), "parcels") },
    });
    const actual = await storedEnvelope(draftId);
    expect(actual.body).toMatchObject({
      mapPackageId: "stable-other-client-identity",
      format: "honua_map_package.v1",
      customMetadata: { revision: "from-other-client" },
      sourceBindings: [{ sourceId: "trusted-source", protocol: "ogc_features", locator: { collectionId: "parcels" } }],
      layers: [{ id: "parcels" }],
    });
    expect(actual.body).not.toHaveProperty("controls");
    expect(actual.body).not.toHaveProperty("interactions");
  });

  it("produces the same envelope the MCP composition path produces for the same draft", async () => {
    server = await startMockServer();
    const token = mintFixtureAccessToken();
    const state = withLayer(createEmptyCompositionState(), "parcels");

    // Path A: DraftSync through this adapter.
    const viaAdapter = await new DraftSync({ store: store(), packageKey: "pkg-adapter" }).apply(state);
    // Path B: the orchestrator's own lazy draft creation, seeded from the
    // identical state. Two writers, one draft shape — AD-8 coherence.
    const orchestrator = new ToolCallOrchestrator({
      controller: new CompositionController(state),
      live: {
        client: new McpClient({ baseUrl: server.url, auth: { getAccessToken: async () => token } }),
        packageKey: "pkg-orchestrator",
        family: "map",
      },
    });
    await orchestrator.handleToolCall({ toolName: "setView", arguments: { view: { zoom: 4 } } });

    const adapterEnvelope = await storedEnvelope(viaAdapter.draftId);
    const orchestratorEnvelope = await storedEnvelope(orchestrator.draftId as string);

    expect(Object.keys(adapterEnvelope).sort()).toEqual(Object.keys(orchestratorEnvelope).sort());
    expect(orchestratorEnvelope.body).toMatchObject({
      mapPackageId: "pkg-orchestrator",
      format: "honua_map_package.v1",
    });
    expect(orchestratorEnvelope.schemaVersion).toBe("1.0");
    expect(adapterEnvelope.family).toBe(orchestratorEnvelope.family);
    expect(adapterEnvelope.schemaVersion).toBe(orchestratorEnvelope.schemaVersion);
    expect(Object.keys(adapterEnvelope.body).sort()).toEqual(Object.keys(orchestratorEnvelope.body).sort());
  });

  it("preserves non-map schema defaults and explicit overrides without map metadata", async () => {
    server = await startMockServer();
    const client = new McpClient({
      baseUrl: server.url,
      auth: { getAccessToken: async () => mintFixtureAccessToken() },
    });
    for (const schemaVersion of [undefined, "deployment-version"]) {
      const orchestrator = new ToolCallOrchestrator({
        controller: new CompositionController(createEmptyCompositionState()),
        live: { client, packageKey: "dashboard-composition", family: "dashboard", schemaVersion },
      });
      const draft = await orchestrator.ensureLiveDraft();
      const envelope = await storedEnvelope(draft.draftId);
      expect(envelope.family).toBe("dashboard");
      expect(envelope.schemaVersion).toBe(schemaVersion ?? "1");
      expect(envelope.body).not.toHaveProperty("mapPackageId");
      expect(envelope.body).not.toHaveProperty("format");
    }
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

  it("uses the observed generation when omitted and surfaces a concurrent replacement", async () => {
    server = await startMockServer();
    const created = await store().create({
      packageKey: "generation-race",
      envelope: { body: createEmptyCompositionState() },
    });
    let observedGeneration: number | undefined;
    const racing = store(async (input, init) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        observedGeneration = body.generation;
        const advanced = await fetch(input, init);
        expect(advanced.ok).toBe(true);
      }
      return fetch(input, init);
    });
    const error = await racing
      .replace(created.draftId, {
        packageKey: created.packageKey,
        envelope: { body: createEmptyCompositionState() },
      })
      .catch((value: unknown) => value);
    expect(observedGeneration).toBe(created.generation);
    expect(isCompositionDraftConflict(error)).toBe(true);
    expect((await store().get(created.draftId)).generation).toBe(created.generation + 1);
  });

  it("refuses render-only foreign bodies before sending any replacement", async () => {
    server = await startMockServer();
    const draftId = await seedDraft("foreign-render-only", {
      mapPackageId: "foreign",
      format: "honua_map_package.v1",
      mapSpec: {},
    });
    const writes: string[] = [];
    const guarded = store(async (input, init) => {
      if (init?.method === "PUT") writes.push(String(input));
      return fetch(input, init);
    });
    await expect(
      guarded.replace(draftId, {
        packageKey: "foreign-render-only",
        envelope: { body: createEmptyCompositionState() },
      }),
    ).rejects.toThrow(/not a Studio composition body/);
    expect(writes).toEqual([]);
    expect((await storedEnvelope(draftId)).body).toEqual({
      mapPackageId: "foreign",
      format: "honua_map_package.v1",
      mapSpec: {},
    });
  });

  it("refuses a real honua_map_package.v1 draft rather than reading it back as an empty map", async () => {
    server = await startMockServer();
    // The shape `live-demo-journeys.spec.mjs`'s `validMapBody` seeds against
    // the REAL server — a rendering artifact, not a composition. Reading it
    // through `applyStudioDraftBody`'s tolerant `body.layers ?? []` would
    // silently hand back a composition with no layers in it.
    const draftId = await seedDraft("sdk-adapter-map-package", {
      mapPackageId: "sdk-adapter-map-package",
      format: "honua_map_package.v1",
      status: "draft",
      initialView: { bbox: [-160.6, 18.7, -154.5, 22.5], crs: "EPSG:4326" },
    });

    await expect(store().get(draftId)).rejects.toThrow(/not a Studio composition body/);
    await expect(store().get(draftId)).rejects.toThrow(/honua_map_package\.v1/);
  });

  it("refuses a body that is not an object at all", async () => {
    server = await startMockServer();
    const draftId = await seedDraft("sdk-adapter-foreign", undefined);
    await expect(store().get(draftId)).rejects.toThrow(/no composition body/);
  });
});
