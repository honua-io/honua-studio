/**
 * Typed error channel for `src/mcp/client.ts` (honua-studio#7 REQ-001).
 * Three distinguishable failure classes, mirroring the layering the
 * honua-server MCP doc itself draws (transport vs. JSON-RPC protocol vs.
 * tool-level result):
 *
 *  - {@link McpTransportError} — the HTTP request itself failed (network,
 *    non-2xx with no parseable JSON-RPC envelope, malformed body).
 *  - {@link McpProtocolError} — a JSON-RPC-level error (`response.error`,
 *    e.g. `-32600 invalid_request`, `-32601 method not found`,
 *    `-32602 invalid params`) — the envelope round-tripped but the request
 *    itself was rejected before any tool ran.
 *  - {@link McpToolError} — a tool ran and reported failure
 *    (`result.isError: true`) with a structured `code` — see
 *    `protocol.ts`'s {@link McpToolErrorCode} for the vocabulary
 *    (`invalid_argument` | `not_found` | `failed_precondition` | …).
 *
 * `isMcpGenerationConflict` is the one discriminant `src/mcp/orchestrator.ts`
 * branches on by name — mirrors `composition/history.ts`'s
 * `isCompositionDraftConflict` / the SDK's documented
 * `isHonuaStudioGenerationConflict` so a "stale generation, refetch and
 * retry" failure reads identically everywhere in this codebase.
 *
 * @module
 */

import type { McpToolErrorCode } from "./protocol.js";

export class McpTransportError extends Error {
  public constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "McpTransportError";
  }
}

/** A JSON-RPC-level error (`response.error`) — the request was rejected before any tool logic ran. */
export class McpProtocolError extends Error {
  public readonly code: number;
  public readonly data: unknown;

  public constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
    this.data = data;
  }
}

/**
 * A tool-level failure (`tools/call` result with `isError: true`). `code`
 * follows the honua-server MCP error contract's vocabulary when the server
 * supplies one; `"unknown"` when the result carried no recognizable
 * structured error (see `client.ts`'s `parseToolError`).
 */
export class McpToolError extends Error {
  public readonly code: McpToolErrorCode;
  public readonly toolName: string;
  public readonly data: unknown;

  public constructor(message: string, code: McpToolErrorCode, toolName: string, data?: unknown) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
    this.toolName = toolName;
    this.data = data;
  }
}

/** True only for the optimistic-concurrency discriminant (`failed_precondition` from a Studio draft generation check) — see the module doc. */
export function isMcpGenerationConflict(error: unknown): error is McpToolError {
  return error instanceof McpToolError && error.code === "failed_precondition";
}

export function isMcpNotFound(error: unknown): error is McpToolError {
  return error instanceof McpToolError && error.code === "not_found";
}

export function isMcpToolError(error: unknown): error is McpToolError {
  return error instanceof McpToolError;
}
