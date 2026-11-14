import { StudioLifecycleClient } from "./lifecycle-client.js";
import type { StudioContentVersion, StudioPackageDraft } from "./lifecycle-types.js";

/** Read-only lifecycle projection for explicitly selected shared-style consumers. */
export interface ContentLifecycleReader {
  getDraft(draftId: string): Promise<StudioPackageDraft>;
  getVersion(itemId: string, versionId: string): Promise<StudioContentVersion>;
}

/** The host supplies its captured, partition-pinned cookie transport. No write methods are exposed. */
export function createContentLifecycleReader(options: {
  readonly fetchImpl: typeof fetch;
}): ContentLifecycleReader {
  const client = new StudioLifecycleClient({ baseUrl: "/api/studio", fetchImpl: options.fetchImpl });
  return Object.freeze({
    getDraft: (draftId: string) => client.getDraft(draftId),
    getVersion: (itemId: string, versionId: string) => client.getVersion(itemId, versionId),
  });
}
