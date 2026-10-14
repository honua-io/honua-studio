/**
 * SDK lifecycle adapter for the composition draft store. Map drafts retain the
 * canonical map identity/format alongside layers, view, widgets, controls and
 * interactions. This is an editable composition document, not a fabricated
 * render projection: mapSpec/sourceBindings are never synthesized here.
 *
 * Replacement reads the authoritative envelope and preserves unmodelled body
 * metadata under optimistic generation checking. Pins and annotations remain
 * local, as the server composition contract does not model them.
 *
 * Keep this module outside the lifecycle barrel: composition code must not gain
 * access to publication methods through its narrow create/get/replace seam.
 */
import { isHonuaStudioError, isHonuaStudioGenerationConflict } from "@honua/sdk-js/studio";
import type { HonuaStudioLifecycleClient, StudioPackageEnvelope } from "@honua/sdk-js/studio";

import {
  type CompositionDraft,
  type CompositionDraftCreateRequest,
  CompositionDraftError,
  type CompositionDraftReplaceRequest,
  type CompositionDraftStore,
} from "../composition/history.js";
import type { CompositionState } from "../composition/model.js";
import { MAP_COMPOSITION_ENVELOPE, toCompositionDraftBody } from "../mcp/composition-envelope.js";
import type { StudioCompositionBodyWire } from "../mcp/studio-tools.js";
import { applyStudioDraftBody } from "../mcp/tool-bridge.js";

/** The SDK resource group this adapter wraps — `HonuaStudioLifecycleClient["drafts"]`, narrowed to the three methods the seam uses. */
export type StudioDraftsResource = Pick<HonuaStudioLifecycleClient["drafts"], "create" | "get" | "replace">;

/** Optional deployment metadata override for newly created drafts. Existing envelopes remain authoritative. */
export interface CompositionDraftEnvelopeMetadata {
  readonly family: string;
  readonly schemaVersion: string;
  readonly format?: string;
}

/** Shared with the MCP composition path. */
export const COMPOSITION_DRAFT_ENVELOPE: CompositionDraftEnvelopeMetadata = MAP_COMPOSITION_ENVELOPE;

export interface LifecycleCompositionDraftStoreOptions {
  /** The lifecycle client's `drafts` resource group — `createHonuaStudioLifecycleClient({ client }).drafts`. */
  readonly drafts: StudioDraftsResource;
  /** Override the envelope metadata a composition is stored under. Defaults to {@link COMPOSITION_DRAFT_ENVELOPE}. */
  readonly envelope?: CompositionDraftEnvelopeMetadata;
}

/**
 * Wraps the SDK's Studio draft client as a {@link CompositionDraftStore}, so
 * `DraftSync` can persist a composition without knowing anything about the
 * package envelope, the lifecycle API, or the SDK's error taxonomy.
 */
export function createLifecycleCompositionDraftStore(
  options: LifecycleCompositionDraftStoreOptions,
): CompositionDraftStore {
  const { drafts } = options;
  const metadata = options.envelope ?? COMPOSITION_DRAFT_ENVELOPE;

  return {
    async create(request: CompositionDraftCreateRequest): Promise<CompositionDraft> {
      return toCompositionDraft(
        await run(() =>
          drafts.create({
            packageKey: request.packageKey,
            ...(request.itemId !== undefined ? { itemId: request.itemId } : {}),
            envelope: toWireEnvelope(request.envelope.body, request.packageKey, metadata),
          }),
        ),
      );
    },

    async get(draftId: string): Promise<CompositionDraft> {
      return toCompositionDraft(await run(() => drafts.get(draftId)));
    },

    async replace(draftId: string, request: CompositionDraftReplaceRequest): Promise<CompositionDraft> {
      const current = await run(() => drafts.get(draftId));
      // Refuse foreign render-only bodies rather than overwriting them with an empty composition.
      toCompositionState(current.envelope?.body);
      return toCompositionDraft(
        await run(() =>
          drafts.replace(draftId, {
            packageKey: request.packageKey,
            generation: request.generation ?? current.generation,
            ...(current.workspaceId !== undefined ? { workspaceId: current.workspaceId } : {}),
            ...(current.ownerId !== undefined ? { ownerId: current.ownerId } : {}),
            envelope: {
              ...current.envelope,
              body: toCompositionDraftBody(
                request.envelope.body,
                current.packageKey,
                current.envelope.family,
                current.envelope.body,
              ),
            },
          }),
        ),
      );
    },
  };
}

/** Translates the SDK's error taxonomy into the seam's, so `DraftSync`'s conflict/rebase path fires on a real 409. */
async function run<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (isHonuaStudioGenerationConflict(error)) {
      throw new CompositionDraftError("generation-conflict", error.message, { cause: error });
    }
    if (isHonuaStudioError(error)) {
      const code = error.code === "unknown" ? "unknown" : error.code;
      throw new CompositionDraftError(code, error.message, { cause: error });
    }
    throw new CompositionDraftError("unknown", error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

/** New drafts share their canonical map metadata with the MCP writer. */
function toWireEnvelope(
  state: CompositionState,
  packageKey: string,
  metadata: CompositionDraftEnvelopeMetadata,
): StudioPackageEnvelope {
  return {
    family: metadata.family,
    schemaVersion: metadata.schemaVersion,
    ...(metadata.format !== undefined ? { format: metadata.format } : {}),
    body: toCompositionDraftBody(state, packageKey, metadata.family),
  } as StudioPackageEnvelope;
}

/** `StudioPackageDraft` -> the fields the seam reads, with the body checked rather than asserted. */
function toCompositionDraft(draft: {
  readonly draftId: string;
  readonly itemId?: string;
  readonly packageKey: string;
  readonly generation: number;
  readonly envelope: StudioPackageEnvelope;
}): CompositionDraft {
  return {
    draftId: draft.draftId,
    ...(draft.itemId !== undefined ? { itemId: draft.itemId } : {}),
    packageKey: draft.packageKey,
    generation: draft.generation,
    envelope: { body: toCompositionState(draft.envelope?.body) },
  };
}

/**
 * Reads a draft body back as composition state, through the same
 * `applyStudioDraftBody` projection the orchestrator applies to a tool
 * result — one inverse, not two.
 *
 * The guard in front of it is the load-bearing part. `applyStudioDraftBody`
 * is deliberately tolerant (`body.layers ?? []`), which is right for a
 * server response and wrong here: a draft carrying a real
 * `honua_map_package.v1` package, or any other family's body, would read
 * back as a composition with no layers and silently replace the user's map
 * with an empty one. Requiring the collection honua-server's
 * `StudioCompositionBodyEditor` always writes turns that into a stated
 * failure.
 *
 * `pins`/`annotations` come back empty — see the module doc's lossiness
 * note; they are not in the durable envelope to begin with.
 */
function toCompositionState(body: unknown): CompositionState {
  if (typeof body !== "object" || body === null) {
    throw new CompositionDraftError("validation", "The draft envelope carries no composition body.");
  }
  const candidate = body as { readonly layers?: unknown; readonly format?: unknown };
  if (!Array.isArray(candidate.layers)) {
    const format = typeof candidate.format === "string" ? ` (its \`format\` is "${candidate.format}")` : "";
    throw new CompositionDraftError(
      "validation",
      `The draft envelope's body has no \`layers\` array${format}, so it is not a Studio composition body. A map-package body is a rendering artifact, not a composition — this client will not read one as an empty map.`,
    );
  }
  return applyStudioDraftBody(body as StudioCompositionBodyWire);
}
