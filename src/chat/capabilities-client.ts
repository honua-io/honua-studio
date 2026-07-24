/**
 * `GET /api/v1/studio/ai/capabilities` (honua-server#3010) — lets a Studio
 * client discover configured providers' context length / tool support
 * without any provider-specific code. Not wired into `<honua-studio-chat>`'s
 * render path yet (out of scope for honua-studio#6's minimal chat console);
 * exposed as a standalone client function so a future revision (or the
 * composition engine, honua-studio#8) can call it without inventing a
 * second bearer-attach/response-envelope implementation.
 */
import type { StudioAiCapabilitiesResponse } from "./ai-contract.js";
import { ChatTransportError } from "./transport.js";
import type { TokenSource } from "./sse-transport.js";

export interface FetchStudioAiCapabilitiesOptions {
  baseUrl?: string;
  auth?: TokenSource;
  fetchImpl?: typeof fetch;
}

interface ApiResponseEnvelope<T> {
  readonly success: boolean;
  readonly data: T;
}

function isEnvelope<T>(value: unknown): value is ApiResponseEnvelope<T> {
  return typeof value === "object" && value !== null && "success" in value && "data" in value;
}

/** Fetches and unwraps the `ApiResponse<StudioAiCapabilitiesResponse>` envelope honua-server#3010's endpoint returns. */
export async function fetchStudioAiCapabilities(
  options: FetchStudioAiCapabilitiesOptions = {},
): Promise<StudioAiCapabilitiesResponse> {
  const baseUrl = options.baseUrl ?? "/api";
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.auth) {
    const token = await options.auth.getAccessToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/studio/ai/capabilities`, { headers });
  } catch (error) {
    throw new ChatTransportError(`Could not reach the Studio AI proxy at ${baseUrl}/v1/studio/ai/capabilities.`, error);
  }
  if (!response.ok) {
    throw new ChatTransportError(`Studio AI capabilities request failed (${response.status}).`);
  }
  const body = (await response.json()) as unknown;
  return isEnvelope<StudioAiCapabilitiesResponse>(body) ? body.data : (body as StudioAiCapabilitiesResponse);
}
