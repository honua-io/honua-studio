/**
 * Mock honua-server fixture (honua-studio#3 REQ-003, honua-studio#4 REQ-001).
 *
 * A tiny, dependency-free `node:http` server that serves canned Studio
 * catalog/lifecycle JSON and stands in for BOTH honua-server and the OIDC
 * identity provider it delegates to (`Oidc__Generic__Authority` in
 * honua-server's own config) — modeled on honua-sdk-js's
 * examples/*\/mock-server.mjs pattern (plain node:http, no framework,
 * exports a start function and is also directly runnable). No network
 * access; loopback only.
 *
 * Routes (unprefixed — vite.config.ts's dev/preview proxy rewrites
 * /api/* -> * and passes /oidc/* straight through before forwarding, so
 * this fixture and a real honua-server + external IdP (behind
 * HONUA_BASE_URL / HONUA_OIDC_ISSUER) are interchangeable from the
 * client's point of view):
 *   GET  /health                                -> { status, mode }
 *   GET  /v1/studio/catalog                      -> { datasets: CatalogDataset[] }   [bearer required]
 *   GET  /v1/studio/packages                     -> { packages: StudioPackageSummary[] } [bearer required]
 *   GET  /v1/studio/ai/capabilities              -> ApiResponse<StudioAiCapabilitiesResponse> [bearer required]
 *   POST /v1/studio/ai/chat                      -> SSE StudioAiChatEvent stream       [bearer required]
 *   GET  /oidc/.well-known/openid-configuration  -> OIDC discovery document
 *   GET  /oidc/authorize                         -> 302, auto-approves the fixture user (no login UI)
 *   POST /oidc/token                             -> authorization_code exchange + refresh_token ROTATION
 *   POST /oidc/revoke                            -> best-effort refresh-token revocation (RFC 7009)
 *   POST /mcp                                    -> JSON-RPC 2.0 MCP endpoint (honua-studio#7, see below)
 *   GET  /v1/studio/package-families             -> ApiResponse<StudioPackageFamilyCapabilities> [bearer]
 *   GET  /v1/studio/content-items                -> ApiResponse<StudioContentItemListResponse> [bearer]
 *   POST /v1/studio/package-drafts                -> ApiResponse<StudioPackageDraft> [bearer]
 *   GET  /v1/studio/package-drafts                -> ApiResponse<StudioPackageDraftListResponse> [bearer]
 *   GET/PUT/DELETE /v1/studio/package-drafts/{id}  -> ApiResponse<StudioPackageDraft|object> [bearer]
 *   POST /v1/studio/package-drafts/{id}/validate         -> ApiResponse<StudioValidationSummary> [bearer]
 *   POST /v1/studio/package-drafts/{id}/preview-plan     -> ApiResponse<StudioPreviewPlan> [bearer]
 *   POST /v1/studio/package-drafts/{id}/content-versions -> ApiResponse<StudioContentVersion> [bearer]
 *   GET  /v1/studio/content-items/{itemId}/versions              -> ApiResponse<StudioContentVersionListResponse>
 *   GET  /v1/studio/content-items/{itemId}/versions/{versionId}  -> ApiResponse<StudioContentVersion>
 *   POST /v1/studio/content-items/{itemId}/version-comparisons   -> ApiResponse<StudioVersionComparison>
 *   POST /v1/studio/content-items/{itemId}/versions/{versionId}/publish-requests -> ApiResponse<StudioPublicationRequest>
 *   POST /v1/studio/content-items/{itemId}/versions/{versionId}/reopen           -> ApiResponse<StudioPackageDraft>
 *   POST /v1/studio/content-items/{itemId}/rollback-requests                    -> ApiResponse<StudioRollbackRequest>
 *   POST /v1/studio/gp-jobs                      -> ApiResponse<GpJobSnapshot> [bearer] (honua-studio#10)
 *   GET  /v1/studio/gp-jobs/{jobId}               -> ApiResponse<GpJobSnapshot> [bearer]
 *   POST /v1/studio/gp-jobs/{jobId}/cancel        -> ApiResponse<GpJobSnapshot> [bearer]
 *
 * The REST lifecycle + enumeration routes above (honua-studio#9) implement
 * honua-server's `docs/internal/admin-api/studio-package-lifecycle.md`
 * (issue #1180) plus the content-item/draft enumeration endpoints from
 * server PR #3014 (issue #3003) — `src/lifecycle/lifecycle-client.ts` is the
 * typed client that speaks this shape exactly. Successful responses use the
 * documented `ApiResponse<T>` envelope (`{ success, data, timestamp }`);
 * errors use RFC 7807 problem details (`type: "https://honua.io/problems/studio"`).
 * Every lifecycle route requires the same bearer the rest of this fixture's
 * protected routes require (the doc: "require admin authorization in the
 * MVP" — this fixture's one user is always `roles: ["admin"]`, so bearer
 * presence is the only check that matters here).
 *
 * `/mcp` (honua-studio#7) and the REST lifecycle routes above share ONE
 * `createStudioLifecycleStore()` instance per `startMockServer()` call
 * (honua-studio#9 build item 1: "mock-server.mjs gains the REST lifecycle +
 * enumeration endpoints over the same in-memory draft store the /mcp
 * dispatcher uses (ONE store, both surfaces)") — proving spec AD-8
 * coherence in dev mode: a draft an agent mutates through
 * `honua_studio_update_draft` is the exact same record `GET
 * /v1/studio/package-drafts/{draftId}` returns, and `honua_studio_propose_publication`
 * writes `publicationIntent` onto a draft the lifecycle panel's REST client
 * reads back directly, with no second projection anywhere.
 *
 * `/mcp` (honua-studio#7): a minimal JSON-RPC 2.0 dispatcher over the SAME
 * `initialize` / `tools/list` / `tools/call` methods `src/mcp/client.ts`
 * speaks, exposing the 13 `honua_studio_*` tool names honua-server#3002
 * documents (`STUDIO_MCP_TOOL_NAMES` in `src/mcp/studio-tools.ts` — kept a
 * deliberately duplicated literal list here, same reason as
 * `CHAT_EVENT_TYPE_TO_SSE_NAME` above: this file runs under plain `node`,
 * never a TypeScript loader). Backed by the shared in-memory draft store
 * with the exact same optimistic-concurrency contract `FixtureDraftStore`
 * (`src/composition/history.ts`) documents: `generation` starts at `1` on
 * create, increments by exactly `1` on every successful mutation, and a
 * stale `generation` on a mutating call returns a `failed_precondition`
 * tool error rather than silently clobbering a concurrent edit. Composition
 * mutation tools (add/remove layer, set style, set layer visibility, set
 * view, add/remove widget)
 * mirror honua-server's `StudioCompositionBodyEditor` semantics: duplicate
 * ids on add are `invalid_argument`, missing ids on remove/set are
 * `not_found`, and only `map`/`app`-family drafts accept them
 * (`invalid_argument` otherwise). `initialize`/`tools/list` are open per the
 * honua-server MCP doc ("handshake methods are open"); `tools/call` requires
 * the same bearer this file's other protected routes require. CRITICALLY,
 * `honua_studio_propose_publication` (the only publish-adjacent MCP tool)
 * never touches `publicationRequests`/`rollbackRequests`/the item's
 * pointers — it only ever writes `envelope.publicationIntent` onto the
 * draft, exactly mirroring the server's real tool (see server PR #3016) and
 * this repo's spec REQ-009 human gate (`test/lifecycle/human-gate.test.ts`).
 *
 * Auth model (P2-8 review finding): access tokens are short-lived signed
 * JWTs (HS256, dev-only secret — never used outside this loopback fixture);
 * refresh tokens are opaque and single-use — each `refresh_token` grant
 * deletes the presented token and issues a brand-new one, so a stolen or
 * replayed refresh token stops working the moment the legitimate client
 * rotates it. There is no hidden-iframe silent refresh anywhere in this
 * fixture or in src/auth/ — see docs/embed-session.md.
 *
 * The `/v1/studio/ai/chat` route (honua-studio#6, honua-server#3010) plays
 * `src/chat/fixtures/compose-districts-map.json` back turn-by-turn, keyed
 * by how many `role: "user"` messages the client's own accumulated request
 * history contains (this fixture is stateless server-side — the client's
 * own message history IS the turn cursor) — so `npm run dev`'s default
 * `SseChatTransport` (pointed at `/api`, per `<honua-studio-chat>`'s own
 * default) gets a real, scripted SSE conversation end to end, with zero
 * model credentials anywhere. This route deliberately does NOT import
 * anything from `src/` — this file runs under plain `node`, not a
 * TypeScript loader (see scripts/dev-mock.mjs) — so the SSE event-name
 * vocabulary below is a small, intentionally duplicated mirror of
 * `src/chat/ai-contract.ts`'s `CHAT_EVENT_TYPE_TO_SSE_NAME`, and the
 * fixture JSON is read directly via `node:fs`, never through a `.ts` import.
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";

// Mirrors src/chat/ai-contract.ts's CHAT_EVENT_TYPE_TO_SSE_NAME — see this
// file's module doc for why it's a duplicate, not an import.
const CHAT_EVENT_TYPE_TO_SSE_NAME = {
  messageStart: "message_start",
  textDelta: "text_delta",
  toolCallStart: "tool_call_start",
  toolCallDelta: "tool_call_delta",
  toolCallStop: "tool_call_stop",
  messageStop: "message_stop",
  error: "error",
};

const FIXTURE_CONVERSATION = JSON.parse(
  readFileSync(new URL("./src/chat/fixtures/compose-districts-map.json", import.meta.url), "utf8"),
);

const AI_CAPABILITIES = {
  enabled: true,
  defaultProvider: "fixture",
  providers: [
    {
      provider: "fixture",
      kind: "fixture",
      model: "claude-sonnet-4-5-20250929",
      maxTokens: 4096,
      toolSupport: true,
      streaming: true,
      isDefault: true,
      configured: true,
    },
  ],
};

/** Writes one SSE frame exactly as honua-server#3010's `StudioAiProxyEndpoints.WriteSseEventAsync` does: `event: <name>\ndata: <json>\n\n`. */
function writeSseEvent(res, event) {
  const sseName = CHAT_EVENT_TYPE_TO_SSE_NAME[event.type] ?? "message";
  res.write(`event: ${sseName}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ── /mcp: honua_studio_* tool plane (honua-studio#7) ────────────────────────

// Mirrors src/mcp/studio-tools.ts's STUDIO_MCP_TOOL_NAMES — see this file's
// module doc for why it's a duplicate literal, not an import.
const STUDIO_MCP_TOOL_NAMES = [
  "honua_studio_create_draft",
  "honua_studio_get_draft",
  "honua_studio_update_draft",
  "honua_studio_validate_draft",
  "honua_studio_preview_draft",
  "honua_studio_add_layer",
  "honua_studio_remove_layer",
  "honua_studio_set_layer_style",
  "honua_studio_set_layer_visibility",
  "honua_studio_set_view",
  "honua_studio_add_widget",
  "honua_studio_remove_widget",
  "honua_studio_propose_publication",
];

const COMPOSITION_ELIGIBLE_FAMILIES = new Set(["map", "app"]);
const KNOWN_FAMILIES = new Set([
  "query",
  "analysis",
  "map",
  "dashboard",
  "report",
  "form",
  "app",
  "workflow",
  "gp",
  "etl",
]);

function emptyCompositionBody() {
  return { layers: [], view: {}, widgets: [] };
}

function toolSuccess(value) {
  return { structuredContent: value };
}

function toolError(code, message) {
  return { isError: true, structuredContent: { code, message } };
}

// ── Shared Studio lifecycle store (honua-studio#9 build item 1) ────────────
//
// ONE store, both surfaces: `/mcp`'s `honua_studio_*` tools and the REST
// lifecycle + enumeration routes below read/write the exact same
// `drafts`/`items`/`versions`/`publicationRequests`/`rollbackRequests` maps
// — see this file's module doc for why that matters (spec AD-8 coherence).
//
// Field names on every stored record already match the server DTOs'
// camelCase `[JsonPropertyName]`s (`src/lifecycle/lifecycle-types.ts`
// mirrors the same names) so REST responses need no translation; the MCP
// surface's `draftPublic()` below still projects down to the smaller
// `StudioMcpDraft` shape `src/mcp/studio-tools.ts` documents, unchanged from
// before this store was shared.
const FIXTURE_ACTOR = "studio-dev-user";

function createStudioLifecycleStore() {
  const drafts = new Map();
  const items = new Map();
  const versions = new Map();
  const versionsByItem = new Map();
  const publicationRequests = new Map();
  const rollbackRequests = new Map();
  let nextDraftSeq = 1;
  let nextVersionSeq = 1;
  let nextPublicationRequestSeq = 1;
  let nextRollbackRequestSeq = 1;

  function now() {
    return new Date().toISOString();
  }

  /** Creates or refreshes the content item a draft belongs to — called on every draft create/update so `items` always reflects the latest draft's packageKey/workspaceId/family, matching the doc's "(workspaceId, family, packageKey) uniqueness" framing loosely (this mock does not enforce that uniqueness constraint). */
  function touchItem(itemId, { packageKey, workspaceId, family, actor }) {
    const existing = items.get(itemId);
    const ts = now();
    const item = existing
      ? { ...existing, packageKey, workspaceId, family, updatedBy: actor, updatedAt: ts }
      : {
          itemId,
          packageKey,
          workspaceId,
          family,
          currentVersionId: undefined,
          publishedVersionId: undefined,
          createdBy: actor,
          updatedBy: actor,
          createdAt: ts,
          updatedAt: ts,
        };
    items.set(itemId, item);
    return item;
  }

  return {
    drafts,
    items,
    versions,
    versionsByItem,
    publicationRequests,
    rollbackRequests,
    now,
    touchItem,
    nextDraftId: () => `mock-draft-${nextDraftSeq++}`,
    nextVersionId: () => `mock-version-${nextVersionSeq++}`,
    nextPublicationRequestId: () => `mock-publish-request-${nextPublicationRequestSeq++}`,
    nextRollbackRequestId: () => `mock-rollback-request-${nextRollbackRequestSeq++}`,
  };
}

/** JSON-RPC 2.0 method dispatcher for `POST /mcp` (honua-studio#7) — see this file's module doc. Takes the shared {@link createStudioLifecycleStore} instance so its draft mutations are visible to the REST lifecycle routes (honua-studio#9). */
function createMcpDispatcher(store) {
  const drafts = store.drafts;

  function draftPublic(draft) {
    return {
      draftId: draft.draftId,
      itemId: draft.itemId,
      packageKey: draft.packageKey,
      workspaceId: draft.workspaceId,
      ownerId: draft.ownerId,
      generation: draft.generation,
      envelope: draft.envelope,
    };
  }

  function requireDraft(draftId) {
    if (typeof draftId !== "string" || !draftId)
      return { error: toolError("invalid_argument", "'draftId' is required.") };
    const draft = drafts.get(draftId);
    if (!draft) return { error: toolError("not_found", `Studio package draft '${draftId}' was not found.`) };
    return { draft };
  }

  function readBody(draft) {
    const body = draft.envelope.body;
    return body && typeof body === "object" ? body : emptyCompositionBody();
  }

  function ensureCompositionEligible(draft) {
    if (!COMPOSITION_ELIGIBLE_FAMILIES.has(draft.envelope.family)) {
      return toolError(
        "invalid_argument",
        `Composition tools apply only to map/app package families; draft family is '${draft.envelope.family}'.`,
      );
    }
    return undefined;
  }

  /** Generation-checked whole-envelope update — the same store contract `FixtureDraftStore.replace` documents. */
  function applyUpdate(draft, patch, expectedGeneration) {
    if (expectedGeneration === undefined || expectedGeneration === null) {
      return { error: toolError("invalid_argument", "'generation' is required.") };
    }
    if (expectedGeneration !== draft.generation) {
      return {
        error: toolError(
          "failed_precondition",
          `Stale draft generation; refresh and retry. (expected ${draft.generation}, got ${expectedGeneration})`,
        ),
      };
    }
    const updated = {
      ...draft,
      ...patch,
      generation: draft.generation + 1,
      updatedBy: FIXTURE_ACTOR,
      updatedAt: store.now(),
    };
    drafts.set(updated.draftId, updated);
    store.touchItem(updated.itemId, {
      packageKey: updated.packageKey,
      workspaceId: updated.workspaceId,
      family: updated.family,
      actor: FIXTURE_ACTOR,
    });
    return { draft: updated };
  }

  function mutateComposition(draftId, generation, mutate) {
    const { draft, error } = requireDraft(draftId);
    if (error) return error;
    const familyError = ensureCompositionEligible(draft);
    if (familyError) return familyError;
    const body = readBody(draft);
    const outcome = mutate(body);
    if (outcome.error) return outcome.error;
    const envelope = { ...draft.envelope, body: outcome.body };
    const result = applyUpdate(draft, { envelope }, generation);
    if (result.error) return result.error;
    return toolSuccess(draftPublic(result.draft));
  }

  const handlers = {
    honua_studio_create_draft(args) {
      if (!args || typeof args.packageKey !== "string" || !args.packageKey) {
        return toolError("invalid_argument", "'packageKey' is required.");
      }
      if (typeof args.schemaVersion !== "string" || !args.schemaVersion) {
        return toolError("invalid_argument", "'schemaVersion' is required.");
      }
      const family = typeof args.family === "string" ? args.family : "map";
      if (!KNOWN_FAMILIES.has(family)) {
        return toolError(
          "invalid_argument",
          `'family' must be one of: ${[...KNOWN_FAMILIES].join(", ")}. Got '${family}'.`,
        );
      }
      const draftId = args.itemId ? String(args.itemId) : store.nextDraftId();
      const itemId = args.itemId ? String(args.itemId) : draftId;
      const ts = store.now();
      const draft = {
        draftId,
        itemId,
        packageKey: args.packageKey,
        workspaceId: args.workspaceId,
        ownerId: args.ownerId,
        family,
        generation: 1,
        baseVersionId: args.baseVersionId,
        validation: { status: "not-validated", diagnostics: [] },
        createdBy: FIXTURE_ACTOR,
        updatedBy: FIXTURE_ACTOR,
        createdAt: ts,
        updatedAt: ts,
        envelope: {
          family,
          schemaVersion: args.schemaVersion,
          body: args.body ?? (COMPOSITION_ELIGIBLE_FAMILIES.has(family) ? emptyCompositionBody() : undefined),
        },
      };
      drafts.set(draftId, draft);
      store.touchItem(itemId, {
        packageKey: draft.packageKey,
        workspaceId: draft.workspaceId,
        family,
        actor: FIXTURE_ACTOR,
      });
      return toolSuccess(draftPublic(draft));
    },

    honua_studio_get_draft(args) {
      const { draft, error } = requireDraft(args?.draftId);
      if (error) return error;
      return toolSuccess(draftPublic(draft));
    },

    honua_studio_update_draft(args) {
      const { draft, error } = requireDraft(args?.draftId);
      if (error) return error;
      if (typeof args.packageKey !== "string" || !args.packageKey) {
        return toolError("invalid_argument", "'packageKey' is required.");
      }
      if (typeof args.schemaVersion !== "string" || !args.schemaVersion) {
        return toolError("invalid_argument", "'schemaVersion' is required.");
      }
      const envelope = {
        ...draft.envelope,
        schemaVersion: args.schemaVersion,
        format: args.format ?? draft.envelope.format,
        body: args.body !== undefined ? args.body : draft.envelope.body,
      };
      const result = applyUpdate(
        draft,
        {
          packageKey: args.packageKey,
          workspaceId: args.workspaceId ?? draft.workspaceId,
          ownerId: args.ownerId ?? draft.ownerId,
          envelope,
        },
        args.generation,
      );
      if (result.error) return result.error;
      return toolSuccess(draftPublic(result.draft));
    },

    honua_studio_validate_draft(args) {
      const { draft, error } = requireDraft(args?.draftId);
      if (error) return error;
      // Persists the validation summary onto the STORED draft — "ONE store,
      // both surfaces" (this file's module doc): an agent driving validation
      // via this tool must leave the draft in the SAME state the REST
      // `/validate` endpoint below would (honua-studio#10's GP job submit
      // guard reads exactly this field — see `/gp-jobs` POST below).
      const validation = { status: "valid", diagnostics: [], unsupportedCapabilities: [], generatedAt: store.now() };
      drafts.set(draft.draftId, {
        ...draft,
        validation,
        envelope: { ...draft.envelope, validation },
        updatedAt: store.now(),
      });
      return toolSuccess({ isValid: true, diagnostics: [] });
    },

    honua_studio_preview_draft(args) {
      const { draft, error } = requireDraft(args?.draftId);
      if (error) return error;
      // Mirrors the REST `/preview-plan` endpoint's shape AND side effect
      // below (honua-studio#9/#10) exactly — "ONE store, both surfaces"
      // extends to preview-plan too: an agent driving preview via
      // `honua_studio_preview_draft` sees the SAME requiresJob/steps a human
      // driving `<honua-studio-gp-panel>` via the REST client sees, and
      // leaves the draft in the same validated state the REST path would
      // (so the GP job submit guard below accepts either path).
      const validation = { status: "valid", diagnostics: [], unsupportedCapabilities: [], generatedAt: store.now() };
      drafts.set(draft.draftId, {
        ...draft,
        validation,
        envelope: { ...draft.envelope, validation },
        updatedAt: store.now(),
      });
      const jobBacked = draft.family === "gp" || draft.family === "etl" || draft.family === "workflow";
      return toolSuccess({
        draftId: draft.draftId,
        family: draft.family,
        synchronous: !jobBacked,
        requiresJob: jobBacked,
        steps: jobBacked
          ? ["validate-envelope", "plan-background-preview-job"]
          : ["validate-envelope", "prepare-inline-preview"],
        kind: "preview",
        planningOnly: jobBacked,
      });
    },

    honua_studio_add_layer(args) {
      if (!args?.layer || typeof args.layer !== "object" || typeof args.layer.id !== "string" || !args.layer.id) {
        return toolError("invalid_argument", "'layer' is required.");
      }
      return mutateComposition(args.draftId, args.generation, (body) => {
        if (body.layers.some((existing) => existing.id === args.layer.id)) {
          return {
            error: toolError(
              "invalid_argument",
              `A layer with id '${args.layer.id}' already exists in the composition.`,
            ),
          };
        }
        const layer = { visible: true, ...args.layer };
        const layers = [...body.layers];
        const insertAt = args.beforeId ? layers.findIndex((existing) => existing.id === args.beforeId) : -1;
        if (insertAt < 0) layers.push(layer);
        else layers.splice(insertAt, 0, layer);
        return { body: { ...body, layers } };
      });
    },

    honua_studio_remove_layer(args) {
      if (typeof args?.layerId !== "string" || !args.layerId) {
        return toolError("invalid_argument", "'layerId' is required.");
      }
      return mutateComposition(args.draftId, args.generation, (body) => {
        if (!body.layers.some((existing) => existing.id === args.layerId)) {
          return { error: toolError("not_found", `No layer with id '${args.layerId}' exists in the composition.`) };
        }
        return { body: { ...body, layers: body.layers.filter((existing) => existing.id !== args.layerId) } };
      });
    },

    honua_studio_set_layer_style(args) {
      if (typeof args?.layerId !== "string" || !args.layerId) {
        return toolError("invalid_argument", "'layerId' is required.");
      }
      return mutateComposition(args.draftId, args.generation, (body) => {
        const index = body.layers.findIndex((existing) => existing.id === args.layerId);
        if (index < 0) {
          return { error: toolError("not_found", `No layer with id '${args.layerId}' exists in the composition.`) };
        }
        const layers = [...body.layers];
        layers[index] = { ...layers[index], styleRef: args.styleRef ?? undefined };
        return { body: { ...body, layers } };
      });
    },

    /** honua-server#3199 (landed in honua-server PR #3207): `{ draftId, generation, layerId, visible }`, all four required, `additionalProperties: false`. */
    honua_studio_set_layer_visibility(args) {
      if (typeof args?.layerId !== "string" || !args.layerId) {
        return toolError("invalid_argument", "'layerId' is required.");
      }
      if (typeof args?.visible !== "boolean") {
        return toolError("invalid_argument", "'visible' is required and must be a boolean.");
      }
      return mutateComposition(args.draftId, args.generation, (body) => {
        const index = body.layers.findIndex((existing) => existing.id === args.layerId);
        if (index < 0) {
          return { error: toolError("not_found", `No layer with id '${args.layerId}' exists in the composition.`) };
        }
        const layers = [...body.layers];
        layers[index] = { ...layers[index], visible: args.visible };
        return { body: { ...body, layers } };
      });
    },

    honua_studio_set_view(args) {
      if (!args?.view || typeof args.view !== "object") {
        return toolError("invalid_argument", "'view' is required.");
      }
      return mutateComposition(args.draftId, args.generation, (body) => ({ body: { ...body, view: args.view } }));
    },

    honua_studio_add_widget(args) {
      if (
        !args?.widget ||
        typeof args.widget.id !== "string" ||
        !args.widget.id ||
        typeof args.widget.kind !== "string" ||
        !args.widget.kind
      ) {
        return toolError("invalid_argument", "'widget.id' and 'widget.kind' are required.");
      }
      return mutateComposition(args.draftId, args.generation, (body) => {
        if (body.widgets.some((existing) => existing.id === args.widget.id)) {
          return {
            error: toolError(
              "invalid_argument",
              `A widget with id '${args.widget.id}' already exists in the composition.`,
            ),
          };
        }
        return { body: { ...body, widgets: [...body.widgets, args.widget] } };
      });
    },

    honua_studio_remove_widget(args) {
      if (typeof args?.widgetId !== "string" || !args.widgetId) {
        return toolError("invalid_argument", "'widgetId' is required.");
      }
      return mutateComposition(args.draftId, args.generation, (body) => {
        if (!body.widgets.some((existing) => existing.id === args.widgetId)) {
          return { error: toolError("not_found", `No widget with id '${args.widgetId}' exists in the composition.`) };
        }
        return { body: { ...body, widgets: body.widgets.filter((existing) => existing.id !== args.widgetId) } };
      });
    },

    honua_studio_propose_publication(args) {
      const { draft, error } = requireDraft(args?.draftId);
      if (error) return error;
      const publicationIntent = {
        route: args.route,
        visibility: args.visibility,
        embed: args.embed,
        service: args.service,
        schedule: args.schedule,
        job: args.job,
        note: args.note,
      };
      const envelope = { ...draft.envelope, publicationIntent };
      const result = applyUpdate(draft, { envelope }, args.generation);
      if (result.error) return result.error;
      return toolSuccess({
        draft: draftPublic(result.draft),
        recorded: true,
        humanConfirmationRequired: true,
        message: "Publication intent recorded for human review. No publish/share/embed action was taken.",
      });
    },
  };

  return {
    /** `initialize` / `tools/list` are open (no bearer) per the honua-server MCP doc; `tools/call` is dispatched to `handlers` above. Returns `{ status, body }` — `status` lets the route handler decide HTTP status/session-id headers uniformly. */
    handle(method, params) {
      if (method === "initialize") {
        return {
          result: { protocolVersion: "2025-03-26", serverInfo: { name: "honua-studio-mock-mcp", version: "0.0.0" } },
        };
      }
      if (method === "tools/list") {
        return {
          result: {
            tools: STUDIO_MCP_TOOL_NAMES.map((name) => ({
              name,
              inputSchema: { type: "object" },
            })),
          },
        };
      }
      if (method === "tools/call") {
        const name = params?.name;
        const handler = typeof name === "string" ? handlers[name] : undefined;
        if (!handler) {
          return { error: { code: -32602, message: `Unknown tool "${name}".` } };
        }
        return { result: handler(params?.arguments ?? {}) };
      }
      return { error: { code: -32601, message: `Method not found: "${method}".` } };
    },
  };
}

// ── Studio package lifecycle REST + enumeration routes (honua-studio#9) ────
//
// Implements `docs/internal/admin-api/studio-package-lifecycle.md`
// (honua-server issue #1180) plus the `GET /content-items` / `GET
// /package-drafts` enumeration endpoints from server PR #3014 (issue
// #3003), over the SAME `store` `/mcp`'s dispatcher above uses (see this
// file's module doc — "ONE store, both surfaces"). `src/lifecycle/lifecycle-client.ts`
// is the typed client this router is built to satisfy exactly.

const STUDIO_LIFECYCLE_PROBLEM_TYPE = "https://honua.io/problems/studio";
const STUDIO_CONTENT_ITEM_STATES = new Set(["draft", "current", "published"]);
const STUDIO_ROLLBACK_POINTERS = new Set(["current", "published", "both"]);
const FAMILY_FORMATS = {
  query: "studio_query_package.v1",
  analysis: "studio_analysis_package.v1",
  map: "honua_map_package.v1",
  dashboard: "studio_dashboard_package.v1",
  report: "studio_report_package.v1",
  form: "studio_form_package.v1",
  app: "honua_app_package.v1",
  workflow: "studio_workflow_package.v1",
  gp: "studio_gp_package.v1",
  etl: "studio_etl_package.v1",
};
/** `map`/`app` get family-specific validators on a real server ("supportLevel: supported"); every other family is envelope-only ("limited") — matches the doc's "Package Envelope" section exactly. */
const DEEP_VALIDATED_FAMILIES = new Set(["map", "app"]);

function apiResponse(res, status, data) {
  json(res, status, { success: true, data, timestamp: new Date().toISOString() });
}

/** RFC 7807 problem response, `type: "https://honua.io/problems/studio"` — the doc's documented error shape for every 400/404/409/500 this router returns. */
function problemResponse(res, status, title, detail) {
  const body = { type: STUDIO_LIFECYCLE_PROBLEM_TYPE, title, status, ...(detail ? { detail } : {}) };
  res.writeHead(status, {
    "content-type": "application/problem+json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}

function trailingSeq(id) {
  const match = /(\d+)$/.exec(String(id ?? ""));
  return match ? Number(match[1]) : 0;
}

/** Orders DESC by `updatedAt`, then DESC by the id's trailing numeric sequence (falling back to string compare) — the same stable tiebreak the doc's enumeration section documents (REQ-001: "pages stay stable even as other rows are concurrently created or updated"). */
function compareEnumerationOrder(aUpdatedAt, aId, bUpdatedAt, bId) {
  if (aUpdatedAt !== bUpdatedAt) return aUpdatedAt < bUpdatedAt ? 1 : -1;
  const aSeq = trailingSeq(aId);
  const bSeq = trailingSeq(bId);
  if (aSeq !== bSeq) return aSeq < bSeq ? 1 : -1;
  return aId < bId ? 1 : aId > bId ? -1 : 0;
}

function encodeCursor(updatedAt, id) {
  return Buffer.from(JSON.stringify([updatedAt, id])).toString("base64url");
}

function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const [updatedAt, id] = Array.isArray(parsed) ? parsed : [];
    return typeof updatedAt === "string" && typeof id === "string" ? { updatedAt, id } : undefined;
  } catch {
    return undefined;
  }
}

/** Opaque keyset-cursor pagination over an already-unsorted record array — see the doc's "Content Item And Draft Enumeration" section. Returns `{ invalidCursor: true }` for a cursor this fixture can't decode. */
function paginateEnumeration(records, { cursor, limit, idOf, updatedAtOf }) {
  const sorted = [...records].sort((a, b) => compareEnumerationOrder(updatedAtOf(a), idOf(a), updatedAtOf(b), idOf(b)));
  let startIndex = 0;
  if (cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) return { invalidCursor: true };
    startIndex = sorted.findIndex(
      (record) => compareEnumerationOrder(updatedAtOf(record), idOf(record), decoded.updatedAt, decoded.id) > 0,
    );
    if (startIndex === -1) startIndex = sorted.length;
  }
  const page = sorted.slice(startIndex, startIndex + limit);
  const last = page[page.length - 1];
  const hasMore = startIndex + limit < sorted.length;
  return {
    items: page,
    total: sorted.length,
    nextCursor: hasMore && last ? encodeCursor(updatedAtOf(last), idOf(last)) : null,
  };
}

function parseFamiliesParam(raw) {
  if (!raw) return { families: undefined };
  const families = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const unknown = families.find((family) => !KNOWN_FAMILIES.has(family));
  return unknown ? { invalid: unknown } : { families };
}

function clampLimit(raw) {
  const parsed = raw ? Number(raw) : 25;
  if (!Number.isFinite(parsed) || parsed < 1) return 25;
  return Math.min(Math.trunc(parsed), 1000);
}

function draftRestPublic(draft) {
  return {
    draftId: draft.draftId,
    itemId: draft.itemId,
    packageKey: draft.packageKey,
    workspaceId: draft.workspaceId,
    ownerId: draft.ownerId,
    family: draft.family,
    envelope: draft.envelope,
    validation: draft.validation,
    baseVersionId: draft.baseVersionId,
    generation: draft.generation,
    createdBy: draft.createdBy,
    updatedBy: draft.updatedBy,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

function itemState(item) {
  if (item.publishedVersionId) return "published";
  if (item.currentVersionId) return "current";
  return "draft";
}

function computeContentHash(envelope) {
  // Excludes volatile validation timestamps, per the doc: "computes a
  // SHA-256 contentHash that excludes volatile validation timestamps".
  const { validation, ...rest } = envelope;
  const stableValidation = validation
    ? {
        status: validation.status,
        diagnostics: validation.diagnostics ?? [],
        unsupportedCapabilities: validation.unsupportedCapabilities ?? [],
      }
    : undefined;
  return createHash("sha256")
    .update(JSON.stringify({ ...rest, validation: stableValidation }))
    .digest("hex");
}

/** Envelope-level validation only — see `DEEP_VALIDATED_FAMILIES`; this mock never runs `honua_map_package.v1`/`honua_app_package.v1` body validation (that is real honua-server behavior this fixture does not reproduce). */
function runValidation() {
  return { status: "valid", diagnostics: [], unsupportedCapabilities: [], generatedAt: new Date().toISOString() };
}

function createStudioLifecycleRestRouter(store) {
  function versionsForItem(itemId) {
    const ids = store.versionsByItem.get(itemId) ?? [];
    return ids.map((id) => store.versions.get(id)).filter(Boolean);
  }

  function itemSummary(item) {
    const summary = {
      itemId: item.itemId,
      packageKey: item.packageKey,
      workspaceId: item.workspaceId,
      family: item.family,
      state: itemState(item),
      currentVersionId: item.currentVersionId,
      publishedVersionId: item.publishedVersionId,
      createdBy: item.createdBy,
      updatedBy: item.updatedBy,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
    // Simplified same-store publication badge synthesis (honua-studio#9):
    // this fixture does not stand up a separate Content Publication
    // Registry store, so the badge is derived straight from the item's own
    // `publishedVersionId` rather than joined from a second store the way
    // the doc's "Publication-Registry Lifecycle Badge" section describes.
    // Good enough to exercise the content browser's badge rendering; NOT a
    // claim that this mock reproduces the registry's own route lifecycle.
    if (item.publishedVersionId) {
      const publishedVersion = store.versions.get(item.publishedVersionId);
      summary.publication = {
        publicationId: `mock-publication-${item.itemId}`,
        routeSlug: `studio/${item.packageKey}`,
        routePath: `/api/v1/published/studio/${item.packageKey}`,
        lifecycle: "active",
        activeRevision: publishedVersion ? publishedVersion.versionNumber : 1,
        updatedAt: item.updatedAt,
      };
    }
    return summary;
  }

  function packageFamilyCapabilities() {
    const families = [...KNOWN_FAMILIES].map((family) => ({
      family,
      currentSchemaVersion: "1.0",
      format: FAMILY_FORMATS[family],
      supportLevel: DEEP_VALIDATED_FAMILIES.has(family) ? "supported" : "limited",
      supportedOperations: [
        "draft.create",
        "draft.read",
        "draft.update",
        "validate",
        "preview-plan",
        "content-version.create",
        "content-version.read",
        "content-version.compare",
        "publish-request.create",
        "reopen",
        "rollback",
      ],
      validationDepth: DEEP_VALIDATED_FAMILIES.has(family) ? "package" : "envelope",
      limitations: DEEP_VALIDATED_FAMILIES.has(family) ? [] : ["Envelope-level validation only in this deployment."],
      maxPackageBytes: 1048576,
      previewSupported: true,
      publishSupported: true,
    }));
    return { persistenceMode: "in-memory", durable: false, families };
  }

  function requireDraftOr404(draftId, res) {
    const draft = store.drafts.get(draftId);
    if (!draft) {
      problemResponse(res, 404, "Studio package draft not found", `No draft with id '${draftId}' exists.`);
      return undefined;
    }
    return draft;
  }

  function requireItemOr404(itemId, res) {
    const item = store.items.get(itemId);
    if (!item) {
      problemResponse(res, 404, "Studio content item not found", `No content item with id '${itemId}' exists.`);
      return undefined;
    }
    return item;
  }

  function requireVersionOr404(itemId, versionId, res) {
    const version = store.versions.get(versionId);
    // Routes with both {itemId} and {versionId} are an ownership boundary
    // (doc: "a version that exists under a different content item is
    // handled as not found") — a cross-item version id 404s exactly like a
    // missing one.
    if (!version || version.itemId !== itemId) {
      problemResponse(
        res,
        404,
        "Studio content version not found",
        `No version '${versionId}' exists under item '${itemId}'.`,
      );
      return undefined;
    }
    return version;
  }

  function saveDraftAsVersion(draft, changeNote) {
    const validation = runValidation();
    const envelope = { ...draft.envelope, validation };
    const contentHash = computeContentHash(envelope);
    const versionId = store.nextVersionId();
    const versionNumber = versionsForItem(draft.itemId).length + 1;
    const ts = store.now();
    const version = {
      itemId: draft.itemId,
      packageKey: draft.packageKey,
      workspaceId: draft.workspaceId,
      ownerId: draft.ownerId,
      versionId,
      versionNumber,
      contentHash,
      envelope,
      validation,
      dependencies: envelope.dependencies ?? [],
      provenance: envelope.provenance ?? [],
      sourceDraftId: draft.draftId,
      baseVersionId: draft.baseVersionId,
      changeNote,
      createdBy: FIXTURE_ACTOR,
      createdAt: ts,
    };
    store.versions.set(versionId, version);
    store.versionsByItem.set(draft.itemId, [...(store.versionsByItem.get(draft.itemId) ?? []), versionId]);
    // "Saving a draft as a content version revalidates the draft... and
    // advances the content item's current pointer" (doc) — also bumps the
    // draft's own generation, matching "save-as-version calls persist the
    // latest validation summary back onto the draft and therefore also
    // advance the draft generation."
    const item = store.touchItem(draft.itemId, {
      packageKey: draft.packageKey,
      workspaceId: draft.workspaceId,
      family: draft.family,
      actor: FIXTURE_ACTOR,
    });
    store.items.set(draft.itemId, { ...item, currentVersionId: versionId, updatedAt: ts });
    store.drafts.set(draft.draftId, {
      ...draft,
      envelope,
      validation,
      generation: draft.generation + 1,
      updatedBy: FIXTURE_ACTOR,
      updatedAt: ts,
    });
    return version;
  }

  function compareVersionRecords(left, right) {
    const changes = [];
    const contentEqual = left.contentHash === right.contentHash;
    if (!contentEqual) changes.push("content");
    const dependenciesEqual = JSON.stringify(left.dependencies ?? []) === JSON.stringify(right.dependencies ?? []);
    if (!dependenciesEqual) changes.push("dependencies");
    const validationEqual = JSON.stringify(left.validation) === JSON.stringify(right.validation);
    if (!validationEqual) changes.push("validation");
    const provenanceEqual = JSON.stringify(left.provenance ?? []) === JSON.stringify(right.provenance ?? []);
    if (!provenanceEqual) changes.push("provenance");
    return { contentEqual, dependenciesEqual, validationEqual, provenanceEqual, changes };
  }

  /**
   * Routes one already-bearer-checked request. `subPath` has the
   * `/v1/studio` prefix already stripped (e.g. `/package-drafts`).  Returns
   * `true` once it has written a response (matched, whether success or
   * error), `false` if nothing here matches (caller falls through to its
   * own 404).
   */
  async function handle(req, res, method, subPath, searchParams) {
    // GET /package-families
    if (method === "GET" && subPath === "/package-families") {
      apiResponse(res, 200, packageFamilyCapabilities());
      return true;
    }

    // GET /content-items (enumeration)
    if (method === "GET" && subPath === "/content-items") {
      const familiesResult = parseFamiliesParam(searchParams.get("family"));
      if (familiesResult.invalid) {
        problemResponse(res, 400, "Invalid family filter", `Unknown package family '${familiesResult.invalid}'.`);
        return true;
      }
      const statesRaw = searchParams.get("state");
      let states;
      if (statesRaw) {
        states = statesRaw
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        const unknownState = states.find((state) => !STUDIO_CONTENT_ITEM_STATES.has(state));
        if (unknownState) {
          problemResponse(res, 400, "Invalid state filter", `Unknown content item state '${unknownState}'.`);
          return true;
        }
      }
      const workspaceId = searchParams.get("workspaceId") ?? undefined;
      const owner = searchParams.get("owner") ?? undefined;
      const q = searchParams.get("q")?.toLowerCase();
      const limit = clampLimit(searchParams.get("limit"));
      const cursor = searchParams.get("cursor") ?? undefined;

      const filtered = [...store.items.values()].filter((item) => {
        if (familiesResult.families && !familiesResult.families.includes(item.family)) return false;
        if (workspaceId !== undefined && item.workspaceId !== workspaceId) return false;
        // Ownership stand-in per the doc: filters on the item's recorded
        // creator (createdBy) until honua-server#3001 lands per-item
        // ownership.
        if (owner !== undefined && item.createdBy !== owner) return false;
        if (states && !states.includes(itemState(item))) return false;
        if (q && !item.packageKey.toLowerCase().includes(q)) return false;
        return true;
      });
      const page = paginateEnumeration(filtered, {
        cursor,
        limit,
        idOf: (item) => item.itemId,
        updatedAtOf: (item) => item.updatedAt,
      });
      if (page.invalidCursor) {
        problemResponse(res, 400, "Invalid cursor", "The 'cursor' parameter could not be decoded.");
        return true;
      }
      apiResponse(res, 200, { items: page.items.map(itemSummary), total: page.total, nextCursor: page.nextCursor });
      return true;
    }

    // GET /package-drafts (enumeration) / POST /package-drafts (create)
    if (subPath === "/package-drafts" && method === "GET") {
      const familiesResult = parseFamiliesParam(searchParams.get("family"));
      if (familiesResult.invalid) {
        problemResponse(res, 400, "Invalid family filter", `Unknown package family '${familiesResult.invalid}'.`);
        return true;
      }
      const workspaceId = searchParams.get("workspaceId") ?? undefined;
      const owner = searchParams.get("owner") ?? undefined;
      const q = searchParams.get("q")?.toLowerCase();
      const limit = clampLimit(searchParams.get("limit"));
      const cursor = searchParams.get("cursor") ?? undefined;

      const filtered = [...store.drafts.values()].filter((draft) => {
        if (familiesResult.families && !familiesResult.families.includes(draft.family)) return false;
        if (workspaceId !== undefined && draft.workspaceId !== workspaceId) return false;
        if (owner !== undefined && draft.ownerId !== owner) return false;
        if (q && !draft.packageKey.toLowerCase().includes(q)) return false;
        return true;
      });
      const page = paginateEnumeration(filtered, {
        cursor,
        limit,
        idOf: (draft) => draft.draftId,
        updatedAtOf: (draft) => draft.updatedAt,
      });
      if (page.invalidCursor) {
        problemResponse(res, 400, "Invalid cursor", "The 'cursor' parameter could not be decoded.");
        return true;
      }
      apiResponse(res, 200, { items: page.items.map(draftRestPublic), total: page.total, nextCursor: page.nextCursor });
      return true;
    }

    if (subPath === "/package-drafts" && method === "POST") {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        problemResponse(res, 400, "Malformed request body", "Request body must be valid JSON.");
        return true;
      }
      const { packageKey, workspaceId, ownerId, itemId, envelope } = body ?? {};
      if (typeof packageKey !== "string" || !packageKey.trim()) {
        problemResponse(res, 400, "Invalid request", "'packageKey' is required.");
        return true;
      }
      const trimmedKey = packageKey.trim();
      if (trimmedKey.length > 200 || !/^[A-Za-z0-9._-]+$/.test(trimmedKey)) {
        problemResponse(
          res,
          400,
          "Invalid request",
          "'packageKey' must be <=200 characters of letters, numbers, dash, underscore, or dot.",
        );
        return true;
      }
      if (!envelope || typeof envelope !== "object" || typeof envelope.family !== "string") {
        problemResponse(res, 400, "Invalid request", "'envelope.family' is required.");
        return true;
      }
      if (!KNOWN_FAMILIES.has(envelope.family)) {
        problemResponse(res, 400, "Invalid request", `Unknown package family '${envelope.family}'.`);
        return true;
      }
      const draftId = store.nextDraftId();
      const resolvedItemId = itemId ? String(itemId) : draftId;
      const ts = store.now();
      const draft = {
        draftId,
        itemId: resolvedItemId,
        packageKey: trimmedKey,
        workspaceId: workspaceId || undefined,
        ownerId: ownerId || undefined,
        family: envelope.family,
        envelope,
        validation: envelope.validation ?? { status: "not-validated", diagnostics: [] },
        baseVersionId: undefined,
        generation: 1,
        createdBy: FIXTURE_ACTOR,
        updatedBy: FIXTURE_ACTOR,
        createdAt: ts,
        updatedAt: ts,
      };
      store.drafts.set(draftId, draft);
      store.touchItem(resolvedItemId, {
        packageKey: draft.packageKey,
        workspaceId: draft.workspaceId,
        family: draft.family,
        actor: FIXTURE_ACTOR,
      });
      apiResponse(res, 201, draftRestPublic(draft));
      return true;
    }

    // /package-drafts/{draftId}(/...)
    const draftMatch = /^\/package-drafts\/([^/]+)(\/.*)?$/.exec(subPath);
    if (draftMatch) {
      const draftId = decodeURIComponent(draftMatch[1]);
      const rest = draftMatch[2] ?? "";

      if (rest === "" && method === "GET") {
        const draft = requireDraftOr404(draftId, res);
        if (draft) apiResponse(res, 200, draftRestPublic(draft));
        return true;
      }

      if (rest === "" && method === "PUT") {
        const draft = requireDraftOr404(draftId, res);
        if (!draft) return true;
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          problemResponse(res, 400, "Malformed request body", "Request body must be valid JSON.");
          return true;
        }
        const { packageKey, workspaceId, ownerId, envelope, generation } = body ?? {};
        if (typeof packageKey !== "string" || !packageKey.trim()) {
          problemResponse(res, 400, "Invalid request", "'packageKey' is required.");
          return true;
        }
        if (!envelope || typeof envelope !== "object") {
          problemResponse(res, 400, "Invalid request", "'envelope' is required.");
          return true;
        }
        // Omitting `generation` updates from the current draft generation
        // loaded by the server (doc) — only a MISMATCHED explicit value 409s.
        if (generation !== undefined && generation !== draft.generation) {
          problemResponse(
            res,
            409,
            "Stale draft generation",
            `Expected generation ${draft.generation}, received ${generation}. Reload the draft and retry.`,
          );
          return true;
        }
        const ts = store.now();
        const updated = {
          ...draft,
          packageKey: packageKey.trim(),
          workspaceId: workspaceId || undefined,
          ownerId: ownerId ?? draft.ownerId,
          family: envelope.family ?? draft.family,
          envelope,
          generation: draft.generation + 1,
          updatedBy: FIXTURE_ACTOR,
          updatedAt: ts,
        };
        store.drafts.set(draftId, updated);
        store.touchItem(updated.itemId, {
          packageKey: updated.packageKey,
          workspaceId: updated.workspaceId,
          family: updated.family,
          actor: FIXTURE_ACTOR,
        });
        apiResponse(res, 200, draftRestPublic(updated));
        return true;
      }

      if (rest === "" && method === "DELETE") {
        if (!requireDraftOr404(draftId, res)) return true;
        store.drafts.delete(draftId);
        json(res, 200, {
          success: true,
          message: "Studio package draft deleted.",
          timestamp: new Date().toISOString(),
        });
        return true;
      }

      if (rest === "/validate" && method === "POST") {
        const draft = requireDraftOr404(draftId, res);
        if (!draft) return true;
        const validation = runValidation();
        store.drafts.set(draftId, {
          ...draft,
          validation,
          envelope: { ...draft.envelope, validation },
          generation: draft.generation + 1,
          updatedAt: store.now(),
        });
        apiResponse(res, 200, validation);
        return true;
      }

      if (rest === "/preview-plan" && method === "POST") {
        const draft = requireDraftOr404(draftId, res);
        if (!draft) return true;
        const validation = runValidation();
        const jobBacked = draft.family === "gp" || draft.family === "etl" || draft.family === "workflow";
        store.drafts.set(draftId, {
          ...draft,
          validation,
          envelope: { ...draft.envelope, validation },
          generation: draft.generation + 1,
          updatedAt: store.now(),
        });
        apiResponse(res, 200, {
          draftId,
          family: draft.family,
          synchronous: !jobBacked,
          requiresJob: jobBacked,
          steps: jobBacked
            ? ["validate-envelope", "plan-background-preview-job"]
            : ["validate-envelope", "prepare-inline-preview"],
          validation,
        });
        return true;
      }

      if (rest === "/content-versions" && method === "POST") {
        const draft = requireDraftOr404(draftId, res);
        if (!draft) return true;
        let body = {};
        try {
          const text = await readBody(req);
          body = text ? JSON.parse(text) : {};
        } catch {
          problemResponse(res, 400, "Malformed request body", "Request body must be valid JSON.");
          return true;
        }
        const version = saveDraftAsVersion(draft, typeof body.changeNote === "string" ? body.changeNote : undefined);
        apiResponse(res, 201, version);
        return true;
      }
    }

    // /content-items/{itemId}(/...)
    const itemMatch = /^\/content-items\/([^/]+)(\/.*)?$/.exec(subPath);
    if (itemMatch) {
      const itemId = decodeURIComponent(itemMatch[1]);
      const rest = itemMatch[2] ?? "";

      if (rest === "/versions" && method === "GET") {
        if (!requireItemOr404(itemId, res)) return true;
        apiResponse(res, 200, { itemId, versions: versionsForItem(itemId) });
        return true;
      }

      const versionMatch = /^\/versions\/([^/]+)(\/.*)?$/.exec(rest);
      if (versionMatch) {
        const versionId = decodeURIComponent(versionMatch[1]);
        const versionRest = versionMatch[2] ?? "";

        if (versionRest === "" && method === "GET") {
          if (!requireItemOr404(itemId, res)) return true;
          const version = requireVersionOr404(itemId, versionId, res);
          if (version) apiResponse(res, 200, version);
          return true;
        }

        if (versionRest === "/publish-requests" && method === "POST") {
          if (!requireItemOr404(itemId, res)) return true;
          const version = requireVersionOr404(itemId, versionId, res);
          if (!version) return true;
          let body = {};
          try {
            const text = await readBody(req);
            body = text ? JSON.parse(text) : {};
          } catch {
            problemResponse(res, 400, "Malformed request body", "Request body must be valid JSON.");
            return true;
          }
          const intent = body.intent ?? version.envelope.publicationIntent ?? undefined;
          const status = version.validation?.status === "invalid" ? "rejected" : "accepted";
          const requestId = store.nextPublicationRequestId();
          const ts = store.now();
          const request = {
            requestId,
            itemId,
            versionId,
            intent,
            status,
            validation: version.validation,
            warningAcknowledgement:
              typeof body.warningAcknowledgement === "string" ? body.warningAcknowledgement : undefined,
            requestedBy: FIXTURE_ACTOR,
            createdAt: ts,
          };
          store.publicationRequests.set(requestId, request);
          if (status === "accepted") {
            const item = requireItemOr404(itemId, res);
            store.items.set(itemId, {
              ...item,
              publishedVersionId: versionId,
              updatedBy: FIXTURE_ACTOR,
              updatedAt: ts,
            });
          }
          apiResponse(res, 201, request);
          return true;
        }

        if (versionRest === "/reopen" && method === "POST") {
          if (!requireItemOr404(itemId, res)) return true;
          const version = requireVersionOr404(itemId, versionId, res);
          if (!version) return true;
          const draftId = store.nextDraftId();
          const ts = store.now();
          const draft = {
            draftId,
            itemId,
            packageKey: version.packageKey,
            workspaceId: version.workspaceId,
            ownerId: version.ownerId,
            family: version.envelope.family,
            envelope: version.envelope,
            validation: version.validation,
            baseVersionId: versionId,
            generation: 1,
            createdBy: FIXTURE_ACTOR,
            updatedBy: FIXTURE_ACTOR,
            createdAt: ts,
            updatedAt: ts,
          };
          store.drafts.set(draftId, draft);
          apiResponse(res, 201, draftRestPublic(draft));
          return true;
        }
      }

      if (rest === "/version-comparisons" && method === "POST") {
        if (!requireItemOr404(itemId, res)) return true;
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          problemResponse(res, 400, "Malformed request body", "Request body must be valid JSON.");
          return true;
        }
        const left = requireVersionOr404(itemId, body?.leftVersionId, res);
        if (!left) return true;
        const right = requireVersionOr404(itemId, body?.rightVersionId, res);
        if (!right) return true;
        const comparison = compareVersionRecords(left, right);
        apiResponse(res, 200, {
          leftVersionId: left.versionId,
          rightVersionId: right.versionId,
          ...comparison,
        });
        return true;
      }

      if (rest === "/rollback-requests" && method === "POST") {
        const item = requireItemOr404(itemId, res);
        if (!item) return true;
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          problemResponse(res, 400, "Malformed request body", "Request body must be valid JSON.");
          return true;
        }
        const { targetVersionId, pointer, reason } = body ?? {};
        const target = requireVersionOr404(itemId, targetVersionId, res);
        if (!target) return true;
        if (typeof pointer !== "string" || !STUDIO_ROLLBACK_POINTERS.has(pointer)) {
          problemResponse(res, 400, "Invalid request", "'pointer' must be one of: current, published, both.");
          return true;
        }
        const ts = store.now();
        const nextItem = { ...item, updatedBy: FIXTURE_ACTOR, updatedAt: ts };
        if (pointer === "current" || pointer === "both") nextItem.currentVersionId = targetVersionId;
        if (pointer === "published" || pointer === "both") nextItem.publishedVersionId = targetVersionId;
        store.items.set(itemId, nextItem);
        const requestId = store.nextRollbackRequestId();
        const request = {
          requestId,
          itemId,
          targetVersionId,
          pointer,
          pointers: {
            itemId,
            currentVersionId: nextItem.currentVersionId,
            publishedVersionId: nextItem.publishedVersionId,
          },
          requestedBy: FIXTURE_ACTOR,
          reason: typeof reason === "string" ? reason : undefined,
          createdAt: ts,
        };
        store.rollbackRequests.set(requestId, request);
        apiResponse(res, 201, request);
        return true;
      }
    }

    return false;
  }

  return { handle };
}

// ── GP async batch-execution job surface (honua-studio#10 REQ-003) ─────────
//
// `/v1/studio/gp-jobs` — this fixture's stand-in for honua-server's
// not-yet-real GP batch job endpoint (see `src/gp/job-client.ts`'s module
// doc's "the seam" section). Deliberately shaped to match
// `@honua/sdk-js`'s canonical async-operation vocabulary
// (`src/contract/jobs.ts`'s `JobStatus`: accepted -> running -> a terminal
// state) rather than inventing a new one — `src/gp/gp-types.ts`'s
// `GpJobStatus` is that exact five-value union.
//
// State machine (deterministic, keyed by a per-job `pollCount` — same
// pattern `examples/geoprocessing-job-runner`'s own fixture process client
// uses): `accepted` on submit, `running` on the first `GET` status poll,
// `successful` from the second poll onward (idempotent — outputs are
// registered into `catalogDatasets` exactly once, on the transition, not on
// every subsequent poll). `simulateFailure: true` on submit forces the
// second poll to `failed` instead, with a diagnostic `error` — the fixture
// hook `test/gp/*.test.ts` uses to prove "failures surface diagnostics
// honestly" without a flaky real failure. `cancel` is idempotent: a job
// already in a terminal state returns that SAME terminal snapshot
// unchanged (mirrors `IJobRun.cancel()`'s documented race-tolerant
// contract), never overwrites a `successful`/`failed` outcome with
// `dismissed`.
function createGpJobStore() {
  const jobs = new Map();
  let nextJobSeq = 1;
  return { jobs, nextJobId: () => `mock-gp-job-${nextJobSeq++}` };
}

function gpJobOutputsForDraft(draft) {
  const body = draft.envelope.body && typeof draft.envelope.body === "object" ? draft.envelope.body : {};
  const declared = Array.isArray(body.outputs) ? body.outputs : [];
  if (declared.length === 0) return [{ id: "result", title: `${draft.packageKey} result` }];
  return declared;
}

/** Computes (and, on the successful-transition, persists catalog registration for) a job record's current snapshot. Never mutates `pollCount` itself — the GET route handler owns that increment so `cancel`/other read paths can observe status without advancing the state machine. */
function computeGpJobSnapshot(record, studioLifecycleStore, catalogDatasets) {
  if (record.override) return record.override;
  if (record.pollCount >= 2) {
    if (record.simulateFailure) {
      return {
        jobId: record.jobId,
        draftId: record.draftId,
        status: "failed",
        progress: { percent: 60, message: "Execution failed.", updatedAt: new Date().toISOString() },
        error: {
          code: "ProcessExecutionFailed",
          message: `Batch execution of '${record.draftId}' failed while running the operation graph (fixture: simulateFailure).`,
          details: { draftId: record.draftId },
        },
        ...(record.parameters ? { parameters: record.parameters } : {}),
      };
    }
    if (!record.registeredOutputs) {
      const draft = studioLifecycleStore.drafts.get(record.draftId);
      const declared = draft ? gpJobOutputsForDraft(draft) : [{ id: "result", title: "result" }];
      record.registeredOutputs = declared.map((output) => {
        const datasetId = `gp-output-${record.jobId}-${output.id}`;
        catalogDatasets.push({
          id: datasetId,
          title: output.title ?? output.id,
          protocol: "honua-gp-output",
          geometryType: output.geometryType ?? "Unknown",
          lineage: { jobId: record.jobId, draftId: record.draftId },
        });
        return { outputId: output.id, datasetId, title: output.title ?? output.id };
      });
    }
    return {
      jobId: record.jobId,
      draftId: record.draftId,
      status: "successful",
      progress: { percent: 100, message: "Batch execution complete.", updatedAt: new Date().toISOString() },
      result: { outputs: record.registeredOutputs },
      ...(record.parameters ? { parameters: record.parameters } : {}),
    };
  }
  if (record.pollCount >= 1) {
    return {
      jobId: record.jobId,
      draftId: record.draftId,
      status: "running",
      progress: { percent: 45, message: "Running the operation graph.", updatedAt: new Date().toISOString() },
      ...(record.parameters ? { parameters: record.parameters } : {}),
    };
  }
  return {
    jobId: record.jobId,
    draftId: record.draftId,
    status: "accepted",
    progress: { percent: 5, message: "Queued for batch execution.", updatedAt: new Date().toISOString() },
    ...(record.parameters ? { parameters: record.parameters } : {}),
  };
}

function createGpJobRestRouter(gpJobStore, studioLifecycleStore, catalogDatasets) {
  async function handle(req, res, method, subPath) {
    if (subPath === "/gp-jobs" && method === "POST") {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        problemResponse(res, 400, "Malformed request body", "Request body must be valid JSON.");
        return true;
      }
      const { draftId, versionId, parameters, simulateFailure } = body ?? {};
      if (typeof draftId !== "string" || !draftId) {
        problemResponse(res, 400, "Invalid request", "'draftId' is required.");
        return true;
      }
      const draft = studioLifecycleStore.drafts.get(draftId);
      if (!draft) {
        problemResponse(res, 404, "Studio package draft not found", `No draft with id '${draftId}' exists.`);
        return true;
      }
      if (draft.family !== "gp") {
        problemResponse(
          res,
          400,
          "Invalid request",
          `Batch execution applies only to 'gp'-family drafts; draft family is '${draft.family}'.`,
        );
        return true;
      }
      // REQ-002/REQ-006: execution is offered only after a confirmed preview
      // plan — this mock's own honest proxy for that is requiring the draft
      // to have been through /validate or /preview-plan at least once
      // (either sets `draft.validation` to something other than
      // "not-validated" — see the `/validate` and `/preview-plan` handlers
      // above). This does not itself enforce the human-confirmation step —
      // that discipline lives entirely client-side (THE HUMAN GATE,
      // `src/gp/job-client.ts`'s module doc) — it only refuses to accept a
      // submission for a draft nobody has ever asked the server about.
      const validationStatus = draft.validation?.status ?? "not-validated";
      if (validationStatus === "not-validated") {
        problemResponse(
          res,
          400,
          "Draft has not been validated",
          "Call validate or preview-plan on this draft before submitting it for batch execution.",
        );
        return true;
      }
      if (versionId !== undefined && typeof versionId !== "string") {
        problemResponse(res, 400, "Invalid request", "'versionId' must be a string when present.");
        return true;
      }
      if (
        parameters !== undefined &&
        (typeof parameters !== "object" || parameters === null || Array.isArray(parameters))
      ) {
        problemResponse(res, 400, "Invalid request", "'parameters' must be an object when present.");
        return true;
      }
      const jobId = gpJobStore.nextJobId();
      const record = {
        jobId,
        draftId,
        versionId: typeof versionId === "string" ? versionId : undefined,
        parameters: parameters && typeof parameters === "object" ? parameters : undefined,
        simulateFailure: simulateFailure === true,
        pollCount: 0,
        registeredOutputs: undefined,
        override: undefined,
      };
      gpJobStore.jobs.set(jobId, record);
      apiResponse(res, 201, computeGpJobSnapshot(record, studioLifecycleStore, catalogDatasets));
      return true;
    }

    const jobMatch = /^\/gp-jobs\/([^/]+)(\/.*)?$/.exec(subPath);
    if (jobMatch) {
      const jobId = decodeURIComponent(jobMatch[1]);
      const rest = jobMatch[2] ?? "";
      const record = gpJobStore.jobs.get(jobId);
      if (!record) {
        problemResponse(res, 404, "Studio GP job not found", `No GP job with id '${jobId}' exists.`);
        return true;
      }

      if (rest === "" && method === "GET") {
        // Poll-driven state machine: THIS call advances `pollCount`, never a
        // background timer (NFR-001: deterministic, no timers — every
        // transition is caller-driven, exactly like `GpJobClient.status()`'s
        // own doc promises).
        if (!record.override) record.pollCount += 1;
        apiResponse(res, 200, computeGpJobSnapshot(record, studioLifecycleStore, catalogDatasets));
        return true;
      }

      if (rest === "/cancel" && method === "POST") {
        const current = computeGpJobSnapshot(record, studioLifecycleStore, catalogDatasets);
        if (current.status === "successful" || current.status === "failed" || current.status === "dismissed") {
          // Idempotent race-tolerant cancel — see this section's module doc.
          apiResponse(res, 200, current);
          return true;
        }
        record.override = {
          jobId,
          draftId: record.draftId,
          status: "dismissed",
          progress: { percent: 100, message: "Cancelled.", updatedAt: new Date().toISOString() },
          ...(record.parameters ? { parameters: record.parameters } : {}),
        };
        apiResponse(res, 200, record.override);
        return true;
      }
    }

    return false;
  }

  return { handle };
}

