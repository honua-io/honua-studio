import { describe, expect, it, vi } from "vitest";

import {
  CompositionHistory,
  DraftSync,
  type DraftSyncConflict,
  FixtureDraftStore,
} from "../../src/composition/history.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";

describe("composition/history CompositionHistory (undo/redo)", () => {
  it("apply pushes a revision; undo restores the prior state; redo restores the undone one", () => {
    const history = new CompositionHistory(createEmptyCompositionState());
    expect(history.canUndo()).toBe(false);

    history.apply({ name: "addLayer", layer: { id: "roads", sourceId: "s" } });
    expect(history.current.layers).toHaveLength(1);
    expect(history.canUndo()).toBe(true);
    expect(history.canRedo()).toBe(false);

    history.apply({ name: "addLayer", layer: { id: "parks", sourceId: "s2" } });
    expect(history.current.layers).toHaveLength(2);

    const afterFirstUndo = history.undo();
    expect(afterFirstUndo?.layers).toHaveLength(1);
    expect(history.canRedo()).toBe(true);

    const afterSecondUndo = history.undo();
    expect(afterSecondUndo?.layers).toHaveLength(0);
    expect(history.canUndo()).toBe(false);
    // Undoing past the initial revision is a no-op, not an error.
    expect(history.undo()).toBeUndefined();

    const afterRedo = history.redo();
    expect(afterRedo?.layers).toHaveLength(1);
  });

  it("a fresh apply() after undo() clears the redo stack (standard editor semantics)", () => {
    const history = new CompositionHistory(createEmptyCompositionState());
    history.apply({ name: "addLayer", layer: { id: "a", sourceId: "s" } });
    history.apply({ name: "addLayer", layer: { id: "b", sourceId: "s" } });
    history.undo();
    expect(history.canRedo()).toBe(true);

    history.apply({ name: "addLayer", layer: { id: "c", sourceId: "s" } });
    expect(history.canRedo()).toBe(false);
    expect(history.current.layers.map((l) => l.id)).toEqual(["a", "c"]);
  });

  it("a rejected apply() throws and leaves the stack untouched", () => {
    const history = new CompositionHistory(createEmptyCompositionState());
    history.apply({ name: "addLayer", layer: { id: "roads", sourceId: "s" } });
    const revisionsBefore = history.revisions().length;

    expect(() => history.apply({ name: "addLayer", layer: { id: "roads", sourceId: "s2" } })).toThrow();
    expect(history.revisions().length).toBe(revisionsBefore);
    expect(history.current.layers).toHaveLength(1);
  });

  it("undo restoring a pinned-then-removed sequence surfaces the pin again (pins survive undo/redo, honua-studio#1 acceptance criterion)", () => {
    const history = new CompositionHistory(createEmptyCompositionState());
    history.apply({ name: "addLayer", layer: { id: "roads", sourceId: "s" } });
    history.apply({ name: "pin", target: { kind: "layer", id: "roads" } });
    expect(history.current.pins).toHaveLength(1);

    history.apply({ name: "unpin", target: { kind: "layer", id: "roads" } });
    expect(history.current.pins).toHaveLength(0);

    const restored = history.undo();
    expect(restored?.pins).toEqual([{ kind: "layer", id: "roads" }]);
  });

  it("respects maxRevisions by dropping the oldest undo-stack entries", () => {
    const history = new CompositionHistory(createEmptyCompositionState(), { maxRevisions: 2 });
    history.apply({ name: "addLayer", layer: { id: "a", sourceId: "s" } });
    history.apply({ name: "addLayer", layer: { id: "b", sourceId: "s" } });
    history.apply({ name: "addLayer", layer: { id: "c", sourceId: "s" } });
    expect(history.revisions().length).toBe(2);
    // Can only undo back to the oldest *retained* revision, not the true initial one.
    history.undo();
    expect(history.current.layers.map((l) => l.id)).toEqual(["a", "b"]);
  });
});

