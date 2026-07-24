/**
 * Protocol-level tests against `mock-server.mjs`'s `/mcp` endpoint over real
 * loopback HTTP (honua-studio#7) — the same fixture `src/mcp/client.ts` and
 * the parity test drive. Mirrors `test/mock-server-oidc.test.ts`'s
 * "exercise the actual fixture, not a re-implementation of it" approach.
 */
import { afterEach, describe, expect, it } from "vitest";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";

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

  it("tools/list is open and advertises all 12 honua_studio_* tool names", async () => {
    server = await startMockServer();
    const { body } = await rpc(server.url, "tools/list", {});
    const names = body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([
      "honua_studio_create_draft",
      "honua_studio_get_draft",
      "honua_studio_update_draft",
      "honua_studio_validate_draft",
      "honua_studio_preview_draft",
      "honua_studio_add_layer",
      "honua_studio_remove_layer",
      "honua_studio_set_layer_style",
      "honua_studio_set_view",
      "honua_studio_add_widget",
      "honua_studio_remove_widget",
      "honua_studio_propose_publication",
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

  it("honua_studio_propose_publication records intent only — never a publish/share/embed action", async () => {
    server = await startMockServer();
    const token = mintFixtureAccessToken();
    const create = await rpc(
      server.url,
      "tools/call",
      { name: "honua_studio_create_draft", arguments: { packageKey: "pkg-1", family: "map", schemaVersion: "1" } },
      token,
    );
    const draft = create.body.result.structuredContent;
    const propose = await rpc(
      server.url,
      "tools/call",
      {
        name: "honua_studio_propose_publication",
        arguments: {
          draftId: draft.draftId,
          generation: draft.generation,
          route: "/apps/districts",
          visibility: "org",
        },
      },
      token,
    );
    expect(propose.body.result.structuredContent).toMatchObject({ recorded: true, humanConfirmationRequired: true });
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