// ── Fixture feature data (honua-studio#23) ──────────────────────────────────
//
// honua-studio#23 REQ-001 asks for a map that *visibly mutates* as tool calls
// stream. The catalog above advertises four datasets but this fixture served
// no geometry for any of them, so before this change an offline "add the
// parcels layer" produced a correct composition and an empty map — the exact
// gap the issue was filed about.
//
// So the fixture now serves features, the same way a real honua-server does:
// OGC API – Features (`/ogc/collections/{id}/items`) for the `ogc-features`
// datasets and a GeoServices `/query?f=geojson` for the FeatureServer one.
// The geometry is **generated, not copied** — a deterministic grid over Oʻahu,
// clearly synthetic, sized so the whole collection fits in one bounded
// response. Nothing here claims to be real parcel data; it is fixture data
// with a plausible shape, which is what makes the fixture journey both
// legible and byte-stable (REQ-005).

/** Bounding box the fixture datasets are generated inside: Oʻahu, where `compose-districts-map` composes. */
const FIXTURE_EXTENT = { west: -158.28, south: 21.25, east: -157.65, north: 21.72 };

const FIXTURE_DISTRICTS = ["Honolulu", "ʻEwa", "Koʻolaupoko", "Wahiawā"];
const FIXTURE_ZONING_CODES = ["R-5", "B-2", "AG-1", "P-2"];

