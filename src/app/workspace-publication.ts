import type { StudioLifecycleClient } from "../lifecycle/lifecycle-client.js";
import type { StudioContentVersion, StudioPublishRequestInput } from "../lifecycle/lifecycle-types.js";
import type { WorkspaceDraftBinding } from "../lifecycle/workspace-draft.js";
import type { EpochToken } from "./staleness-epoch.js";
import type { WorkspaceAuthority } from "./workspace-authority.js";
import type { WorkspaceDraftIdentity, WorkspaceDraftSession } from "./workspace-draft-session.js";

type PublishReceipt = ReturnType<StudioLifecycleClient["requestPublish"]>;
type PublicationReceipt = ReturnType<StudioLifecycleClient["getPublicationRequest"]>;

interface PublicationReview {
  readonly binding: WorkspaceDraftBinding;
  readonly generation: EpochToken;
  readonly itemId: string;
  readonly versionId: string;
  readonly contentHash: string;
  submission?: { readonly commandId: string; readonly requestJson: string; pending?: PublishReceipt };
}

/** What a queued lifecycle step gets: a fresh client, the draft it started on and its staleness check. */
interface LifecycleStep {
  readonly client: StudioLifecycleClient;
  readonly identity: WorkspaceDraftIdentity;
  readonly current: () => void;
  readonly generation: EpochToken;
}

type LifecycleAction<T> = (step: LifecycleStep) => Promise<T>;

const LIFECYCLE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_OR_MAP_CHANGED = "The workspace session or map changed.";

/**
 * Saved versions of the active draft and their human-gated publication. Publishing requires a review
 * taken in the same workspace session, and nothing here publishes as a side effect.
 */
export class WorkspacePublication {
  #reviews = new WeakMap<StudioContentVersion, PublicationReview>();

  constructor(
    private readonly authority: WorkspaceAuthority,
    private readonly drafts: WorkspaceDraftSession,
    private readonly hooks: {
      readonly prepareWorkspaceTurn: () => Promise<unknown>;
      readonly saveCurrentView: (current: () => void) => Promise<void>;
    },
  ) {}

