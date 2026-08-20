import type { HonuaAgentToolResult } from "@honua/sdk-js/agent-tools";

import type { McpClient } from "./client.js";
import { McpToolError } from "./errors.js";
import type { McpToolDescriptor } from "./protocol.js";

function forwardedResult(
  tool: string,
  status: "ok" | "error",
  action: boolean,
  data?: unknown,
  message?: string,
): HonuaAgentToolResult {
  const timestamp = new Date().toISOString();
  return {
    tool,
    status,
    ...(data !== undefined ? { data } : {}),
    ...(message ? { deniedReason: message } : {}),
    audit: {
      tool,
      status,
      dryRun: false,
      action,
      outcome: status === "ok" ? "allowed" : "error",
      parameters: {},
      ...(message ? { message } : {}),
      timestamp,
    },
  } as unknown as HonuaAgentToolResult;
}

/** Forwards one server-advertised GP tool without translating its schema. */
export async function forwardAdvertisedMcpTool(
  client: Pick<McpClient, "callTool">,
  descriptor: McpToolDescriptor,
  args: Record<string, unknown>,
): Promise<HonuaAgentToolResult> {
  const action = descriptor.annotations?.readOnlyHint !== true;
  try {
    const result = await client.callTool(descriptor.name, args);
    const data = result.structuredContent ?? result.content?.find((block) => block.type === "text")?.text ?? null;
    return forwardedResult(descriptor.name, "ok", action, data);
  } catch (error) {
    if (error instanceof McpToolError) {
      return forwardedResult(
        descriptor.name,
        "error",
        action,
        { code: error.code, details: error.data },
        error.message,
      );
    }
    return forwardedResult(
      descriptor.name,
      "error",
      action,
      undefined,
      error instanceof Error ? error.message : String(error),
    );
  }
}
