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
  createLifecycleCompositionDraftStore,
} from "../../src/lifecycle/composition-draft-store.js";
import { McpClient } from "../../src/mcp/client.js";
import { ToolCallOrchestrator } from "../../src/mcp/orchestrator.js";

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
    body: JSON.stringify({ packageKey, envelope: { family: "map", schemaVersion: "1", body } }),
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

  it("writes honua-server's StudioCompositionBody — NOT a honua_map_package.v1 body", async () => {
    server = await startMockServer();
    const sync = new DraftSync({ store: store(), packageKey: "sdk-adapter-shape" });
    let state = withLayer(createEmptyCompositionState(), "parcels");
    state = applyCompositionCommand(state, { name: "setView", view: { zoom: 7 } }).state;
    const draft = await sync.apply(state);

    // Read the raw stored envelope off the REST surface rather than through
    // the adapter — the mock never validates map bodies (`runValidation` is
    // envelope-only), so only the literal shape proves anything here.
    const stored = await storedEnvelope(draft.draftId);

    expect(Object.keys(stored.body).sort()).toEqual(["layers", "view", "widgets"]);
    expect(stored.body).toMatchObject({
      layers: [{ id: "parcels", sourceId: "src-parcels", visible: true }],
      view: { zoom: 7 },
      widgets: [],
    });

    // The honua_map_package.v1 projection's own fields — the shape
    // `../map/map-package-projection.ts` produces and the REAL server's
    // validator demands under that format. None of them belong here, and
    // claiming the format without them is what made drafts written by this
    // adapter unable to validate or publish against a real deployment.
    for (const mapPackageField of ["mapPackageId", "format", "status", "initialView", "mapSpec", "sourceBindings"]) {
      expect(stored.body).not.toHaveProperty(mapPackageField);
    }

    // The envelope says `map`/`1` and declines to name a format at all, byte
    // for byte what `honua_studio_create_draft` sends for the same draft.
    expect(stored.family).toBe(COMPOSITION_DRAFT_ENVELOPE.family);
    expect(stored.schemaVersion).toBe(COMPOSITION_DRAFT_ENVELOPE.schemaVersion);
    expect(COMPOSITION_DRAFT_ENVELOPE.format).toBeUndefined();
    expect(stored).not.toHaveProperty("format");
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
        schemaVersion: "1",
      },
    });
    await orchestrator.handleToolCall({ toolName: "setView", arguments: { view: { zoom: 4 } } });

    const adapterEnvelope = await storedEnvelope(viaAdapter.draftId);
    const orchestratorEnvelope = await storedEnvelope(orchestrator.draftId as string);

    expect(Object.keys(adapterEnvelope).sort()).toEqual(Object.keys(orchestratorEnvelope).sort());
    expect(adapterEnvelope.family).toBe(orchestratorEnvelope.family);
    expect(adapterEnvelope.schemaVersion).toBe(orchestratorEnvelope.schemaVersion);
    expect(Object.keys(adapterEnvelope.body).sort()).toEqual(Object.keys(orchestratorEnvelope.body).sort());
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
