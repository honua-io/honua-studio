/**
 * REST client for honua-server's Studio package lifecycle API
 * (`docs/internal/admin-api/studio-package-lifecycle.md`, issue #1180) plus
 * the content-item/draft enumeration endpoints (server PR #3014, issue
 * #3003) — every method below corresponds 1:1 to one row of that doc's
 * endpoint table, at `${baseUrl}/v1/studio/...`.
 *
 * ## The sdk-js seam (mirrors `composition/history.ts`'s documented pattern)
 *
 * `@honua/sdk-js`'s Studio lifecycle client
 * (`src/studio/lifecycle-client.ts`, `HonuaStudioLifecycleClient`,
 * honua-sdk-js#780) is the eventual real implementation of this surface —
 * but this app's `package.json` pins `@honua/sdk-js@0.1.2-beta.0`, published
 * before that work merged; that version does not export a lifecycle client
 * at all. Rather than block this issue on a republish, this module is a
 * complete, independently-typed REST client against the documented endpoint
 * shapes (`lifecycle-types.ts` mirrors the server DTOs' `[JsonPropertyName]`
 * casing field-for-field), built the same way `client/studio-client.ts` and
 * `mcp/client.ts` are: a thin fetch wrapper, no schema-validation dependency,
 * bearer-attached via the same `TokenSource` shape those two already use.
 *
 * When the SDK republishes with the lifecycle client, every call site in
 * this package (`studio-content-browser-element.ts`,
 * `studio-lifecycle-panel-element.ts`) can swap `StudioLifecycleClient` for
 * a thin adapter with the SAME method names/shapes — nothing here is
 * hand-wavy about the swap because every method already matches
 * `docs/internal/admin-api/studio-package-lifecycle.md`'s table exactly, and
 * the request/response types in `lifecycle-types.ts` already match the
 * server DTOs the SDK will project from the same doc's "SDK Projection
 * Requirements" section.
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
