/**
 * Protocol-level tests against `mock-server.mjs`'s `/mcp` endpoint over real
 * loopback HTTP (honua-studio#7) — the same fixture `src/mcp/client.ts` and
 * the parity test drive. Mirrors `test/mock-server-oidc.test.ts`'s
 * "exercise the actual fixture, not a re-implementation of it" approach.
 */
import { afterEach, describe, expect, it } from "vitest";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { composeDistrictsMapConversation } from "../../src/chat/fixtures/index.js";
import { StudioClient } from "../../src/client/studio-client.js";
import { resolveToolCall } from "../../src/mcp/tool-bridge.js";

let server: Awaited<ReturnType<typeof startMockServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function rpc(url: string, method: string, params: unknown, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${url}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = response.status === 401 ? undefined : await response.json();
  return { status: response.status, sessionId: response.headers.get("mcp-session-id"), body };
}

describe("mock-server.mjs /mcp (honua-studio#7)", () => {
  it("initialize is open (no bearer required) and issues an Mcp-Session-Id", async () => {
    server = await startMockServer();
    const { status, sessionId, body } = await rpc(server.url, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(status).toBe(200);
    expect(sessionId).toBeTruthy();
    expect(body.result.protocolVersion).toBe("2025-03-26");
  });

  it("tools/list is open and advertises the classified honua_studio_* tool names", async () => {
    server = await startMockServer();
    const { body } = await rpc(server.url, "tools/list", {});
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(body.result.tools[0]._meta["honua.studio"].family).toBe("honua.studio.composition");
    expect(names).toEqual([
      "honua_studio_create_draft",
      "honua_studio_get_draft",
      "honua_studio_update_draft",
      "honua_studio_validate_draft",
      "honua_studio_preview_draft",
      "honua_studio_add_layer",
      "honua_studio_remove_layer",
      "honua_studio_set_layer_style",
      "honua_studio_set_layer_visibility",
      "honua_studio_set_view",
      "honua_studio_add_widget",
      "honua_studio_remove_widget",
      "honua_studio_add_control",
      "honua_studio_remove_control",
      "honua_studio_bind_interaction",
      "honua_studio_remove_interaction",
      "honua_studio_save_version",
      "honua_studio_reopen_version",
      "honua_studio_propose_publication",
      "honua_describe_layer",
      "honua_get_style",
      "honua_list_layers",
    ]);
  });

  it("control and interaction tools mutate the authoritative draft and advance its generation", async () => {
    server = await startMockServer();
    const token = mintFixtureAccessToken();
    const create = await rpc(
      server.url,
      "tools/call",
      {
        name: "honua_studio_create_draft",
        arguments: { packageKey: "pkg-controls", family: "map", schemaVersion: "1" },
      },
      token,
    );
    let draft = create.body.result.structuredContent;

    for (const [name, args] of [
      ["honua_studio_add_control", { control: { id: "year", kind: "filterSlider" } }],
      [
        "honua_studio_bind_interaction",
        {
          interaction: {
            id: "year-filter",
            on: { ref: "control:year", event: "change" },
            do: { ref: "layer:parcels", verb: "setFilter" },
          },
        },
      ],
      ["honua_studio_remove_control", { controlId: "year", cascadeInteractions: true }],
    ] as const) {
      const call = await rpc(
        server.url,
        "tools/call",
        { name, arguments: { draftId: draft.draftId, generation: draft.generation, ...args } },
        token,
      );
      draft = call.body.result.structuredContent;
    }

    expect(draft.generation).toBe(4);
    expect(draft.envelope.body.controls).toEqual([]);
    expect(draft.envelope.body.interactions).toEqual([]);
  });

  it("binding an existing interaction replaces it like the production draft reducer", async () => {
    server = await startMockServer();
    const token = mintFixtureAccessToken();
    const create = await rpc(
      server.url,
      "tools/call",
      {
        name: "honua_studio_create_draft",
        arguments: { packageKey: "pkg-rebind", family: "map", schemaVersion: "1" },
      },
      token,
    );
    let draft = create.body.result.structuredContent;
    const addControl = await rpc(
      server.url,
      "tools/call",
      {
        name: "honua_studio_add_control",
        arguments: {
          draftId: draft.draftId,
          generation: draft.generation,
          control: { id: "year", kind: "filterSlider" },
        },
      },
      token,
    );
    draft = addControl.body.result.structuredContent;
    for (const verb of ["setFilter", "clearFilter"]) {
      const call = await rpc(
        server.url,
        "tools/call",
        {
          name: "honua_studio_bind_interaction",
          arguments: {
            draftId: draft.draftId,
            generation: draft.generation,
            interaction: {
              id: "year-filter",
              on: { ref: "control:year", event: "change" },
              do: { ref: "layer:parcels", verb },
            },
          },
        },
        token,
      );
      draft = call.body.result.structuredContent;
    }
    expect(draft.envelope.body.interactions).toEqual([
      {
        id: "year-filter",
        on: { ref: "control:year", event: "change" },
        do: { ref: "layer:parcels", verb: "clearFilter" },
      },
    ]);
  });

  it("tools/call without a bearer token is unauthenticated (401), matching every other protected route", async () => {
    server = await startMockServer();
    const { status } = await rpc(server.url, "tools/call", { name: "honua_studio_create_draft", arguments: {} });
    expect(status).toBe(401);
  });

  it("tools/call for an unknown tool name is a JSON-RPC -32602 error, not a silently-empty result", async () => {
    server = await startMockServer();
    const token = mintFixtureAccessToken();
    const { body } = await rpc(server.url, "tools/call", { name: "not_a_real_tool", arguments: {} }, token);
    expect(body.error).toMatchObject({ code: -32602 });
  });

  it("a composition mutation on a non-map/app-family draft is rejected invalid_argument", async () => {
    server = await startMockServer();
    const token = mintFixtureAccessToken();
    const create = await rpc(
      server.url,
      "tools/call",
      { name: "honua_studio_create_draft", arguments: { packageKey: "pkg-1", family: "query", schemaVersion: "1" } },
      token,
    );
    const draft = create.body.result.structuredContent;
    const addLayer = await rpc(
      server.url,
      "tools/call",
      {
        name: "honua_studio_add_layer",
        arguments: { draftId: draft.draftId, generation: draft.generation, layer: { id: "roads" } },
      },
      token,
    );
    expect(addLayer.body.result).toMatchObject({ isError: true, structuredContent: { code: "invalid_argument" } });
  });

  it("honua_studio_propose_publication requires a saved version and does not publish it", async () => {
    server = await startMockServer();
    const token = mintFixtureAccessToken();
    const create = await rpc(
      server.url,
      "tools/call",
      { name: "honua_studio_create_draft", arguments: { packageKey: "pkg-1", family: "map", schemaVersion: "1" } },
      token,
    );
    const draft = create.body.result.structuredContent;
    const saved = await fetch(`${server.url}/v1/studio/package-drafts/${draft.draftId}/content-versions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    const version = (await saved.json()).data;
    const propose = await rpc(
      server.url,
      "tools/call",
      {
        name: "honua_studio_propose_publication",
        arguments: {
          itemId: version.itemId,
          versionId: version.versionId,
          contentHash: version.contentHash,
          route: "/apps/districts",
          visibility: "private",
        },
      },
      token,
    );
    expect(propose.body.result.structuredContent).toMatchObject({
      status: "AwaitingApproval",
      humanConfirmationRequired: true,
    });
    expect(propose.body.result.structuredContent.publicationUrl).toBeUndefined();
  });

  it("a presented Mcp-Session-Id that was never issued returns 404", async () => {
    server = await startMockServer();
    const response = await fetch(`${server.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": "never-issued" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(404);
  });
});

it("serves canonical fixture style and actual property descriptors, rejecting unknown names", async () => {
  server = await startMockServer();
  const token = mintFixtureAccessToken();
  const descriptor = await rpc(
    server.url,
    "tools/call",
    { name: "honua_describe_layer", arguments: { serviceId: "hi-parcels", layerId: 0 } },
    token,
  );
  expect(
    descriptor.body.result.structuredContent.fields.some((field: { name: string }) => field.name === "district"),
  ).toBe(true);
  const style = await rpc(
    server.url,
    "tools/call",
    { name: "honua_get_style", arguments: { styleId: "district", includeStylesheet: true, encoding: "mapbox-style" } },
    token,
  );
  const definition = style.body.result.structuredContent;
  expect(definition.styleVersion).toBe(1);
  expect(JSON.parse(definition.encodings[0].inlineBody).layers[0].paint["fill-color"][1]).toEqual(["get", "district"]);
  const unknown = await rpc(
    server.url,
    "tools/call",
    { name: "honua_get_style", arguments: { styleId: "unknown" } },
    token,
  );
  expect(unknown.body.result.isError).toBe(true);
});

it("the shipped recorded conversation binds to normal discovery without injected aliases", async () => {
  server = await startMockServer();
  const catalog = await new StudioClient(`${server.url}/api`, {
    getAccessToken: async () => mintFixtureAccessToken(),
  }).listCatalog();
  for (const [index, toolName] of ["add_layer", "add_chart"].entries()) {
    const event = composeDistrictsMapConversation.turns[index].assistant.events.find(
      (event) => event.type === "toolCallStop",
    );
    if (!event || event.type !== "toolCallStop") throw new Error("Missing fixture tool arguments.");
    const result = resolveToolCall({ toolName, arguments: event.toolArguments });
    if (!result.ok) throw new Error(result.reason);
    const command = result.command;
    const sourceId =
      command.name === "addLayer"
        ? command.layer.sourceId
        : command.name === "addWidget"
          ? command.widget.sourceId
          : undefined;
    expect(sourceId).toBe("hi-parcels/0");
    expect(catalog.find((entry) => entry.id === sourceId)?.locator).toMatchObject({
      serviceId: "hi-parcels",
      layerId: 0,
    });
  }
});
