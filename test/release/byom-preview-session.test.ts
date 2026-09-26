import { createStudioAgentSession } from "@honua/sdk-js/studio-agent";
import { afterEach, describe, expect, it } from "vitest";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";

let server: Awaited<ReturnType<typeof startMockServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function rpc(url: string, token: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return response.json();
}

describe("byom preview session", () => {
  it("composes, saves, reopens, and proposes through the advertised catalog, then a separate principal approves", async () => {
    server = await startMockServer({ model: "byom-preview" });
    const token = mintFixtureAccessToken();
    const created = await rpc(server.url, token, "honua_studio_create_draft", {
      packageKey: "preview-parcels",
      family: "map",
      schemaVersion: "1.0",
    });
    const draft = created.result.structuredContent;
    const session = createStudioAgentSession({
      baseUrl: server.url,
      auth: { getAccessToken: async () => token },
      draft: { draftId: draft.draftId, generation: draft.generation },
      system: "Self-hosted preview.",
    });

    const turn = await session.chat(
      "Add the Hawaii parcels layer, zoom the map, save a version, reopen it, and propose sharing it.",
    );
    expect(turn.status).toBe("completed");
    expect(turn.toolCalls.map((call) => call.toolName)).toEqual([
      "honua_studio_add_layer",
      "honua_studio_set_view",
      "honua_studio_save_version",
      "honua_studio_reopen_version",
      "honua_studio_propose_publication",
    ]);
    expect(turn.toolCalls.every((call) => call.ok)).toBe(true);
    expect(turn.text).toMatch(/separate approver/);
    expect(session.draft?.draftId).not.toBe(draft.draftId);

    const toolText = session.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.content)
      .join("\n");
    const proposalId = /"proposalId"\s*:\s*"([^"]+)"/.exec(toolText)?.[1];
    const versionId = /"savedVersionId"\s*:\s*"([^"]+)"/.exec(toolText)?.[1];
    expect(proposalId).toBeTruthy();
    expect(versionId).toBeTruthy();

    const pending = await fetch(`${server.url}/v1/studio/publication-proposals/${proposalId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const pendingBody = await pending.json();
    expect(pendingBody.data.status).toBe("pending");
    expect(pendingBody.data.approvedUrl).toBeUndefined();

    const selfApprove = await fetch(`${server.url}/v1/studio/publication-proposals/${proposalId}/decision`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(selfApprove.status).toBe(403);

    const stranger = mintFixtureAccessToken({ sub: "other-user", roles: ["admin"] });
    const hidden = await fetch(`${server.url}/v1/studio/publication-proposals/${proposalId}`, {
      headers: { authorization: `Bearer ${stranger}` },
    });
    expect(hidden.status).toBe(404);

    const approver = mintFixtureAccessToken({ sub: "studio-approver", roles: ["approver"] });
    const decision = await fetch(`${server.url}/v1/studio/publication-proposals/${proposalId}/decision`, {
      method: "POST",
      headers: { authorization: `Bearer ${approver}`, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(decision.status).toBe(200);
    const approved = await decision.json();
    expect(approved.data.approvedUrl).toMatch(/\/published\//);
    const published = await fetch(approved.data.approvedUrl);
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ versionId, proposalId });

    const unrelated = await session.chat("What is the weather in Honolulu?");
    expect(unrelated.status).toBe("completed");
    expect(unrelated.toolCalls).toEqual([]);
  });
});
