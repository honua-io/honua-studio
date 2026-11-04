/**
 * A command the reducer refuses never reaches the server, so the attached draft stays editable; only a
 * failure after the write leaves the draft needing an explicit reload.
 */
import { describe, expect, it, vi } from "vitest";

import { CompositionEditor, type CompositionEditorOptions } from "../../src/app/composition-editor.js";
import { StalenessEpoch } from "../../src/app/staleness-epoch.js";
import { CompositionController } from "../../src/composition/controller.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";

const REMOVE_ROADS = [{ name: "removeLayer", target: { kind: "layer", id: "roads" } }] as const;

function editorWith(write: (state: unknown) => Promise<unknown>) {
  const composition = new CompositionController({
    ...createEmptyCompositionState(),
    layers: [{ id: "roads", sourceId: "roads", visible: true }],
    controls: [{ id: "road-filter", kind: "filterSelect", sourceId: "roads" }],
  });
  const drafts = {
    activeMap: new StalenessEpoch(),
    binding: { replace: vi.fn(write) },
    enqueue: <T>(task: () => Promise<T>) => Promise.resolve().then(task),
    announce: vi.fn(),
    markConflict: vi.fn(),
  };
  const editor = new CompositionEditor({
    authority: { epoch: new StalenessEpoch(), lease: new StalenessEpoch() },
    drafts,
    composition,
    hasUnsavedStyleChanges: () => false,
  } as unknown as CompositionEditorOptions);
  return { editor, drafts, composition };
}

describe("an attached-draft edit the reducer refuses", () => {
  it("reports the refusal without writing or marking the draft conflicted", async () => {
    const { editor, drafts, composition } = editorWith(async (state) => state);
    const before = composition.state;

    const outcome = await editor.dispatch(REMOVE_ROADS);

    expect(outcome).toEqual({
      ok: false,
      reason:
        "Cannot remove layer 'roads' because control 'road-filter' still uses sourceId 'roads'. Remove or rebind the control first.",
    });
    expect(drafts.binding.replace).not.toHaveBeenCalled();
    expect(drafts.markConflict).not.toHaveBeenCalled();
    expect(composition.state).toBe(before);
  });

  it("still marks the draft conflicted when the server write fails", async () => {
    const { editor, drafts } = editorWith(async () => {
      throw new Error("The draft changed on the server.");
    });

    const outcome = await editor.dispatch([{ name: "setView", view: { zoom: 4 } }]);

    expect(outcome).toEqual({ ok: false, reason: "The draft changed on the server." });
    expect(drafts.markConflict).toHaveBeenCalledOnce();
  });
});