function fixtureLongitude(column, columns) {
  return FIXTURE_EXTENT.west + ((FIXTURE_EXTENT.east - FIXTURE_EXTENT.west) * column) / columns;
}

function fixtureLatitude(row, rows) {
  return FIXTURE_EXTENT.south + ((FIXTURE_EXTENT.north - FIXTURE_EXTENT.south) * row) / rows;
}

function round6(value) {
  return Number(value.toFixed(6));
}

/** 8x6 grid of rectangular "parcels", each tagged with the district/zoning fields `compose-districts-map` styles and charts by. */
function buildFixtureParcels() {
  const columns = 8;
  const rows = 6;
  const features = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const west = fixtureLongitude(column + 0.1, columns);
      const east = fixtureLongitude(column + 0.9, columns);
      const south = fixtureLatitude(row + 0.1, rows);
      const north = fixtureLatitude(row + 0.9, rows);
      const index = row * columns + column;
      features.push({
        type: "Feature",
        id: index + 1,
        properties: {
          parcel_id: `TMK-${String(index + 1).padStart(4, "0")}`,
          district: FIXTURE_DISTRICTS[(row + column) % FIXTURE_DISTRICTS.length],
          zoning_code: FIXTURE_ZONING_CODES[index % FIXTURE_ZONING_CODES.length],
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [round6(west), round6(south)],
              [round6(east), round6(south)],
              [round6(east), round6(north)],
              [round6(west), round6(north)],
              [round6(west), round6(south)],
            ],
          ],
        },
      });
    }
  }
  return features;
}

