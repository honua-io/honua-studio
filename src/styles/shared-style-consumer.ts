import type { StudioPackageEnvelope } from "../lifecycle/lifecycle-types.js";
import type { WorkspaceLifecycleReader } from "../lifecycle/workspace-reader.js";

export interface SharedStyleMapConsumerReference {
  readonly itemId: string;
  readonly packageKey: string;
  readonly draftId?: string | null;
  readonly generation?: number | null;
  readonly versionId?: string | null;
  readonly contentHash: string;
  readonly publicationState: "draft" | "saved" | "published";
}
export type SharedStyleMapConsumerIdentity =
  | {
      readonly kind: "draft";
      readonly itemId: string;
      readonly packageKey: string;
      readonly draftId: string;
      readonly generation: number;
    }
  | {
      readonly kind: "version";
      readonly itemId: string;
      readonly packageKey: string;
      readonly versionId: string;
      readonly contentHash: string;
    };
export interface SharedStyleMapConsumer {
  readonly kind: "map";
  readonly identity: SharedStyleMapConsumerIdentity;
  readonly envelope: StudioPackageEnvelope;
}

/** Read the explicitly selected authorized consumer; never consult a retained map or mutate its draft. */
export async function readSharedStyleMapConsumer(
  reader: WorkspaceLifecycleReader,
  reference: SharedStyleMapConsumerReference,
): Promise<SharedStyleMapConsumer> {
  if (!reference.itemId || !reference.packageKey) throw new Error("Select an actual map consumer identity.");
  if (reference.publicationState === "draft") {
    if (
      !reference.draftId ||
      reference.versionId ||
      !Number.isSafeInteger(reference.generation) ||
      Number(reference.generation) < 0
    )
      throw new Error("The map draft consumer generation is missing or ambiguous.");
    const actual = await reader.getDraft(reference.draftId);
    if (
      actual.draftId !== reference.draftId ||
      actual.itemId !== reference.itemId ||
      actual.packageKey !== reference.packageKey ||
      actual.generation !== reference.generation ||
      actual.family !== "map" ||
      actual.envelope.family !== "map"
    )
      throw new Error("The authorized map draft no longer matches its selected generation.");
    // Draft impact hashes use SQL JSONB bytes, which this DTO does not expose.
    // Canonical generation CAS pins this body; do not claim a browser hash comparison.
    return Object.freeze<SharedStyleMapConsumer>({
      kind: "map",
      identity: {
        kind: "draft",
        draftId: actual.draftId,
        itemId: actual.itemId,
        packageKey: actual.packageKey,
        generation: actual.generation,
      },
      envelope: structuredClone(actual.envelope),
    });
  }
  if (
    !["saved", "published"].includes(reference.publicationState) ||
    !reference.versionId ||
    reference.draftId ||
    !/^[a-f0-9]{64}$/.test(reference.contentHash)
  )
    throw new Error("Select an actual immutable map version and content hash.");
  const actual = await reader.getVersion(reference.itemId, reference.versionId);
  if (
    actual.itemId !== reference.itemId ||
    actual.packageKey !== reference.packageKey ||
    actual.versionId !== reference.versionId ||
    actual.contentHash !== reference.contentHash ||
    actual.envelope.family !== "map"
  )
    throw new Error("The authorized map version does not match its selected immutable identity.");
  return Object.freeze<SharedStyleMapConsumer>({
    kind: "map",
    identity: {
      kind: "version",
      versionId: actual.versionId,
      itemId: actual.itemId,
      packageKey: actual.packageKey,
      contentHash: actual.contentHash,
    },
    envelope: structuredClone(actual.envelope),
  });
}
