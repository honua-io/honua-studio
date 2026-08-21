import { describe, expect, it, vi } from "vitest";

import { McpToolError } from "../../src/mcp/errors.js";
import { forwardAdvertisedMcpTool } from "../../src/mcp/forwarded-agent-tool.js";
import type { McpToolDescriptor } from "../../src/mcp/protocol.js";

function descriptor(name: string, readOnlyHint = false): McpToolDescriptor {
  return { name, inputSchema: { type: "object" }, annotations: { readOnlyHint } };
}

describe("forwardAdvertisedMcpTool", () => {
  it("forwards an Esri Buffer task unchanged through execute_task", async () => {
    const callTool = vi.fn(async () => ({ structuredContent: { jobId: "job-1", status: "accepted", artifacts: [] } }));
    const args = {
      serviceUrl: "https://example.test/GPServer",
      taskName: "Buffer",
      parameters: { Input_Features: { url: "https://example.test/FeatureServer/0" }, Distance: 5 },
    };
    const result = await forwardAdvertisedMcpTool(
      { callTool } as never,
      descriptor("honua_esri_gp_execute_task"),
      args,
    );
    expect(callTool).toHaveBeenCalledWith("honua_esri_gp_execute_task", args);
    expect(result).toMatchObject({ status: "ok", data: { jobId: "job-1", status: "accepted" } });
    expect(result.audit.action).toBe(true);
  });

  it("honors read-only annotations for list/describe calls", async () => {
    const result = await forwardAdvertisedMcpTool(
      { callTool: async () => ({ structuredContent: { tasks: ["Buffer"] } }) } as never,
      descriptor("honua_esri_gp_list_tasks", true),
      {},
    );
    expect(result.status).toBe("ok");
    expect(result.audit.action).toBe(false);
  });

  it("preserves MCP tool failure code, details, and message", async () => {
    const error = new McpToolError("Buffer job failed", "internal", "honua_esri_gp_execute_task", {
      jobId: "job-2",
      status: "failed",
    });
    const result = await forwardAdvertisedMcpTool(
      { callTool: async () => Promise.reject(error) } as never,
      descriptor("honua_esri_gp_execute_task"),
      {},
    );
    expect(result).toMatchObject({
      status: "error",
      deniedReason: "Buffer job failed",
      data: { code: "internal", details: { jobId: "job-2", status: "failed" } },
      audit: { outcome: "error", message: "Buffer job failed" },
    });
  });

  it("awaits lifecycle reconciliation before returning success", async () => {
    const result = { structuredContent: { draftId: "draft-2", generation: 7 } };
    const reconciled: unknown[] = [];
    const forwarded = await forwardAdvertisedMcpTool(
      { callTool: async () => result } as never,
      descriptor("honua_studio_reopen_version"),
      { itemId: "item-1", versionId: "version-1" },
      async (observed) => {
        await Promise.resolve();
        reconciled.push(observed);
      },
    );

    expect(reconciled).toEqual([result]);
    expect(forwarded).toMatchObject({ status: "ok", data: result.structuredContent });
  });
});