/** Six road centerlines: three running east-west, three north-south. */
function buildFixtureRoads() {
  const features = [];
  for (let index = 0; index < 3; index += 1) {
    const latitude = fixtureLatitude(index * 2 + 1, 6);
    features.push({
      type: "Feature",
      id: index + 1,
      properties: { route: `Route ${index + 1}`, surface: index === 0 ? "asphalt" : "concrete" },
      geometry: {
        type: "LineString",
        coordinates: [
          [round6(FIXTURE_EXTENT.west), round6(latitude)],
          [round6(FIXTURE_EXTENT.east), round6(latitude)],
        ],
      },
    });
  }
  for (let index = 0; index < 3; index += 1) {
    const longitude = fixtureLongitude(index * 2 + 1, 6);
    features.push({
      type: "Feature",
      id: index + 4,
      properties: { route: `Belt ${index + 1}`, surface: "asphalt" },
      geometry: {
        type: "LineString",
        coordinates: [
          [round6(longitude), round6(FIXTURE_EXTENT.south)],
          [round6(longitude), round6(FIXTURE_EXTENT.north)],
        ],
      },
    });
  }
  return features;
}

/** Twenty monitoring wells on a 5x4 lattice. */
function buildFixtureWells() {
  const features = [];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      const index = row * 5 + column;
      features.push({
        type: "Feature",
        id: index + 1,
        properties: {
          well_id: `WELL-${String(index + 1).padStart(3, "0")}`,
          chloride_mg_l: 40 + ((index * 17) % 180),
        },
        geometry: {
          type: "Point",
          coordinates: [round6(fixtureLongitude(column + 0.5, 5)), round6(fixtureLatitude(row + 0.5, 4))],
        },
      });
    }
  }
  return features;
}

