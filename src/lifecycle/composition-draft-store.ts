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
 * `CompositionState` is a **renderer projection**, and a
 * `StudioPackageEnvelope` is the **wire shape**. This module is the single
 * place the two meet: outbound it wraps the state in the envelope's
 * `family`/`schemaVersion`/`format` metadata; inbound it reads the body back
 * out and checks it is shaped like composition state before handing it on.
 * Nothing else in the app converts between the two, and nothing else needs
 * to know that a composition is stored as a `map`-family package.
 *
 * A body that is not composition-shaped is a `validation` error, not a
 * silent `as CompositionState` — a draft written by some other client is a
 * thing that can actually happen, and it must not surface as a map that
 * renders nothing.
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
import { COMPOSITION_STATE_VERSION, type CompositionState } from "../composition/model.js";

/** The SDK resource group this adapter wraps — `HonuaStudioLifecycleClient["drafts"]`, narrowed to the three methods the seam uses. */
export type StudioDraftsResource = Pick<HonuaStudioLifecycleClient["drafts"], "create" | "get" | "replace">;

/** Envelope metadata a composition draft is stored under. Defaults match honua-server's `map` family descriptor (`GET /package-families`). */
export interface CompositionDraftEnvelopeMetadata {
  readonly family: string;
  readonly schemaVersion: string;
  readonly format: string;
}

export const COMPOSITION_DRAFT_ENVELOPE: CompositionDraftEnvelopeMetadata = {
  family: "map",
  schemaVersion: "1.0",
  format: "honua_map_package.v1",
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

/** Composition state -> `StudioPackageEnvelope`. The state is JSON data by construction (`model.ts`), which is what makes this a wrap rather than a serialization. */
function toWireEnvelope(state: CompositionState, metadata: CompositionDraftEnvelopeMetadata): StudioPackageEnvelope {
  return {
    family: metadata.family,
    schemaVersion: metadata.schemaVersion,
    format: metadata.format,
    body: { ...state } as unknown as Record<string, unknown>,
  };
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
 * Reads a draft body back as composition state. Checks the collections the
 * reducer iterates rather than trusting the cast — an envelope written by
 * another client, or by an older state version, must fail loudly here rather
 * than render as an empty map.
 */
function toCompositionState(body: unknown): CompositionState {
  if (typeof body !== "object" || body === null) {
    throw new CompositionDraftError("validation", "The draft envelope carries no composition body.");
  }
  const candidate = body as Partial<CompositionState>;
  if (candidate.version !== COMPOSITION_STATE_VERSION) {
    throw new CompositionDraftError(
      "validation",
      `The draft envelope carries composition state version ${String(candidate.version)}; this client reads version ${COMPOSITION_STATE_VERSION}.`,
    );
  }
  for (const key of ["layers", "widgets", "controls", "interactions", "annotations", "pins"] as const) {
    if (!Array.isArray(candidate[key])) {
      throw new CompositionDraftError("validation", `The draft envelope's composition body has no \`${key}\` array.`);
    }
  }
  if (typeof candidate.view !== "object" || candidate.view === null) {
    throw new CompositionDraftError("validation", "The draft envelope's composition body has no `view` object.");
  }
  return candidate as CompositionState;
}
