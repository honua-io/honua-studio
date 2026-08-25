/**
 * The adapter `composition/history.ts` has always described and never had:
 * `HonuaStudioLifecycleClient.drafts` (`@honua/sdk-js/studio`) behind
 * {@link CompositionDraftStore}, so `DraftSync` persists a composition to a
 * real Studio package draft.
 *
 * It could not be written before honua-studio#30 bumped the pin — the SDK
 * version this app installed did not export a lifecycle client, so the
 * adapter existed only as prose in `history.ts`'s module doc, which no
 * compiler ever read. It is checked now: {@link StudioDraftsResource} is a
 * `Pick` off the real client, and the calls below pass real argument
 * objects, so a renamed method or a changed request shape fails `tsc`.
 *
 * ## The one wire conversion (AD-8)
 *
 * `CompositionState` is a **renderer projection**; the durable wire shape is
 * honua-server's `StudioCompositionBody` (honua-server#3002 —
 * `{ layers, view, widgets, controls?, interactions? }`). This module is the
 * single place the two meet, and it does the conversion with the pair
 * `../mcp/tool-bridge.ts` already owns — `toStudioCompositionBody` out,
 * `applyStudioDraftBody` in — deliberately, not for tidiness:
 * `ToolCallOrchestrator` writes that exact body to that exact family through
 * `honua_studio_*`, and two writers producing two different shapes in one
 * draft is the coherence failure AD-8 exists to prevent.
 * `test/playwright/live-demo-journeys.spec.mjs` asserts that shape against
 * the REAL deployed store.
 *
 * ### What this envelope does NOT claim
 *
 * It does not declare `format: "honua_map_package.v1"`. That format is the
 * *rendering* projection `../map/map-package-projection.ts` produces —
 * `{ mapPackageId, format, status, initialView, sourceBindings, mapSpec }` —
 * and the real server's validator rejects a `{ layers, view, widgets }` body
 * under it (`live-demo-journeys.spec.mjs`'s `validMapBody` comment says so in
 * as many words; `mock-server.mjs` never runs map-body validation, so a mock
 * green here would prove nothing). Labelling a composition body with that
 * format would produce drafts that pass in fixture mode and fail to validate
 * or publish against a real deployment.
 *
 * A map package is also not a candidate for the durable body: the projection
 * needs a source catalog this boundary does not have, and it drops widgets,
 * controls, interactions, and unresolved layers — there is no inverse to read
 * back. So this module writes what honua-server's composition surface
 * actually stores, and, like `honua_studio_create_draft`, sends **no
 * `format`** at all: the server owns that field, and both of this app's
 * writers leave it alone rather than each guessing a different answer.
 *
 * ### What is lossy, exactly
 *
 * `pins` and `annotations` do not survive a round trip, by design and not by
 * accident: they are app-only annotations explicitly excluded from the
 * durable envelope (honua-studio#30), and `StudioCompositionBodyEditor`
 * server-side models neither. `applyStudioDraftBody` carries them over from
 * the caller's previous state rather than clearing them; a bare
 * {@link CompositionDraftStore.get}, which has no previous state to carry,
 * returns them empty — which is the truth about what the draft holds.
 * Nothing else is dropped: layers, view, widgets, controls and interactions
 * all round-trip.
 *
 * A body that is not composition-shaped is a `validation` error, not a
 * silent cast — a draft written by another client (a real
 * `honua_map_package.v1` package, above all) must fail loudly here rather
 * than read back as a composition with no layers in it.
 *
 * ## Deliberately not in `./index.ts`
 *
 * That barrel exports `StudioLifecycleClient`, which carries the two
 * exposure-widening methods spec REQ-009 gates. This module is reachable
 * from the composition engine's side of the app, so it stays a direct
 * import: a caller that wants a draft store must not pick up `requestPublish`
 * on the way in. See `test/lifecycle/human-gate.test.ts`.
 *
 * @module
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
import type { StudioCompositionBodyWire } from "../mcp/studio-tools.js";
import { applyStudioDraftBody, toStudioCompositionBody } from "../mcp/tool-bridge.js";

/** The SDK resource group this adapter wraps — `HonuaStudioLifecycleClient["drafts"]`, narrowed to the three methods the seam uses. */
export type StudioDraftsResource = Pick<HonuaStudioLifecycleClient["drafts"], "create" | "get" | "replace">;

/**
 * Envelope metadata a composition draft is stored under. `format` is
 * **optional and absent by default** — see the module doc: the server owns
 * it for a composition body, and this client declines to guess, exactly as
 * `honua_studio_create_draft` does. Supply one only for a deployment that
 * has told you which format string its composition bodies carry.
 */
export interface CompositionDraftEnvelopeMetadata {
  readonly family: string;
  readonly schemaVersion: string;
  readonly format?: string;
}

/**
 * Byte-for-byte what `ToolCallOrchestrator.#ensureDraft` sends when it
 * lazily creates a composition draft (`family ?? "map"`,
 * `schemaVersion ?? "1"`, no `format`). Keeping the two identical is the
 * point: either writer may create the draft the other then writes to.
 */
export const COMPOSITION_DRAFT_ENVELOPE: CompositionDraftEnvelopeMetadata = {
  family: "map",
  schemaVersion: "1",
};

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
            envelope: toWireEnvelope(request.envelope.body, metadata),
          }),
        ),
      );
    },

    async get(draftId: string): Promise<CompositionDraft> {
      return toCompositionDraft(await run(() => drafts.get(draftId)));
    },

    async replace(draftId: string, request: CompositionDraftReplaceRequest): Promise<CompositionDraft> {
      return toCompositionDraft(
        await run(() =>
          drafts.replace(draftId, {
            packageKey: request.packageKey,
            ...(request.generation !== undefined ? { generation: request.generation } : {}),
            envelope: toWireEnvelope(request.envelope.body, metadata),
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

/**
 * Composition state -> `StudioPackageEnvelope`. The body is honua-server's
 * `StudioCompositionBody`, built by the same `toStudioCompositionBody` the
 * MCP composition path uses, so both writers put the same shape in the same
 * draft. `format` is contributed only when the caller supplied one.
 *
 * The one cast is on the envelope, not the body, and it is narrow: the SDK
 * declares `StudioPackageEnvelope.format` **required**, while honua-server's
 * own composition surface never sends it (`honua_studio_create_draft` takes
 * `packageKey`/`family`/`schemaVersion`/`body` and no format at all). This is
 * the same class of over-constraint `./lifecycle-types.ts`'s header
 * enumerates, and sending a format we do not know would be worse than
 * omitting a field the server fills in.
 */
function toWireEnvelope(state: CompositionState, metadata: CompositionDraftEnvelopeMetadata): StudioPackageEnvelope {
  return {
    family: metadata.family,
    schemaVersion: metadata.schemaVersion,
    ...(metadata.format !== undefined ? { format: metadata.format } : {}),
    body: { ...toStudioCompositionBody(state) } as unknown as Record<string, unknown>,
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