/** Built once per process — deterministic, so two runs serve byte-identical responses. */
const FIXTURE_FEATURES = {
  "hi-parcels": buildFixtureParcels(),
  "hi-roads": buildFixtureRoads(),
  "hi-wells": buildFixtureWells(),
};

/** `hi-imagery` is deliberately absent: it is the raster/STAC dataset the composition map reports as not renderable, and that path needs to stay exercised. */
export function fixtureFeatureCollection(collectionId, limit) {
  const features = FIXTURE_FEATURES[collectionId];
  if (!features) return undefined;
  const bounded = typeof limit === "number" && limit > 0 ? features.slice(0, limit) : features;
  return {
    type: "FeatureCollection",
    features: bounded,
    numberMatched: features.length,
    numberReturned: bounded.length,
  };
}

const CATALOG = {
  datasets: [
    { id: "hi-parcels", title: "Hawai'i statewide parcels", protocol: "ogc-features", geometryType: "Polygon" },
    {
      id: "hi-roads",
      title: "Hawai'i road centerlines",
      protocol: "geoservices-feature-service",
      geometryType: "LineString",
    },
    { id: "hi-wells", title: "Groundwater monitoring wells", protocol: "ogc-features", geometryType: "Point" },
    { id: "hi-imagery", title: "Statewide orthoimagery (COG)", protocol: "stac", geometryType: "Raster" },
  ],
};

