import { describe, expect, it, vi } from "vitest";

import { McpClient } from "../../src/mcp/client.js";
import { McpProtocolError, McpToolError, McpTransportError, isMcpGenerationConflict } from "../../src/mcp/errors.js";

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("mcp/client McpClient", () => {
  it("the DEFAULT fetchImpl (no override) invokes the global fetch with a valid receiver — regression for a real browser bug", async () => {
    // Browsers' `fetch` is receiver-sensitive: an unbound reference called
    // with a `this` other than `window` throws "TypeError: Failed to
    // execute 'fetch' on 'Window': Illegal invocation". `McpClient` calls
    // its stored `#fetchImpl` as `this.#fetchImpl(...)` (private-field
    // method-call syntax), which sets `this` to the McpClient instance
    // unless the default is explicitly bound — caught via
    // `test/playwright/mcp-compose-journey.spec.mjs` failing with "Could
    // not reach the MCP endpoint" in a REAL browser (Node's fetch doesn't
    // enforce this, so a node-only test suite alone never would have).
    const realFetch = globalThis.fetch;
    let receiverWasGlobalThis = false;
    vi.stubGlobal("fetch", function fakeFetch(this: unknown, ...args: Parameters<typeof fetch>) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      receiverWasGlobalThis = true;
      return realFetch(...args);
    });
    try {
      const client = new McpClient(); // no fetchImpl override — exercises the default.
      const initializePromise = client.initialize();
      await expect(initializePromise).rejects.toBeInstanceOf(McpTransportError); // no server at /api/mcp here — a transport error is fine
      expect(receiverWasGlobalThis).toBe(true); // the failure must be "nobody's listening", never "Illegal invocation"
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("initialize sends the documented JSON-RPC envelope and captures Mcp-Session-Id", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        jsonrpc: "2.0",
        id: expect.any(String),
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "honua-studio", version: "0.0.0" },
        },
      });
      return jsonResponse(
        { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } },
        { "mcp-session-id": "session-1" },
      );
    });
    const client = new McpClient({ baseUrl: "/api", fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.initialize();
    expect(result.protocolVersion).toBe("2025-03-26");
    expect(client.sessionId).toBe("session-1");
    expect(fetchImpl).toHaveBeenCalledWith("/api/mcp", expect.objectContaining({ method: "POST" }));
  });

  it("initialize is idempotent — concurrent + repeated calls share one request", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      return jsonResponse(
        { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } },
        { "mcp-session-id": "session-1" },
      );
    });
    const client = new McpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const [a, b] = await Promise.all([client.initialize(), client.initialize()]);
    await client.initialize();
    expect(a).toEqual(b);
    expect(calls).toBe(1);
  });

  it("listTools/callTool attach the bearer token and the captured session id on every request", async () => {
    const requests: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(init as RequestInit);
      const body = JSON.parse(String(init?.body));
      if (body.method === "initialize") {
        return jsonResponse(
          { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } },
          { "mcp-session-id": "session-42" },
        );
      }
      if (body.method === "tools/list") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
      }
      throw new Error(`unexpected method ${body.method}`);
    });
    const auth = { getAccessToken: vi.fn(async () => "token-abc") };
    const client = new McpClient({ auth, fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.listTools();

    expect(requests).toHaveLength(2);
    const initHeaders = requests[0]?.headers as Record<string, string>;
    expect(initHeaders.authorization).toBe("Bearer token-abc");
    expect(initHeaders["mcp-session-id"]).toBeUndefined();
    const listHeaders = requests[1]?.headers as Record<string, string>;
    expect(listHeaders.authorization).toBe("Bearer token-abc");
    expect(listHeaders["mcp-session-id"]).toBe("session-42");
  });

  it("callTool parses structuredContent success results", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "initialize") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } });
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { structuredContent: { draftId: "d1", generation: 1 } },
      });
    });
    const client = new McpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.callTool("honua_studio_get_draft", { draftId: "d1" });
    expect(result.structuredContent).toEqual({ draftId: "d1", generation: 1 });
  });

  it("callTool throws McpToolError with the structured code on isError results", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "initialize") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } });
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          isError: true,
          structuredContent: { code: "failed_precondition", message: "Stale draft generation; refresh and retry." },
        },
      });
    });
    const client = new McpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const error = await client.callTool("honua_studio_update_draft", {}).catch((e) => e);
    expect(error).toBeInstanceOf(McpToolError);
    expect((error as McpToolError).code).toBe("failed_precondition");
    expect(isMcpGenerationConflict(error)).toBe(true);
  });

  it("callTool falls back to parsing the first text content block as JSON when structuredContent is absent", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "initialize") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } });
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ code: "not_found", message: "no such draft" }) }],
        },
      });
    });
    const client = new McpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const error = await client.callTool("honua_studio_get_draft", {}).catch((e) => e);
    expect(error).toBeInstanceOf(McpToolError);
    expect((error as McpToolError).code).toBe("not_found");
    expect((error as McpToolError).message).toBe("no such draft");
  });

  it('callTool degrades to code "unknown" when no structured error shape is present at all', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "initialize") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } });
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { isError: true } });
    });
    const client = new McpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const error = await client.callTool("honua_studio_get_draft", {}).catch((e) => e);
    expect(error).toBeInstanceOf(McpToolError);
    expect((error as McpToolError).code).toBe("unknown");
  });

  it("a JSON-RPC-level error response throws McpProtocolError, not McpToolError", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "initialize") {
        return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } });
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "Invalid params" } });
    });
    const client = new McpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const error = await client.callTool("honua_studio_get_draft", {}).catch((e) => e);
    expect(error).toBeInstanceOf(McpProtocolError);
    expect((error as McpProtocolError).code).toBe(-32602);
  });

  it("a network failure throws McpTransportError", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = new McpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.initialize()).rejects.toBeInstanceOf(McpTransportError);
  });

  it("a non-2xx response with no JSON-RPC body throws McpTransportError", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("Unauthorized", { status: 401, headers: { "content-type": "text/plain" } }),
    );
    const client = new McpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.initialize()).rejects.toBeInstanceOf(McpTransportError);
  });

  it("parses a one-shot text/event-stream response the same as a plain JSON response", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const payload = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } });
      return new Response(`event: message\ndata: ${payload}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const client = new McpClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.initialize();
    expect(result.protocolVersion).toBe("2025-03-26");
  });
});
