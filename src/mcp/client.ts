import { McpProtocolError, McpToolError, McpTransportError } from "./errors.js";
/**
 * A minimal MCP client over honua-server's `/mcp` HTTP transport
 * (honua-studio#7 REQ-001; `docs/guides/connect/ai-agents-mcp.md` in
 * honua-server). JSON-RPC 2.0 over `POST /mcp`: `initialize` handshake,
 * `tools/list`, `tools/call` — nothing else (no resources/prompts/sampling;
 * Studio's tool plane never needs them).
 *
 * ## SDK vs. hand-rolled (the decision this module records)
 *
 * `@modelcontextprotocol/sdk` was evaluated and rejected for this app:
 *
 *  - It is a `node_modules`-heavy, transport-and-protocol-agnostic kit built
 *    around `Server`/`Client` classes, stdio transports, and a
 *    request-router abstraction sized for building an MCP SERVER or a
 *    general-purpose agent host — this app is neither. It only ever issues
 *    three method calls against one already-known HTTP endpoint.
 *  - It pulls in `zod` (schema validation this app doesn't otherwise need —
 *    `commands.ts`'s own module doc already commits this repo to hand-rolled
 *    structural validation, "no schema-validation dependency") and a
 *    `content-type`/`raw-body`/`eventsource-parser` chain sized for its own
 *    SSE + stdio transports, none of which are exercised by a
 *    request/response POST client.
 *  - This app already hand-rolls an equally protocol-sensitive streaming
 *    client (`../chat/sse-transport.ts` + `../chat/sse-parser.ts`) rather
 *    than reach for a dependency — the same call applies here, and the
 *    surface is smaller (three JSON-RPC methods, no streaming to parse in
 *    the common case).
 *  - Bundle size matters: this app ships to a browser tab (REQ-001's own
 *    "MCP served where the state lives" runs the client from the SAME
 *    browser context as the rest of Studio, per AD-5), and the SDK is not
 *    tree-shake-friendly against a three-method usage.
 *
 * A ~250-line hand-rolled client that speaks exactly the transport
 * honua-server documents is safer for bundle size and matches this
 * repo's established pattern (`sse-transport.ts`, `studio-client.ts`) of
 * thin, dependency-free fetch wrappers with a typed error channel. If a
 * future need for resources/prompts/sampling/roots emerges, or the SDK
 * publishes a slim browser-only transport package, revisit this decision —
 * nothing about the {@link McpClient} public surface below is SDK-shaped in
 * a way that would make swapping it out later disruptive.
 *
 * ## Session handling
 *
 * `POST /mcp` issues a session id on `initialize` (`Mcp-Session-Id` response
 * header) and validates it on every later request (honua-server doc,
 * "Harden the MCP endpoint"). `initialize()` captures it; every subsequent
 * request attaches it. `initialize` must never be batched with anything else
 * (`-32600` if it is) — this client only ever sends single requests, so that
 * constraint is satisfied structurally.
 *
 * ## Transport response shape
 *
 * A `POST /mcp` response is either a single JSON-RPC object
 * (`content-type: application/json`) or, for a server running the
 * streaming-capable profile, a one-shot SSE frame carrying the same JSON-RPC
 * object (`content-type: text/event-stream`) — `#parseResponseBody` handles
 * both; this client never opens the optional standalone `GET /mcp` push
 * stream (off by default server-side, and irrelevant to a request/response
 * tool call).
 *
 * @module
 */
import {
  type JsonRpcResponse,
  MCP_PROTOCOL_VERSION,
  type McpInitializeResult,
  type McpToolsCallParams,
  type McpToolsCallResult,
  type McpToolsListParams,
  type McpToolsListResult,
  isJsonRpcErrorResponse,
} from "./protocol.js";

/** The minimal token surface this client depends on — matches `studio-client.ts`'s/`sse-transport.ts`'s `TokenSource`, satisfied by `AuthSession`. */
export interface TokenSource {
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string | undefined>;
}

export interface McpClientOptions {
  /** The `/mcp` endpoint's base — e.g. `"/api"` (mirrors `StudioClient`/`SseChatTransport`'s default); the client POSTs to `${baseUrl}/mcp`. */
  baseUrl?: string;
  auth?: TokenSource;
  /** Advertised in `initialize`'s `clientInfo`. */
  clientName?: string;
  clientVersion?: string;
  /** Override for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

let requestSeq = 0;
function nextRequestId(): string {
  requestSeq += 1;
  return `honua-studio-mcp-${requestSeq}`;
}

/**
 * A minimal, hand-rolled MCP client for honua-server's `POST /mcp`
 * Streamable HTTP transport — see the module doc for the SDK-vs-hand-rolled
 * decision. One instance owns one session (`Mcp-Session-Id`); call
 * {@link McpClient.initialize} once before {@link McpClient.listTools} /
 * {@link McpClient.callTool} (both call it lazily on first use if it hasn't
 * run yet, so callers that only need `callTool` don't have to sequence it
 * themselves).
 */
export class McpClient {
  readonly #baseUrl: string;
  readonly #auth: TokenSource | undefined;
  readonly #clientName: string;
  readonly #clientVersion: string;
  readonly #fetchImpl: typeof fetch;
  #sessionId: string | undefined;
  #initializeResult: McpInitializeResult | undefined;
  #initializing: Promise<McpInitializeResult> | undefined;