const PACKAGES = {
  packages: [
    {
      id: "pkg-composing-districts",
      family: "map",
      format: "honua_map_package.v1",
      status: "Composing",
      title: "Operations districts overview",
      updatedAt: "2026-07-20T18:04:00Z",
    },
    {
      id: "pkg-draft-wells",
      family: "query",
      format: "honua_query_package.v1",
      status: "Draft",
      title: "Wells below threshold",
      updatedAt: "2026-07-21T09:12:00Z",
    },
    {
      id: "pkg-ready-dashboard",
      family: "dashboard",
      format: "honua_dashboard_package.v1",
      status: "Ready",
      title: "Statewide roads condition dashboard",
      updatedAt: "2026-07-18T14:47:00Z",
    },
  ],
};

/** Public client the mock IdP accepts — matches src/auth/config.ts's dev default. */
export const OIDC_CLIENT_ID = "honua-studio-dev";

/** The fixture user the mock authorize endpoint auto-approves; never a login prompt. */
const FIXTURE_USER = {
  sub: "studio-dev-user",
  name: "Dev User",
  email: "dev@honua.io",
  roles: ["admin"],
};

const ACCESS_TOKEN_TTL_SECONDS = 60;
const AUTHORIZATION_CODE_TTL_MS = 60_000;

