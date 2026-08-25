/**
 * REST client for honua-server's Studio package lifecycle API
 * (`docs/internal/admin-api/studio-package-lifecycle.md`, issue #1180) plus
 * the content-item/draft enumeration endpoints (server PR #3014, issue
 * #3003) — every method below corresponds 1:1 to one row of that doc's
 * endpoint table, at `${baseUrl}/v1/studio/...`.
 *
 * ## Why this is not `@honua/sdk-js/studio`'s `HonuaStudioLifecycleClient`
 *
 * The SDK ships a lifecycle client and this app is pinned to a version that
 * has it (honua-studio#30). The composition draft path *does* use it —
 * `./composition-draft-store.ts` puts `HonuaStudioLifecycleClient.drafts`
 * behind the `CompositionDraftStore` seam. This module stays because the
 * console surfaces (`studio-content-browser-element.ts`,
 * `studio-lifecycle-panel-element.ts`) need four things the SDK's client
 * does not have, none of which is a release-timing problem:
 *
 *  1. **The enumeration endpoints.** `GET /content-items` and
 *     `GET /package-drafts` (server PR #3014, issue #3003) are how the
 *     content browser finds an `itemId`/`draftId` in the first place. The
 *     SDK's module doc names this as its own open gap and offers `.raw()`
 *     — an untyped escape hatch — in place of methods. Cursor pagination,
 *     the family/state/owner filters, and the joined publication badge are
 *     all typed here (`lifecycle-types.ts`).
 *  2. **A `changeNote` on save-as-version.** The SDK's
 *     `drafts.createContentVersion` posts no body. The deployed server 400s
 *     a bodyless `POST .../content-versions`, and the change note is what
 *     the panel's "save a version" dialog collects.
 *  3. **The server's DTO fields.** honua-server returns
 *     `StudioPackageDraft.validation` (the panel's status badge),
 *     `persistenceMode`/`durable` at the top of `GET /package-families`, and
 *     `currentSchemaVersion`/`previewSupported`/`publishSupported` per
 *     family. The SDK's projection has none of those as declared members —
 *     they survive only through its index signatures, typed `unknown`, so
 *     adopting it would replace typed reads with casts at every call site.
 *  4. **Refresh-then-retry on a POST.** `HonuaClient` replays a `401` only
 *     for replay-safe methods (`GET`/`HEAD`/`PUT`/`DELETE`). Draft create,
 *     validate, preview-plan, save-as-version, publish and rollback are all
 *     POSTs, and a token that expires mid-session must not turn one of them
 *     into a hard sign-in prompt.
 *
 * Points 1-3 are honua-sdk-js work, not honua-studio work: when the SDK's
 * projection covers the server's DTOs and the enumeration endpoints, this
 * module becomes an adapter the way `./composition-draft-store.ts` already
 * is. Until then it is a complete, independently-typed REST client against
 * `docs/internal/admin-api/studio-package-lifecycle.md`'s endpoint table,
 * built the same way `client/studio-client.ts` and `mcp/client.ts` are: a
 * thin fetch wrapper, no schema-validation dependency, bearer-attached via
 * the same `TokenSource` shape those two already use.
 *
 * ## The human gate (spec REQ-009 — READ BEFORE TOUCHING THIS FILE)
 *
 * {@link StudioLifecycleClient.requestPublish} and
 * {@link StudioLifecycleClient.requestRollback} are the only two methods on
 * this client that widen exposure (move the published pointer, or move
 * current/published back to an earlier version). Per spec REQ-009 ("Publish,
 * share, embed, and any action that widens exposure are HUMAN-CONFIRMED
 * gates the agent can propose but never invoke"), these two methods must
 * ONLY ever be called from a human-confirmed UI interaction —
 * `studio-lifecycle-panel-element.ts`'s typed-confirmation dialog handlers,
 * themselves wired to nothing but a `click` listener on a button inside that
 * element's own shadow DOM. No chat/MCP/tool-call/activity-log event handler
 * anywhere in this package may call either method — `honua_studio_propose_publication`
 * (`mcp/studio-tools.ts`) only ever records `publicationIntent` on a DRAFT
 * via `honua_studio_update_draft`-shaped mutation; it has no reference to
 * this client and cannot reach these two methods even transitively. See
 * `test/lifecycle/human-gate.test.ts`, which asserts this both statically
 * (no `src/mcp/**`, `src/chat/**`, or `src/composition/**` module imports
 * this file) and at runtime (driving `propose_publication` end to end and
 * observing the item's published pointer never moves).
 *
 * @module
 */