describe("composition/history DraftSync + FixtureDraftStore", () => {
  it("creates a draft on the first apply, replaces (incrementing generation) after", async () => {
    const store = new FixtureDraftStore();
    const sync = new DraftSync({ store, packageKey: "test-package" });

    const state1 = createEmptyCompositionState();
    const draft1 = await sync.apply(state1);
    expect(draft1.generation).toBe(1);
    expect(sync.draftId).toBe(draft1.draftId);

    const state2 = { ...state1, view: { zoom: 5 } };
    const draft2 = await sync.apply(state2);
    expect(draft2.draftId).toBe(draft1.draftId);
    expect(draft2.generation).toBe(2);
    expect(draft2.envelope.body).toEqual(state2);
  });

  it("batches overlapping apply() calls into a single flush past the first request", async () => {
    const store = new FixtureDraftStore();
    const replaceSpy = vi.spyOn(store, "replace");
    const sync = new DraftSync({ store, packageKey: "test-package" });

    await sync.apply(createEmptyCompositionState());
    replaceSpy.mockClear();

    const p1 = sync.apply({ ...createEmptyCompositionState(), view: { zoom: 1 } });
    const p2 = sync.apply({ ...createEmptyCompositionState(), view: { zoom: 2 } });
    const p3 = sync.apply({ ...createEmptyCompositionState(), view: { zoom: 3 } });
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    // All three callers share the same eventual flush.
    expect(r1.generation).toBe(r2.generation);
    expect(r2.generation).toBe(r3.generation);
    // Only the LAST queued state was ever sent to the store.
    expect(r1.envelope.body.view).toEqual({ zoom: 3 });
    expect(replaceSpy).toHaveBeenCalledTimes(1);
  });

  it("on a generation conflict, reloads, invokes onConflict, and retries automatically", async () => {
    const store = new FixtureDraftStore();
    const conflicts: DraftSyncConflict[] = [];
    const sync = new DraftSync({
      store,
      packageKey: "test-package",
      onConflict: (conflict) => conflicts.push(conflict),
    });

    const initial = await sync.apply(createEmptyCompositionState());
    expect(initial.generation).toBe(1);

    // Simulate an external writer bumping the draft's generation out from under DraftSync.
    store.simulateExternalWrite(initial.draftId, { body: { ...createEmptyCompositionState(), view: { zoom: 99 } } });

    const localState = { ...createEmptyCompositionState(), view: { zoom: 7 } };
    const result = await sync.apply(localState);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.staleGeneration).toBe(1);
    expect(conflicts[0]?.serverGeneration).toBe(2);
    expect(conflicts[0]?.serverState.view).toEqual({ zoom: 99 });

    // Default rebase: local intent wins, replayed against the fresh generation.
    expect(result.generation).toBe(3);
    expect(result.envelope.body.view).toEqual({ zoom: 7 });
  });

  it("a custom rebase strategy can prefer the server state instead of local intent", async () => {
    const store = new FixtureDraftStore();
    const sync = new DraftSync({
      store,
      packageKey: "test-package",
      rebase: (_local, server) => server,
    });

    const initial = await sync.apply(createEmptyCompositionState());
    store.simulateExternalWrite(initial.draftId, { body: { ...createEmptyCompositionState(), view: { zoom: 99 } } });

    const result = await sync.apply({ ...createEmptyCompositionState(), view: { zoom: 7 } });
    expect(result.envelope.body.view).toEqual({ zoom: 99 });
  });

  it("FixtureDraftStore.replace with a stale explicit generation throws a generation-conflict CompositionDraftError", async () => {
    const store = new FixtureDraftStore();
    const draft = await store.create({ packageKey: "p", envelope: { body: createEmptyCompositionState() } });
    await store.replace(draft.draftId, { packageKey: "p", envelope: { body: createEmptyCompositionState() } });

    await expect(
      store.replace(draft.draftId, {
        packageKey: "p",
        envelope: { body: createEmptyCompositionState() },
        generation: draft.generation, // now stale — store is at generation 2
      }),
    ).rejects.toMatchObject({ code: "generation-conflict" });
  });
});

describe("composition/history CompositionHistory wired to DraftSync", () => {
  it("apply()/undo() fire draft syncs that flush() can be awaited", async () => {
    const store = new FixtureDraftStore();
    const sync = new DraftSync({ store, packageKey: "test-package" });
    const history = new CompositionHistory(createEmptyCompositionState(), { draftSync: sync });

    history.apply({ name: "addLayer", layer: { id: "roads", sourceId: "s" } });
    await history.flush();
    expect(sync.generation).toBe(1);

    history.undo();
    await history.flush();
    expect(sync.generation).toBe(2);
  });
});
