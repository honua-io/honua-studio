import { canonicalCompositionJson } from "../composition/model.js";
import type { StudioPackageDraft, StudioPackageDraftCreateRequest } from "../lifecycle/lifecycle-types.js";

/** Ephemeral request ledger, not a second draft store. Retries retain exact request/command and accepted draft. */
export class RecipeSubmission {
  readonly commandId = crypto.randomUUID();
  #request: StudioPackageDraftCreateRequest | undefined;
  #draft: StudioPackageDraft | undefined;
  #pending: Promise<StudioPackageDraft> | undefined;

  public get submitted(): boolean {
    return this.#request !== undefined;
  }

  public createDraft(
    request: StudioPackageDraftCreateRequest,
    create: (request: StudioPackageDraftCreateRequest, commandId: string) => Promise<StudioPackageDraft>,
  ): Promise<StudioPackageDraft> {
    if (this.#request && canonicalCompositionJson(request) !== canonicalCompositionJson(this.#request))
      return Promise.reject(new Error("Retry the original recipe submission before changing its inputs."));
    if (this.#draft) return Promise.resolve(this.#draft);
    if (this.#pending) return this.#pending;
    this.#request ??= structuredClone(request);
    const pending = create(this.#request, this.commandId).then((draft) => {
      if (!draft?.draftId || draft.packageKey !== request.packageKey)
        throw new Error("The server did not return the accepted recipe draft. Retry this submission.");
      this.#draft = draft;
      return draft;
    });
    this.#pending = pending;
    void pending
      .finally(() => {
        this.#pending = undefined;
      })
      .catch(() => undefined);
    return pending;
  }
}