import {
  StudioLifecycleConflictError,
  StudioLifecycleError,
  StudioLifecycleSessionExpiredError,
  StudioLifecycleTransportError,
} from "./lifecycle-errors.js";
import type {
  StudioApiResponse,
  StudioContentItemListResponse,
  StudioContentItemQuery,
  StudioContentVersion,
  StudioContentVersionListResponse,
  StudioPackageDraft,
  StudioPackageDraftCreateRequest,
  StudioPackageDraftListResponse,
  StudioPackageDraftQuery,
  StudioPackageDraftReplaceRequest,
  StudioPackageFamilyCapabilities,
  StudioPreviewPlan,
  StudioProblemDetails,
  StudioPublicationRequest,
  StudioPublishRequestInput,
  StudioRollbackRequest,
  StudioRollbackRequestInput,
  StudioValidationSummary,
  StudioVersionComparison,
  StudioVersionComparisonRequest,
} from "./lifecycle-types.js";

/** The minimal token surface this client depends on — matches `client/studio-client.ts`'s/`mcp/client.ts`'s `TokenSource`, satisfied by `AuthSession`. */
export interface TokenSource {
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string | undefined>;
}

export interface StudioLifecycleClientOptions {
  /** Defaults to `"/api"` (matches `StudioClient`/`McpClient`'s default) — requests go to `${baseUrl}/v1/studio/...`. */
  baseUrl?: string;
  auth?: TokenSource;
  /** Override for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

function isProblemDetails(value: unknown): value is StudioProblemDetails {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).title === "string" &&
    typeof (value as Record<string, unknown>).status === "number"
  );
}

function buildQuery(params: Record<string, string | number | readonly string[] | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      search.set(key, value.join(","));
    } else {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

/**
 * A thin fetch wrapper against honua-server's Studio package lifecycle API —
 * see the module doc, especially the "human gate" section, before adding a
 * new call site for {@link requestPublish}/{@link requestRollback}.
 */
export class StudioLifecycleClient {
  readonly #baseUrl: string;
  readonly #auth: TokenSource | undefined;
  readonly #fetchImpl: typeof fetch;

  public constructor(options: StudioLifecycleClientOptions = {}) {
    this.#baseUrl = (options.baseUrl ?? "/api").replace(/\/$/, "");
    this.#auth = options.auth;
    // Bound to globalThis — see mcp/client.ts's identical comment: browser
    // `fetch` is receiver-sensitive, and only the DEFAULT needs binding.
    this.#fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  // -- Capability discovery --------------------------------------------------

  public getPackageFamilies(): Promise<StudioPackageFamilyCapabilities> {
    return this.#request("GET", "/package-families");
  }

  // -- Enumeration (server #3014 / #3003) ------------------------------------

  public listContentItems(query: StudioContentItemQuery = {}): Promise<StudioContentItemListResponse> {
    const qs = buildQuery({
      family: query.families,
      workspaceId: query.workspaceId,
      owner: query.owner,
      state: query.states,
      q: query.q,
      cursor: query.cursor,
      limit: query.limit,
    });
    return this.#request("GET", `/content-items${qs}`);
  }

  public listPackageDrafts(query: StudioPackageDraftQuery = {}): Promise<StudioPackageDraftListResponse> {
    const qs = buildQuery({
      family: query.families,
      workspaceId: query.workspaceId,
      owner: query.owner,
      q: query.q,
      cursor: query.cursor,
      limit: query.limit,
    });
    return this.#request("GET", `/package-drafts${qs}`);
  }

  // -- Drafts (mutable) -------------------------------------------------------

  public createDraft(request: StudioPackageDraftCreateRequest): Promise<StudioPackageDraft> {
    return this.#request("POST", "/package-drafts", request);
  }

  public getDraft(draftId: string): Promise<StudioPackageDraft> {
    return this.#request("GET", `/package-drafts/${encodeURIComponent(draftId)}`);
  }

  public replaceDraft(draftId: string, request: StudioPackageDraftReplaceRequest): Promise<StudioPackageDraft> {
    return this.#request("PUT", `/package-drafts/${encodeURIComponent(draftId)}`, request);
  }

  public async deleteDraft(draftId: string): Promise<void> {
    await this.#request("DELETE", `/package-drafts/${encodeURIComponent(draftId)}`);
  }

  public validateDraft(draftId: string): Promise<StudioValidationSummary> {
    return this.#request("POST", `/package-drafts/${encodeURIComponent(draftId)}/validate`);
  }

  public previewPlan(draftId: string): Promise<StudioPreviewPlan> {
    return this.#request("POST", `/package-drafts/${encodeURIComponent(draftId)}/preview-plan`);
  }

  /**
   * Saves a draft as an immutable content version and advances the item's
   * current pointer. Never publishes — see the module doc. Always sends a
   * JSON object body (empty when there is no change note): the real
   * honua-server endpoint 400s a bodyless POST here (verified against the
   * deployed server; the mock fixture is more permissive), unlike its
   * validate/preview-plan siblings.
   */
  public saveAsVersion(draftId: string, changeNote?: string): Promise<StudioContentVersion> {
    return this.#request(
      "POST",
      `/package-drafts/${encodeURIComponent(draftId)}/content-versions`,
      changeNote !== undefined ? { changeNote } : {},
    );
  }

