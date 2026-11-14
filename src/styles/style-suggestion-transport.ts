/**
 * The host-session transport for authorized style suggestions. Both cookie hosts route
 * `POST /api/v1/admin/metadata/layers/{id}/suggest-style` through the session's bounded
 * fetch, so Studio never holds an administrator credential.
 *
 * The legacy Console BFF answers with `{ binding, suggestion }` built from its own session.
 * The native static Console transport forwards to the server route, which returns the bare
 * suggestion; here the binding is built from the same captured lease, after the body has been
 * read under that lease, so the controller's principal, environment, layer and draft checks
 * hold for both hosts.
 */
import { isCookieSession } from "../auth/host-session.js";
import type { AuthSession, CookieSessionAdapter, SessionAdapter } from "../auth/types.js";
import type { LayerStyleSuggestionOptions } from "./style-suggestion.js";

export const STYLE_SUGGESTION_NEEDS_HOST_SESSION = "Style suggestions need a signed-in Console session.";
const NATIVE_HOST_BASE_URL = "/api/v1/studio";

export interface StyleSuggestionHost {
  /** The current host session adapter; read again on every request. */
  readonly session: () => SessionAdapter | undefined;
  /** The current auth session; its `fetchRequest` is the host's bounded transport. */
  readonly auth: () => Pick<AuthSession, "fetchRequest"> | undefined;
}

export type StyleSuggestionTransportResolution =
  | {
      readonly ok: true;
      readonly principalId: string;
      readonly environmentId: string;
      readonly transport: LayerStyleSuggestionOptions["transport"];
    }
  | { readonly ok: false; readonly reason: string };

/** Resolves the suggestion transport for the current host session, or why there is none. */
export function hostStyleSuggestionTransport(host: StyleSuggestionHost): StyleSuggestionTransportResolution {
  const captured = host.session();
  if (!isCookieSession(captured) || !host.auth()?.fetchRequest)
    return { ok: false, reason: STYLE_SUGGESTION_NEEDS_HOST_SESSION };
  const { principalId, environmentId } = captured;
  const native = captured.baseUrl === NATIVE_HOST_BASE_URL;
  const transport: LayerStyleSuggestionOptions["transport"] = async (canonicalLayerId, init) => {
    requireSameLease(host, captured);
    const fetchRequest = host.auth()?.fetchRequest;
    if (!fetchRequest) throw new Error(STYLE_SUGGESTION_NEEDS_HOST_SESSION);
    if (!Number.isSafeInteger(canonicalLayerId) || canonicalLayerId < 0)
      throw new Error("The canonical layer id is invalid.");
    const path = `/api/v1/admin/metadata/layers/${canonicalLayerId}/suggest-style`;
    const headers = { "content-type": "application/json" };
    if (!native) {
      return fetchRequest(path, {
        method: "POST",
        headers,
        signal: init.signal,
        body: JSON.stringify({ draftRevision: init.draftRevision, composedLayerId: init.composedLayerId }),
      });
    }
    const response = await fetchRequest(path, { method: "POST", headers, signal: init.signal, body: "{}" });
    if (!response.ok) return response;
    const suggestion: unknown = await response.json();
    requireSameLease(host, captured);
    init.signal.throwIfAborted();
    return nativeResponse(suggestion, {
      principalId,
      environmentId,
      canonicalLayerId,
      draftRevision: init.draftRevision,
      composedLayerId: init.composedLayerId,
    });
  };
  return { ok: true, principalId, environmentId, transport };
}

function requireSameLease(host: StyleSuggestionHost, captured: CookieSessionAdapter): CookieSessionAdapter {
  const { principalId, environmentId } = captured;
  const current = host.session();
  if (
    !isCookieSession(current) ||
    current.principalId !== principalId ||
    current.environmentId !== environmentId ||
    current.baseUrl !== captured.baseUrl
  )
    throw new Error("The host session changed.");
  return current;
}

function nativeResponse(
  suggestion: unknown,
  binding: {
    principalId: string;
    environmentId: string;
    canonicalLayerId: number;
    draftRevision: string;
    composedLayerId: string;
  },
): Response {
  return new Response(JSON.stringify({ binding, suggestion }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