// Loopback-only dev fixture secret. Real deployments never see this — a real
// honua-server validates bearer tokens against its configured OIDC
// provider's JWKS (Oidc__Generic__Authority), not against this constant.
const DEV_ONLY_JWT_SECRET = "honua-studio-mock-oidc-dev-secret-not-for-production";

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signFixtureJwt(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", DEV_ONLY_JWT_SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Verifies signature + expiry; returns the decoded payload, or null. */
function verifyFixtureJwt(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, signature] = parts;
  const expected = createHmac("sha256", DEV_ONLY_JWT_SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  if (!timingSafeEqualStrings(signature, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return null;
  return payload;
}

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    // Permissive CORS: this is a loopback dev fixture, never deployed. The
    // authorize/token endpoints are reached cross-origin (their absolute
    // URLs come from the discovery document, not the studio app's own
    // origin/proxy), so CORS must be open for the token exchange fetch.
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    ...extraHeaders,
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function unauthorized(res) {
  json(res, 401, { error: { code: 401, message: "Unauthorized" } }, { "www-authenticate": "Bearer" });
}

/**
 * Starts the fixture server on an ephemeral loopback port.
 * @returns {Promise<{ server: import("node:http").Server, url: string, close: () => Promise<void> }>}
 */
export async function startMockServer({ port = 0 } = {}) {
  // Pending authorization codes -> { codeChallenge, redirectUri, expiresAt }.
  const pendingCodes = new Map();
  // Active (unrotated) refresh tokens -> true. Deleted the moment they're
  // spent, so replaying a rotated-out refresh token always 400s.
  const activeRefreshTokens = new Set();
  // The shared Studio lifecycle store (honua-studio#9 build item 1): one
  // instance per server, read/written by BOTH `/mcp`'s `honua_studio_*`
  // tools and the REST lifecycle + enumeration routes below. See this
  // file's module doc for why that sharing is load-bearing (spec AD-8).
  const studioLifecycleStore = createStudioLifecycleStore();
  const studioLifecycleRest = createStudioLifecycleRestRouter(studioLifecycleStore);
  // /mcp (honua-studio#7): a set of live `Mcp-Session-Id`s per server
  // instance, matching honua-server's "a session is bound at initialize"
  // contract (docs/guides/connect/ai-agents-mcp.md).
  const mcp = createMcpDispatcher(studioLifecycleStore);
  const mcpSessions = new Set();
  // Per-instance mutable catalog (honua-studio#10 REQ-004): starts as a copy
  // of the static CATALOG.datasets fixture below and gains one entry per GP
  // job output on job completion — never mutates the shared module-level
  // CATALOG constant itself, so one test's completed job can never leak a
  // registered dataset into a different `startMockServer()` instance.
  const catalogDatasets = CATALOG.datasets.map((dataset) => ({ ...dataset }));
  const gpJobStore = createGpJobStore();
  const gpJobRest = createGpJobRestRouter(gpJobStore, studioLifecycleStore, catalogDatasets);

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = requestUrl.pathname;
    const issuer = `http://${req.headers.host}/oidc`;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization",
      });
      res.end();
      return;
    }

    // ── OIDC discovery ──────────────────────────────────────────
    if (pathname === "/oidc/.well-known/openid-configuration" && req.method === "GET") {
      json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        revocation_endpoint: `${issuer}/revoke`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        id_token_signing_alg_values_supported: ["HS256"],
        scopes_supported: ["openid", "profile", "email", "honua.read", "honua.write"],
      });
      return;
    }

    // ── OIDC: authorization endpoint (auto-approves the fixture user) ──
    if (pathname === "/oidc/authorize" && req.method === "GET") {
      const params = requestUrl.searchParams;
      const clientId = params.get("client_id");
      const redirectUri = params.get("redirect_uri");
      const state = params.get("state") ?? "";
      const codeChallenge = params.get("code_challenge");
      const method = params.get("code_challenge_method");
      if (clientId !== OIDC_CLIENT_ID || !redirectUri || !codeChallenge || method !== "S256") {
        json(res, 400, { error: "invalid_request" });
        return;
      }
      const code = randomUUID();
      pendingCodes.set(code, {
        codeChallenge,
        redirectUri,
        expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS,
      });
      const location = new URL(redirectUri);
      location.searchParams.set("code", code);
      location.searchParams.set("state", state);
      res.writeHead(302, { location: location.toString() });
      res.end();
      return;
    }

    // ── OIDC: token endpoint (code exchange + refresh-token rotation) ──
    if (pathname === "/oidc/token" && req.method === "POST") {
      const body = new URLSearchParams(await readBody(req));
      const grantType = body.get("grant_type");

      if (grantType === "authorization_code") {
        const code = body.get("code") ?? "";
        const verifier = body.get("code_verifier") ?? "";
        const pending = pendingCodes.get(code);
        pendingCodes.delete(code); // single-use regardless of outcome
        const challenge = await webCryptoPkceChallenge(verifier);
        if (
          !pending ||
          pending.expiresAt < Date.now() ||
          body.get("client_id") !== OIDC_CLIENT_ID ||
          challenge !== pending.codeChallenge
        ) {
          json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
          return;
        }
        const refreshToken = randomUUID();
        activeRefreshTokens.add(refreshToken);
        json(res, 200, issueTokenResponse({ issuer, refreshToken, scope: body.get("scope") }));
        return;
      }

      if (grantType === "refresh_token") {
        const presented = body.get("refresh_token") ?? "";
        if (body.get("client_id") !== OIDC_CLIENT_ID || !activeRefreshTokens.has(presented)) {
          json(res, 400, { error: "invalid_grant", error_description: "unknown or already-rotated refresh token" });
          return;
        }
        // Rotation: the presented token is spent unconditionally, and a
        // fresh one takes its place — replaying `presented` after this
        // point always fails, even if the response below is lost in
        // flight (fail-closed, matches P2-8's rotation requirement).
        activeRefreshTokens.delete(presented);
        const rotated = randomUUID();
        activeRefreshTokens.add(rotated);
        json(res, 200, issueTokenResponse({ issuer, refreshToken: rotated, scope: body.get("scope") }));
        return;
      }

      json(res, 400, { error: "unsupported_grant_type" });
      return;
    }

    // ── OIDC: revocation endpoint (RFC 7009, best-effort) ───────
    if (pathname === "/oidc/revoke" && req.method === "POST") {
      const body = new URLSearchParams(await readBody(req));
      activeRefreshTokens.delete(body.get("token") ?? "");
      json(res, 200, {});
      return;
    }

    // ── Protected Studio API routes ─────────────────────────────
    if (pathname === "/v1/studio/catalog" && req.method === "GET") {
      if (!verifyFixtureJwt(bearerToken(req))) {
        unauthorized(res);
        return;
      }
      json(res, 200, { datasets: catalogDatasets });
      return;
    }
    if (pathname === "/v1/studio/packages" && req.method === "GET") {
      if (!verifyFixtureJwt(bearerToken(req))) {
        unauthorized(res);
        return;
      }
      json(res, 200, PACKAGES);
      return;
    }
    if (pathname === "/v1/studio/ai/capabilities" && req.method === "GET") {
      if (!verifyFixtureJwt(bearerToken(req))) {
        unauthorized(res);
        return;
      }
      json(res, 200, { success: true, data: AI_CAPABILITIES });
      return;
    }
    // ── Studio AI proxy: fixture chat SSE stream (honua-studio#6) ──
    if (pathname === "/v1/studio/ai/chat" && req.method === "POST") {
      if (!verifyFixtureJwt(bearerToken(req))) {
        unauthorized(res);
        return;
      }
      let requestBody;
      try {
        requestBody = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "invalid_request", message: "Malformed JSON body." });
        return;
      }
      const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
      if (messages.length === 0) {
        json(res, 400, { error: "invalid_request", message: "At least one message is required." });
        return;
      }
      const turnIndex = messages.filter((m) => m?.role === "user").length - 1;
      const turn = FIXTURE_CONVERSATION.turns[turnIndex];

      // Tracks a REAL client disconnect (the response socket closing), not
      // `req.destroyed` — that flips true the moment `readBody()` above
      // finishes draining the request body (Node's `Readable` streams
      // auto-destroy on `'end'`), which happens on every normal request and
      // has nothing to do with whether the client is still there for the
      // response half.
      let clientDisconnected = false;
      res.once("close", () => {
        clientDisconnected = true;
      });

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        pragma: "no-cache",
        "access-control-allow-origin": "*",
      });
      if (!turn) {
        writeSseEvent(res, {
          type: "error",
          errorMessage: `mock-server fixture: no scripted turn ${turnIndex} in "${FIXTURE_CONVERSATION.id}".`,
        });
        res.end();
        return;
      }
      for (const event of turn.assistant.events) {
        if (clientDisconnected) break; // client disconnected/aborted mid-stream — matches the real proxy's cancellation convention
        writeSseEvent(res, event);
      }
      res.end();
      return;
    }
    // ── MCP tool plane (honua-studio#7) ─────────────────────────
    if (pathname === "/mcp" && req.method === "POST") {
      let request;
      try {
        request = JSON.parse(await readBody(req));
      } catch {
        json(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      if (Array.isArray(request)) {
        // Batching `initialize` is invalid per the honua-server doc; this
        // fixture doesn't otherwise support JSON-RPC batches.
        json(res, 200, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Batched requests are not supported by this fixture." },
        });
        return;
      }
      const { id, method, params } = request ?? {};
      if (typeof method !== "string") {
        json(res, 200, { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "Invalid Request" } });
        return;
      }

      // A presented Mcp-Session-Id must be one this fixture actually minted
      // (honua-server doc: "validates it on every later request"; an
      // expired/unknown id returns 404 so clients re-initialize cleanly).
      // Session id validation is opt-in from the CLIENT's side here — a
      // caller that never sends the header (or hasn't initialized yet) is
      // still served; this fixture doesn't itself require every call to
      // carry one, only that a PRESENTED one be real.
      const presentedSession = req.headers["mcp-session-id"];
      if (typeof presentedSession === "string" && presentedSession && !mcpSessions.has(presentedSession)) {
        json(res, 404, {
          jsonrpc: "2.0",
          id: id ?? null,
          error: { code: -32001, message: "Unknown or expired Mcp-Session-Id." },
        });
        return;
      }

      // Handshake methods are open; tools/call requires the same bearer
      // every other protected route on this fixture requires.
      if (method === "tools/call" && !verifyFixtureJwt(bearerToken(req))) {
        unauthorized(res);
        return;
      }

      const outcome = mcp.handle(method, params);
      const extraHeaders = {};
      if (method === "initialize") {
        const sessionId = randomUUID();
        mcpSessions.add(sessionId);
        extraHeaders["mcp-session-id"] = sessionId;
      }
      const envelope =
        outcome.error !== undefined
          ? { jsonrpc: "2.0", id: id ?? null, error: outcome.error }
          : { jsonrpc: "2.0", id: id ?? null, result: outcome.result };
      json(res, 200, envelope, extraHeaders);
      return;
    }

    // ── Studio package lifecycle REST + enumeration (honua-studio#9) ────
    if (pathname.startsWith("/v1/studio/") || pathname === "/v1/studio") {
      const subPath = pathname.slice("/v1/studio".length) || "/";
      // Every lifecycle route requires the same bearer the rest of this
      // fixture's protected routes require (doc: "require admin
      // authorization in the MVP") — checked ONCE here rather than in every
      // branch of `studioLifecycleRest.handle`.
      const knownLifecyclePrefix =
        subPath === "/package-families" ||
        subPath === "/content-items" ||
        subPath.startsWith("/content-items/") ||
        subPath === "/package-drafts" ||
        subPath.startsWith("/package-drafts/");
      if (knownLifecyclePrefix) {
        if (!verifyFixtureJwt(bearerToken(req))) {
          unauthorized(res);
          return;
        }
        const handled = await studioLifecycleRest.handle(req, res, req.method, subPath, requestUrl.searchParams);
        if (handled) return;
      }

      // ── GP async batch-execution job surface (honua-studio#10) ─────────
      const knownGpJobPrefix = subPath === "/gp-jobs" || subPath.startsWith("/gp-jobs/");
      if (knownGpJobPrefix) {
        if (!verifyFixtureJwt(bearerToken(req))) {
          unauthorized(res);
          return;
        }
        const handled = await gpJobRest.handle(req, res, req.method, subPath);
        if (handled) return;
      }
    }

    // ── Feature data planes the composition map reads (honua-studio#23) ──
    //
    // Deliberately unauthenticated, matching honua-server's own posture for
    // published read-only collections: MapLibre fetches a GeoJSON source URL
    // directly from the renderer, with no opportunity to attach the session
    // bearer the REST client uses. Studio's data plane is read-only either
    // way (#1 REQ-005 / server ADR-0028) — only GET is served here.
    if (pathname === "/ogc/collections" && req.method === "GET") {
      json(res, 200, {
        collections: catalogDatasets
          .filter((dataset) => fixtureFeatureCollection(dataset.id) !== undefined)
          .map((dataset) => ({ id: dataset.id, title: dataset.title, itemType: "feature" })),
      });
      return;
    }
    const ogcItemsMatch = /^\/ogc\/collections\/([^/]+)\/items$/.exec(pathname);
    if (ogcItemsMatch && req.method === "GET") {
      const collectionId = decodeURIComponent(ogcItemsMatch[1]);
      const limit = Number.parseInt(requestUrl.searchParams.get("limit") ?? "", 10);
      const collection = fixtureFeatureCollection(collectionId, Number.isNaN(limit) ? undefined : limit);
      if (!collection) {
        json(res, 404, { error: "not_found", collectionId });
        return;
      }
      json(res, 200, collection, { "access-control-allow-origin": "*" });
      return;
    }
    const featureServerMatch = /^\/rest\/services\/([^/]+)\/FeatureServer\/(\d+)\/query$/.exec(pathname);
    if (featureServerMatch && req.method === "GET") {
      const serviceId = decodeURIComponent(featureServerMatch[1]);
      const count = Number.parseInt(requestUrl.searchParams.get("resultRecordCount") ?? "", 10);
      const collection = fixtureFeatureCollection(serviceId, Number.isNaN(count) ? undefined : count);
      if (!collection) {
        json(res, 404, { error: "not_found", serviceId });
        return;
      }
      // Only the `f=geojson` shape the SDK's MapLibre projection asks for —
      // this fixture is not a GeoServices implementation.
      if (requestUrl.searchParams.get("f") !== "geojson") {
        json(res, 400, { error: "unsupported_format", supported: ["geojson"] });
        return;
      }
      json(res, 200, collection, { "access-control-allow-origin": "*" });
      return;
    }

    if (pathname === "/health" && req.method === "GET") {
      json(res, 200, { status: "ok", mode: "mock" });
      return;
    }

    json(res, 404, { error: "not_found", path: pathname });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(undefined));
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Mock honua-server fixture failed to bind a loopback TCP port.");
  }
  const url = `http://127.0.0.1:${address.port}`;

  const close = () =>
    new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve(undefined)));
    });

  return { server, url, close };
}

