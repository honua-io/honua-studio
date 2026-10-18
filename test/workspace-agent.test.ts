import { expect, it } from "vitest";
import { createWorkspaceAgentSession, workspaceAgentFeatures } from "../src/workspace-agent.js";

it("refreshes the same actual SDK session catalog with fresh approval and absent descriptors", async () => {
  let devopsApproved = true;
  let includeLocal = true;
  const descriptor = (name: string, family: string) => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    _meta: { "honua.studio": { family, view: "lifecycle", revision: "test" } },
  });
  const fetchImpl: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (request.method !== "initialize" && request.method !== "tools/list")
      throw new Error("Discovery-only test must not execute model or tools.");
    const result =
      request.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: { tools: {} } }
        : {
            tools: [
              descriptor("test_devops", "honua.workspace.devops"),
              ...(includeLocal ? [descriptor("test_local", "honua.workspace.local-process")] : []),
            ],
          };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      headers: { "content-type": "application/json", "mcp-session-id": "same-session" },
    });
  };
  const session = createWorkspaceAgentSession({
    fetchImpl,
    system: () => "Discovery test",
    toolFamilies: ["honua.workspace.devops", "honua.workspace.local-process"],
    toolApproval: (entry) => entry.classification?.family !== "honua.workspace.devops" || devopsApproved,
  });
  expect(workspaceAgentFeatures.toolApproval).toBe(true);
  try {
    await session.refreshTools();
    expect(session.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["test_devops", "test_local"]));
    devopsApproved = false;
    includeLocal = false;
    session.reconnect();
    await session.refreshTools();
    expect(session.tools.map((tool) => tool.name)).not.toContain("test_devops");
    expect(session.tools.map((tool) => tool.name)).not.toContain("test_local");
    expect(session.messages).toEqual([]);
  } finally {
    session.close();
  }
});
