import { describe, expect, it, vi } from "vitest";
import type { StudioPackageDraft, StudioPackageDraftCreateRequest } from "../../src/lifecycle/lifecycle-types.js";
import { RecipeSubmission } from "../../src/recipes/recipe-submission.js";

const request: StudioPackageDraftCreateRequest = {
  packageKey: "explore",
  envelope: { family: "map", schemaVersion: "1.0", body: { layers: [] } },
};
const draft = { draftId: "accepted", packageKey: "explore", generation: 1 } as StudioPackageDraft;

describe("recipe submission retry identity", () => {
  it("coalesces double submit and preserves accepted draft after an attachment retry", async () => {
    let accept!: (draft: StudioPackageDraft) => void;
    const create = vi.fn(
      () =>
        new Promise<StudioPackageDraft>((resolve) => {
          accept = resolve;
        }),
    );
    const submission = new RecipeSubmission();
    const first = submission.createDraft(request, create);
    expect(submission.createDraft(request, create)).toBe(first);
    accept(draft);
    expect(await first).toBe(draft);
    expect(await submission.createDraft(request, create)).toBe(draft);
    expect(create).toHaveBeenCalledExactlyOnceWith(request, submission.commandId);
  });

  it("retries a lost response with exact request and Idempotency-Key; changed payload is refused", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("response lost after accept")).mockResolvedValue(draft);
    const submission = new RecipeSubmission();
    await expect(submission.createDraft(request, create)).rejects.toThrow("response lost");
    await expect(submission.createDraft({ ...request, packageKey: "changed" }, create)).rejects.toThrow(
      "original recipe",
    );
    expect(await submission.createDraft(request, create)).toBe(draft);
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
  });
});