  saveVersion(): Promise<StudioContentVersion> {
    return this.#withLifecycle(async ({ client, identity, current }) => {
      await this.hooks.saveCurrentView(current);
      current();
      const version = await client.saveAsVersion(identity.draftId);
      current();
      return version;
    });
  }

  listVersions(): Promise<readonly StudioContentVersion[]> {
    return this.#withLifecycle(async ({ client, identity, current }) => {
      const draft = await client.getDraft(identity.draftId);
      current();
      const result = await client.listVersions(draft.itemId);
      current();
      return result.versions;
    });
  }

  review(versionId: string): Promise<StudioContentVersion> {
    return this.#withLifecycle(async ({ client, identity, current, generation }) => {
      const draft = await client.getDraft(identity.draftId);
      current();
      const version = await client.getVersion(draft.itemId, versionId);
      current();
      if (
        version.itemId !== draft.itemId ||
        version.versionId !== versionId ||
        version.packageKey !== identity.packageKey ||
        !version.contentHash
      )
        throw new Error("The publication version does not belong to the active map.");
      const review = Object.freeze(structuredClone(version));
      this.#reviews.set(review, {
        binding: this.drafts.binding!,
        generation,
        itemId: version.itemId,
        versionId: version.versionId,
        contentHash: version.contentHash,
      });
      return review;
    });
  }

  /**
   * Human host action only. The host must persist commandId before submission and
   * retain it and the exact input after a lost response. Replays use server policy
   * and fresh authorization; a receipt awaiting approval is never completion.
   */
  async publish(review: StudioContentVersion, request: StudioPublishRequestInput, commandId: string): PublishReceipt {
    const state = this.#reviews.get(review);
    if (!state) throw new Error("Review the saved version in the current workspace before publishing.");
    const requireReview = () => {
      if (state.binding !== this.drafts.binding || !this.authority.epoch.isCurrent(state.generation))
        throw new Error("Review the saved version again in the original workspace session before publishing.");
    };
    requireReview();
    const submission = this.#pinSubmission(state, request, commandId);
    if (submission.pending) return submission.pending;
    const pending = this.#withLifecycle(async ({ client, current }) => {
      requireReview();
      const version = await client.getVersion(state.itemId, state.versionId);
      current();
      requireReview();
      if (
        version.itemId !== state.itemId ||
        version.versionId !== state.versionId ||
        version.contentHash !== state.contentHash
      )
        throw new Error("The saved version changed after publication review.");
      const receipt = await client.requestPublish(
        state.itemId,
        state.versionId,
        JSON.parse(submission.requestJson) as StudioPublishRequestInput,
        submission.commandId,
      );
      current();
      requireReview();
      return receipt;
    });
    submission.pending = pending;
    try {
      return await pending;
    } finally {
      submission.pending = undefined;
    }
  }

  async readPublication(versionId: string, requestId: string): PublicationReceipt {
    const binding = this.drafts.binding;
    const generation = this.authority.epoch.current;
    const identity = binding?.identity;
    if (!binding || !identity) throw new Error("Open a map draft before reading its publication.");
    if (![versionId, requestId].every((id) => typeof id === "string" && LIFECYCLE_ID.test(id)))
      throw new Error("Version and publication request IDs are required.");
    const current = () => {
      if (binding !== this.drafts.binding || !this.authority.epoch.isCurrent(generation))
        throw new Error(SESSION_OR_MAP_CHANGED);
    };
    current();
    const client = this.authority.lifecycleClient();
    const draft = await client.getDraft(identity.draftId);
    current();
    if (draft.draftId !== identity.draftId || draft.packageKey !== identity.packageKey)
      throw new Error("The publication draft does not belong to the active map.");
    const receipt = await client.getPublicationRequest(draft.itemId, versionId, requestId);
    current();
    if (receipt.itemId !== draft.itemId || receipt.versionId !== versionId || receipt.requestId !== requestId)
      throw new Error("The publication receipt does not belong to the selected version.");
    return receipt;
  }

  reopenVersion(versionId: string): Promise<void> {
    return this.#withLifecycle(async ({ client, identity, current, generation }) => {
      const draft = await client.getDraft(identity.draftId);
      current();
      const reopened = await client.reopenVersion(draft.itemId, versionId);
      current();
      if (reopened.itemId !== draft.itemId || reopened.packageKey !== identity.packageKey)
        throw new Error("The reopened version does not belong to the active map.");
      await this.drafts.observe(reopened.draftId, generation);
    });
  }

  /** A retried publication must reuse its original command ID and settings. */
  #pinSubmission(
    state: PublicationReview,
    request: StudioPublishRequestInput,
    commandId: string,
  ): NonNullable<PublicationReview["submission"]> {
    if (typeof commandId !== "string" || commandId.trim() !== commandId || !LIFECYCLE_ID.test(commandId))
      throw new Error("A stable publication command ID is required.");
    // Keep only canonical publication inputs; browser callers cannot add approval fields.
    const requestJson = JSON.stringify({
      intent: request.intent,
      warningAcknowledgement: request.warningAcknowledgement,
    });
    if (state.submission && (state.submission.commandId !== commandId || state.submission.requestJson !== requestJson))
      throw new Error("Check the original publication before changing its command or publication settings.");
    state.submission ??= { commandId, requestJson };
    return state.submission;
  }

  async #withLifecycle<T>(action: LifecycleAction<T>): Promise<T> {
    const binding = this.drafts.binding;
    const generation = this.authority.epoch.current;
    const identity = binding?.identity;
    if (!binding || !identity) throw new Error("Open a map draft before using saved versions.");
    await this.hooks.prepareWorkspaceTurn();
    const current = () => {
      if (!this.authority.epoch.isCurrent(generation) || binding !== this.drafts.binding)
        throw new Error(SESSION_OR_MAP_CHANGED);
      if (this.drafts.isEditPending())
        throw new Error("Save or explicitly reload pending Studio edits before using saved versions.");
    };
    return this.drafts.enqueue(async () => {
      current();
      return action({ client: this.authority.lifecycleClient(), identity, current, generation });
    });
  }
}