function bearerToken(req) {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

/**
 * Mints a signed fixture access token outside the OIDC token endpoint —
 * used by tests that simulate an embed HOST already holding a session (see
 * docs/embed-session.md's host-adapter mode), where the token legitimately
 * comes from a different origin/session than this fixture's own OIDC issuer,
 * but must still pass this fixture's bearer verification the same way a real
 * honua-server would validate any token signed by the operator's configured
 * IdP.
 */
export function mintFixtureAccessToken({
  issuer = "https://console.example/oidc",
  ttlSeconds = ACCESS_TOKEN_TTL_SECONDS,
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signFixtureJwt({
    iss: issuer,
    sub: FIXTURE_USER.sub,
    aud: OIDC_CLIENT_ID,
    name: FIXTURE_USER.name,
    email: FIXTURE_USER.email,
    roles: FIXTURE_USER.roles,
    scope: "openid profile honua.read honua.write",
    iat: now,
    exp: now + ttlSeconds,
  });
}

function issueTokenResponse({ issuer, refreshToken, scope }) {
  const now = Math.floor(Date.now() / 1000);
  const resolvedScope = scope || "openid profile honua.read honua.write";
  const accessToken = signFixtureJwt({
    iss: issuer,
    sub: FIXTURE_USER.sub,
    aud: OIDC_CLIENT_ID,
    name: FIXTURE_USER.name,
    email: FIXTURE_USER.email,
    roles: FIXTURE_USER.roles,
    scope: resolvedScope,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
  });
  const idToken = signFixtureJwt({
    iss: issuer,
    sub: FIXTURE_USER.sub,
    aud: OIDC_CLIENT_ID,
    name: FIXTURE_USER.name,
    email: FIXTURE_USER.email,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
  });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: resolvedScope,
    id_token: idToken,
  };
}

/** base64url(SHA-256(verifier)) via WebCrypto — Node >=20 exposes globalThis.crypto. */
async function webCryptoPkceChallenge(verifier) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url, close } = await startMockServer({ port: process.env.PORT ? Number(process.env.PORT) : 0 });
  process.stdout.write(`[honua-studio] mock honua-server fixture listening at ${url}\n`);

  const shutdown = async () => {
    await close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
