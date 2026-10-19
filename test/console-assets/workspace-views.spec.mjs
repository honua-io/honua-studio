import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { expect, test } from "@playwright/test";

test("built Console session selects bounded workflow views with one MCP session and fresh credentials", async ({
  page,
}) => {
  const root = resolve("dist-console");
  const requests = [];
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/api/mcp") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({
        method: rpc.method,
        view:
          rpc.params?.view ??
          rpc.params?._meta?.["honua.io/workflow-view"] ??
          (rpc.method === "tools/list" ? "workspace" : undefined),
        session: request.headers["mcp-session-id"],
        credential: request.headers["x-test-agent"],
      });
      if (rpc.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      const view = rpc.params?.view ?? "workspace";
      const process = view === "processes";
      const result =
        rpc.method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: { tools: {} } }
          : {
              _meta: { view },
              tools: [
                {
                  name: process ? "honua_workspace_local_process_get_run" : "honua_workspace_get_turn",
                  description: "Read the current authorized task",
                  inputSchema: { type: "object", properties: {} },
                  _meta: {
                    "honua.studio": {
                      family: process ? "honua.workspace.local-process" : "honua.workspace.canonical",
                      view,
                      revision: `${view}.v1`,
                    },
                  },
                },
              ],
            };
      response.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "one-workspace-session" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
      return;
    }
    if (pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>Workflow views</title>");
      return;
    }
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const bytes = await readFile(file);
      response.writeHead(200, {
        "Content-Type": pathname.endsWith(".js") ? "text/javascript" : "application/octet-stream",
      });
      response.end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const result = await page.evaluate(async () => {
      const studio = await import("/console.js");
      let credential = 0;
      const session = studio.createWorkspaceAgentSession({
        fetchImpl: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("X-Test-Agent", `fresh-${++credential}`);
          return fetch(input, { ...init, headers });
        },
        system: () => "Use the captured Console context.",
        toolFamilies: ["honua.workspace.canonical", "honua.workspace.local-process"],
      });
      try {
        await session.refreshTools();
        const workspace = session.tools.map((tool) => tool.name);
        await session.selectWorkflowView("processes");
        const processes = session.tools.map((tool) => tool.name);
        await session.selectWorkflowView("workspace");
        return { workspace, processes, returned: session.tools.map((tool) => tool.name) };
      } finally {
        session.close();
      }
    });
    expect(result.workspace).toContain("honua_client_select_workflow_view");
    expect(result.workspace).toContain("honua_workspace_get_turn");
    expect(result.processes).toContain("honua_workspace_local_process_get_run");
    expect(result.processes).not.toContain("honua_workspace_get_turn");
    expect(result.returned).toEqual(result.workspace);
    expect(requests.filter((request) => request.method === "initialize")).toHaveLength(1);
    expect(requests[0].view).toBe("workspace");
    expect(requests.filter((request) => request.method === "tools/list").map((request) => request.view)).toEqual([
      "workspace",
      "processes",
      "workspace",
    ]);
    for (const [index, request] of requests.entries()) {
      expect(request.credential).toBe(`fresh-${index + 1}`);
      if (request.method !== "initialize") expect(request.session).toBe("one-workspace-session");
    }
  } finally {
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
  }
});
