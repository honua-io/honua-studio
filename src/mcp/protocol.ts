/**
 * JSON-RPC 2.0 / MCP wire types (honua-studio#7, REQ-001/002/004).
 *
 * These mirror the subset of the MCP `2025-03-26` Streamable HTTP transport
 * that `src/mcp/client.ts` actually speaks — `initialize`, `tools/list`,
 * `tools/call` — against honua-server's `POST /mcp` endpoint
 * (`docs/guides/connect/ai-agents-mcp.md` in honua-server). Deliberately NOT
 * a full MCP SDK surface (no resources/prompts/sampling/roots): this is the
 * temporary advertised-extension seam described in `client.ts`.
 *
 * @module
 */

/** The MCP protocol revision this client speaks. */
export const MCP_PROTOCOL_VERSION = "2025-03-26";

export interface JsonRpcRequest<TParams = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly method: string;
  readonly params?: TParams;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcSuccessResponse<TResult = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result: TResult;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly error: JsonRpcErrorObject;
}

export type JsonRpcResponse<TResult = unknown> = JsonRpcSuccessResponse<TResult> | JsonRpcErrorResponse;

export function isJsonRpcErrorResponse(response: JsonRpcResponse): response is JsonRpcErrorResponse {
  return "error" in response && response.error !== undefined;
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export interface McpClientInfo {
  readonly name: string;
  readonly version: string;
}

export interface McpInitializeParams {
  readonly protocolVersion: string;
  /** Sent empty — this client declares no optional capabilities (no roots/sampling). */
  readonly capabilities: Record<string, never>;
  readonly clientInfo: McpClientInfo;
}

export interface McpInitializeResult {
  readonly protocolVersion: string;
  readonly capabilities?: Record<string, unknown>;
  readonly serverInfo?: McpClientInfo;
}

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

/** MCP behavior annotations (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`) — advertised per tool, per the honua-server doc's "Verify" section. */
export interface McpToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly annotations?: McpToolAnnotations;
}

export interface McpToolsListParams {
  readonly cursor?: string;
}

export interface McpToolsListResult {
  readonly tools: readonly McpToolDescriptor[];
  readonly nextCursor?: string;
}

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

export interface McpToolsCallParams {
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
}

export interface McpContentBlock {
  readonly type: "text" | (string & {});
  readonly text?: string;
  readonly [key: string]: unknown;
}

/**
 * The MCP error-contract "structured content" the honua-server doc promises
 * ("tool failures are returned inside `result` with `isError: true` and a
 * structured `code` ... read the embedded message"). The exact JSON Schema
 * for this shape is not published anywhere this client could import from —
 * `client.ts`'s module doc records the interpretation this type encodes and
 * how `parseToolError` degrades gracefully if a real server's shape differs.
 */
export interface McpStructuredError {
  readonly code: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

export interface McpToolsCallResult {
  readonly content?: readonly McpContentBlock[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

/** Every documented `code` value from the honua-server MCP error contract (docs/guides/connect/ai-agents-mcp.md § Troubleshoot). */
export type McpToolErrorCode =
  | "invalid_argument"
  | "not_found"
  | "failed_precondition"
  | "permission_denied"
  | "unauthenticated"
  | "insufficient_scope"
  | "internal"
  | (string & {});
