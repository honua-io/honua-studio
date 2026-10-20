import { expect, it } from "vitest";
import { mintFixtureAccessToken, startMockServer } from "../mock-server.mjs";
import { createWorkspaceAgentSession, workspaceAgentFeatures } from "../src/workspace-agent.js";

it("sends shared workflow guidance with fresh host context through the real SDK and fixture proxy", async () => {
  const server = await startMockServer({ model: "byom-preview" });
  const token = mintFixtureAccessToken();
  const requests: { system?: string; tools?: { name: string }[] }[] = [];
  let context = "Current authorized target alpha";
  const session = createWorkspaceAgentSession({
    fetchImpl: async (input, init) => {
      const path = new URL(String(input), "http://studio.test").pathname.replace(/^\/api/, "");
      if (path === "/v1/studio/ai/chat") requests.push(JSON.parse(String(init?.body)));
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      return fetch(`${server.url}${path}`, { ...init, headers });
    },
    system: async () => context,
    toolFamilies: ["honua.workspace.canonical"],
    toolApproval: () => false,
  });
  try {
    expect((await session.chat("Explain the selected target.")).status).toBe("completed");
    context = "Current authorized target beta";
    expect((await session.chat("Explain the current target.")).status).toBe("completed");
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.system).toContain('"schemaVersion":"honua.agent-workflow-knowledge/v1"');
      expect(request.system).toContain('"id":"local-bootstrap"');
      expect(request.system).toContain('"id":"studio-map-and-publication"');
      expect(request.system).toContain("not authorization or execution evidence");
      expect(request.tools?.some((tool) => tool.name === "honua_agent_install_local")).not.toBe(true);
      expect(request.tools?.some((tool) => tool.name === "honua_studio_propose_publication")).not.toBe(true);
    }
    expect(requests[0]?.system).toContain("Current authorized target alpha");
    expect(requests[1]?.system).toContain("Current authorized target beta");
    expect(requests[1]?.system).not.toContain("Current authorized target alpha");
  } finally {
    session.close();
    await server.close();
  }
});

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

it("starts bounded and switches workflow views on the same SDK session without granting process execution", async () => {
  const requestedViews: string[] = [];
  let initializations = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    let result: object;
    if (request.method === "initialize") {
      initializations++;
      expect(request.params._meta["honua.io/workflow-view"]).toBe("workspace");
      result = { protocolVersion: "2025-03-26", capabilities: { tools: {} } };
    } else {
      expect(request.method).toBe("tools/list");
      expect(new Headers(init?.headers).get("mcp-session-id")).toBe("workspace-session");
      const view = request.params?.view ?? "workspace";
      requestedViews.push(view);
      result = {
        _meta: { view, revision: `${view}.v1` },
        tools: [
          {
            name: view === "processes" ? "honua_workspace_local_process_run" : "honua_workspace_get_turn",
            description: "Canonical server capability",
            inputSchema: { type: "object", properties: {} },
            _meta: {
              "honua.studio": {
                family: view === "processes" ? "honua.workspace.local-process" : "honua.workspace.canonical",
                view,
                revision: `${view}.v1`,
              },
            },
          },
        ],
      };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      headers: { "content-type": "application/json", "mcp-session-id": "workspace-session" },
    });
  };
  const session = createWorkspaceAgentSession({
    fetchImpl,
    system: () => "Shared Console context",
    toolFamilies: ["honua.workspace.canonical"],
  });
  try {
    await session.refreshTools();
    expect(session.tools.map((tool) => tool.name)).toContain("honua_client_select_workflow_view");
    expect(session.tools.map((tool) => tool.name)).toContain("honua_workspace_get_turn");
    await session.selectWorkflowView("processes");
    expect(session.tools.map((tool) => tool.name)).not.toContain("honua_workspace_local_process_run");
    expect(session.tools.map((tool) => tool.name)).not.toContain("honua_workspace_get_turn");
    await session.selectWorkflowView("workspace");
    expect(session.tools.map((tool) => tool.name)).toContain("honua_workspace_get_turn");
    expect(initializations).toBe(1);
    expect(requestedViews).toEqual(["workspace", "processes", "workspace"]);
  } finally {
    session.close();
  }
});