  // -- Content versions (immutable) --------------------------------------------

  public listVersions(itemId: string): Promise<StudioContentVersionListResponse> {
    return this.#request("GET", `/content-items/${encodeURIComponent(itemId)}/versions`);
  }

  public getVersion(itemId: string, versionId: string): Promise<StudioContentVersion> {
    return this.#request(
      "GET",
      `/content-items/${encodeURIComponent(itemId)}/versions/${encodeURIComponent(versionId)}`,
    );
  }

  public compareVersions(itemId: string, request: StudioVersionComparisonRequest): Promise<StudioVersionComparison> {
    return this.#request("POST", `/content-items/${encodeURIComponent(itemId)}/version-comparisons`, request);
  }

  /** Copies an immutable version into a new mutable draft (`baseVersionId` set). Never publishes or moves a pointer. */
  public reopenVersion(itemId: string, versionId: string): Promise<StudioPackageDraft> {
    return this.#request(
      "POST",
      `/content-items/${encodeURIComponent(itemId)}/versions/${encodeURIComponent(versionId)}/reopen`,
    );
  }

  // -- HUMAN-CONFIRMED GATES (spec REQ-009) ------------------------------------
  // See the module doc's "The human gate" section. Callers: ONLY
  // studio-lifecycle-panel-element.ts's confirm-dialog handlers.

  /**
   * Persists a publication request and, when validation permits, moves the
   * published pointer. REQ-009: call this ONLY from a human-confirmed UI
   * interaction — never from a chat/tool-call/activity-log event handler.
   */
  public requestPublish(
    itemId: string,
    versionId: string,
    request: StudioPublishRequestInput = {},
  ): Promise<StudioPublicationRequest> {
    return this.#request(
      "POST",
      `/content-items/${encodeURIComponent(itemId)}/versions/${encodeURIComponent(versionId)}/publish-requests`,
      request,
    );
  }

  /**
   * Persists a rollback request and moves the current, published, or both
   * pointers to an earlier version. REQ-009: call this ONLY from a
   * human-confirmed UI interaction — never from a chat/tool-call/activity-log
   * event handler.
   */
  public requestRollback(itemId: string, request: StudioRollbackRequestInput): Promise<StudioRollbackRequest> {
    return this.#request("POST", `/content-items/${encodeURIComponent(itemId)}/rollback-requests`, request);
  }

  // -- transport ----------------------------------------------------------------

  async #fetchWithAuth(path: string, method: string, body: unknown, forceRefresh: boolean): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.#auth) {
      const token = await this.#auth.getAccessToken({ forceRefresh });
      if (token) headers.authorization = `Bearer ${token}`;
    }
    return this.#fetchImpl(`${this.#baseUrl}/v1/studio${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.#baseUrl}/v1/studio${path}`;
    let response: Response;
    try {
      response = await this.#fetchWithAuth(path, method, body, false);
    } catch (error) {
      throw new StudioLifecycleTransportError(`Could not reach the Studio lifecycle API at ${url}.`, error);
    }
    if (response.status === 401 && this.#auth) {
      // Single refresh-then-retry — never a second attempt after this one
      // (matches client/studio-client.ts's/mcp/client.ts's documented policy).
      try {
        response = await this.#fetchWithAuth(path, method, body, true);
      } catch (error) {
        throw new StudioLifecycleTransportError(`Could not reach the Studio lifecycle API at ${url}.`, error);
      }
    }
    if (response.status === 401) {
      throw new StudioLifecycleSessionExpiredError(url);
    }
    if (!response.ok) {
      throw await this.#buildError(response);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    const envelope = JSON.parse(text) as StudioApiResponse<T> | { data?: T };
    return (envelope as StudioApiResponse<T>).data as T;
  }

  async #buildError(response: Response): Promise<StudioLifecycleError> {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    const problem = isProblemDetails(parsed) ? parsed : undefined;
    const message = problem?.detail ?? problem?.title ?? `Studio lifecycle API responded ${response.status}.`;
    if (response.status === 409) {
      return new StudioLifecycleConflictError(message, { status: response.status, problem });
    }
    const code = response.status === 404 ? "not-found" : response.status === 400 ? "validation" : "internal";
    return new StudioLifecycleError(code, message, { status: response.status, problem });
  }
}