  public constructor(options: McpClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? "/api";
    this.#auth = options.auth;
    this.#clientName = options.clientName ?? "honua-studio";
    this.#clientVersion = options.clientVersion ?? "0.0.0";
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  /** The `Mcp-Session-Id` this client was bound to on `initialize`, or `undefined` before the first call. */
  public get sessionId(): string | undefined {
    return this.#sessionId;
  }

  /** The result of the last (or in-flight) `initialize` call — `protocolVersion`/`serverInfo`/`capabilities`. */
  public get serverInfo(): McpInitializeResult | undefined {
    return this.#initializeResult;
  }

  /**
   * Runs the `initialize` handshake, capturing the `Mcp-Session-Id` response
   * header for every later call. Safe to call more than once — concurrent
   * callers share one in-flight request; a session already established is
   * NOT re-initialized (handshake methods are idempotent enough for this
   * client's needs, and honua-server doesn't require re-initializing an
   * existing session).
   */
  public async initialize(): Promise<McpInitializeResult> {
    if (this.#initializeResult) return this.#initializeResult;
    if (!this.#initializing) {
      this.#initializing = this.#doInitialize().finally(() => {
        this.#initializing = undefined;
      });
    }
    return this.#initializing;
  }

  async #doInitialize(): Promise<McpInitializeResult> {
    const result = await this.#send<McpInitializeResult>("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.#clientName, version: this.#clientVersion },
    });
    this.#initializeResult = result;
    return result;
  }

  /** `tools/list` — paginated per MCP 2025-03-26; pass `cursor` back from a prior `nextCursor` to fetch the next page. */
  public async listTools(params: McpToolsListParams = {}): Promise<McpToolsListResult> {
    await this.initialize();
    return this.#send<McpToolsListResult>("tools/list", params);
  }

  /**
   * `tools/call`. Throws {@link McpToolError} when the tool reported failure
   * (`result.isError: true`) — never returns a result the caller has to
   * remember to check `.isError` on. See {@link isMcpGenerationConflict} for
   * the one discriminant callers most often branch on.
   */
  public async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolsCallResult> {
    await this.initialize();
    const params: McpToolsCallParams = { name, arguments: args };
    const result = await this.#send<McpToolsCallResult>("tools/call", params);
    if (result.isError) {
      throw parseToolError(result, name);
    }
    return result;
  }

  async #send<TResult>(method: string, params: unknown): Promise<TResult> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;
    if (this.#auth) {
      const token = await this.#auth.getAccessToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }

    const body = JSON.stringify({ jsonrpc: "2.0", id: nextRequestId(), method, params });

    let response: Response;
    try {
      response = await this.#fetchImpl(`${this.#baseUrl}/mcp`, { method: "POST", headers, body });
    } catch (error) {
      throw new McpTransportError(`Could not reach the MCP endpoint at ${this.#baseUrl}/mcp.`, error);
    }

    const sessionHeader = response.headers.get("mcp-session-id");
    if (sessionHeader) this.#sessionId = sessionHeader;

    if (!response.ok && response.status !== 200) {
      // A handful of honua-server error paths (unauthenticated, malformed
      // envelope) return a non-2xx with no JSON-RPC body at all — surface
      // those as transport failures rather than trying to parse a body that
      // isn't there. A well-formed JSON-RPC error (tool rejected, invalid
      // params) is always HTTP 200 per the spec and is handled below.
      let detail: string | undefined;
      try {
        detail = await response.text();
      } catch {
        detail = undefined;
      }
      throw new McpTransportError(
        `MCP endpoint responded ${response.status} for "${method}"${detail ? `: ${detail}` : "."}`,
      );
    }

    const envelope = await this.#parseResponseBody(response, method);
    if (isJsonRpcErrorResponse(envelope)) {
      throw new McpProtocolError(envelope.error.message, envelope.error.code, envelope.error.data);
    }
    return envelope.result as TResult;
  }

  async #parseResponseBody(response: Response, method: string): Promise<JsonRpcResponse> {
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    if (contentType.includes("text/event-stream")) {
      // A one-shot SSE frame carrying the same JSON-RPC envelope (see the
      // module doc's "Transport response shape" note) — extract the first
      // `data:` line's JSON payload.
      const dataLine = text.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) {
        throw new McpTransportError(`MCP endpoint returned an empty SSE response for "${method}".`);
      }
      return JSON.parse(dataLine.slice("data:".length).trim()) as JsonRpcResponse;
    }
    try {
      return JSON.parse(text) as JsonRpcResponse;
    } catch (error) {
      throw new McpTransportError(`MCP endpoint returned a malformed response for "${method}".`, error);
    }
  }
}

/**
 * Builds an {@link McpToolError} from a `tools/call` result reporting
 * failure. Reads `result.structuredContent` as `{ code, message }` first
 * (this client's primary interpretation of the documented error contract —
 * see `protocol.ts`'s {@link McpStructuredError} doc); falls back to parsing
 * the first text content block as JSON with the same shape; falls back to
 * `code: "unknown"` with the first text block's raw text (or a generic
 * message) rather than ever throwing an unstructured error for a structured
 * failure contract.
 */
function parseToolError(result: McpToolsCallResult, toolName: string): McpToolError {
  const structured = result.structuredContent;
  if (structured && typeof structured.code === "string" && typeof structured.message === "string") {
    return new McpToolError(structured.message, structured.code, toolName, structured);
  }
  const firstText = result.content?.find((block) => block.type === "text")?.text;
  if (firstText) {
    try {
      const parsed = JSON.parse(firstText) as Record<string, unknown>;
      if (typeof parsed.code === "string" && typeof parsed.message === "string") {
        return new McpToolError(parsed.message, parsed.code, toolName, parsed);
      }
    } catch {
      // Not JSON — fall through to the raw-text case below.
    }
    return new McpToolError(firstText, "unknown", toolName, result);
  }
  return new McpToolError(`Tool "${toolName}" failed with no structured error detail.`, "unknown", toolName, result);
}
