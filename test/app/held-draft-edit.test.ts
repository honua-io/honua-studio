/**
 * An installation can require approval for Studio draft changes. The server then answers a draft write
 * with HTTP 202 and a proposal. The editor must report that hold with its proposal, keep the map unchanged,
 * and wait for the approval instead of treating the write as a conflict.
 */
import { describe, expect, it, vi } from "vitest";

import { CompositionEditor, type CompositionEditorOptions } from "../../src/app/composition-editor.js";
import { EditorDraftSession, type EditorDraftSessionHooks } from "../../src/app/editor-draft-session.js";
import { StalenessEpoch } from "../../src/app/staleness-epoch.js";
import { CompositionController } from "../../src/composition/controller.js";
import { createEmptyCompositionState } from "../../src/composition/model.js";
import type { StudioApprovalPending } from "../../src/lifecycle/approval-pending.js";
import { StudioLifecycleClient } from "../../src/lifecycle/lifecycle-client.js";
import {
  StudioLifecycleApprovalPendingError,
  isStudioLifecycleApprovalPending,
} from "../../src/lifecycle/lifecycle-errors.js";
import type { StudioPackageDraft } from "../../src/lifecycle/lifecycle-types.js";
import { MAP_COMPOSITION_ENVELOPE, toCompositionDraftBody } from "../../src/mcp/composition-envelope.js";

const HELD: StudioApprovalPending = {
  status: "awaiting-approval",
  operationInstanceId: "operation-1",
  proposalId: "proposal-1",
  proposalUri: "/operations/proposals/proposal-1",
};
const APPROVAL_MESSAGE =
  "Waiting for separate human approval. Proposal proposal-1. The change is applied only after it is approved in the Inbox.";

function mapDraft(generation: number): StudioPackageDraft {
  return {
    draftId: "draft-1",
    packageKey: "held-map",
    generation,
    envelope: { ...MAP_COMPOSITION_ENVELOPE, body: toCompositionDraftBody(createEmptyCompositionState(), "held-map") },
  } as unknown as StudioPackageDraft;
}

function replaceRequest() {
  return { packageKey: "held-map", generation: 1, envelope: mapDraft(1).envelope };
}

describe("lifecycle client: a draft write held for approval", () => {
  it("rejects with the approval receipt instead of an unknown pending action", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            status: 4,
            operationId: "studio.draft.update",
            operationInstanceId: "operation-1",
            proposalId: "proposal-1",
            proposalUri: "/operations/proposals/proposal-1",
          },
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    const client = new StudioLifecycleClient({ baseUrl: "/api", fetchImpl });

    const error = await client.replaceDraft("draft-1", replaceRequest()).catch((caught: unknown) => caught);

    expect(isStudioLifecycleApprovalPending(error)).toBe(true);
    expect(error).toMatchObject({ code: "approval-pending", status: 202, message: APPROVAL_MESSAGE });
    expect((error as StudioLifecycleApprovalPendingError).pending).toMatchObject({
      proposalId: "proposal-1",
      proposalUri: "/operations/proposals/proposal-1",
    });
  });

  it("still refuses a 202 without an approval receipt as an unknown pending action", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ data: { status: 1, operationInstanceId: "operation-1" } }), { status: 202 });
    const client = new StudioLifecycleClient({ baseUrl: "/api", fetchImpl });

    await expect(client.replaceDraft("draft-1", replaceRequest())).rejects.toMatchObject({
      code: "unknown",
      message: "The action is pending; no completed result was returned.",
    });
  });
});

describe("composition editor: an edit the server holds for approval", () => {
  it("reports the proposal and waits for approval instead of marking a conflict", async () => {
    const composition = new CompositionController(createEmptyCompositionState());
    const before = composition.state;
    const drafts = {
      activeMap: new StalenessEpoch(),
      binding: {
        replace: vi.fn(async () => {
          throw new StudioLifecycleApprovalPendingError(HELD);
        }),
      },
      enqueue: <T>(task: () => Promise<T>) => Promise.resolve().then(task),
      announce: vi.fn(),
      markConflict: vi.fn(),
      markAwaitingApproval: vi.fn(),
    };
    const editor = new CompositionEditor({
      authority: { epoch: new StalenessEpoch(), lease: new StalenessEpoch() },
      drafts,
      composition,
      hasUnsavedStyleChanges: () => false,
    } as unknown as CompositionEditorOptions);

    const outcome = await editor.dispatch([{ name: "setView", view: { zoom: 4 } }]);

    expect(outcome).toEqual({
      ok: false,
      reason: APPROVAL_MESSAGE,
      approval: { proposalId: "proposal-1", proposalUri: "/operations/proposals/proposal-1" },
    });
    expect(drafts.markAwaitingApproval).toHaveBeenCalledWith(HELD);
    expect(drafts.markConflict).not.toHaveBeenCalled();
    expect(composition.state).toBe(before);
  });
});

function sessionReading(drafts: StudioPackageDraft[], replaceDraft = vi.fn()) {
  const getDraft = vi.fn(async () => drafts.shift() ?? mapDraft(1));
  const authority = { epoch: new StalenessEpoch(), lifecycleClient: () => ({ getDraft, replaceDraft }) };
  const approvals: (StudioApprovalPending | undefined)[] = [];
  const composition = new CompositionController(createEmptyCompositionState());
  const hooks: EditorDraftSessionHooks = {
    prepareEditorTurn: async () => undefined,
    attachEditorDraft: (draftId) => session.attach(draftId),
    hasDirtyForm: () => false,
    settleStyleEdits: async () => undefined,
    onDraftRequested: () => undefined,
    beforeMapSwitch: () => undefined,
    afterMapSwitch: () => undefined,
    onDraftChange: () => undefined,
    onApprovalChange: (pending) => approvals.push(pending),
  };
  const session: EditorDraftSession = new EditorDraftSession(
    authority as unknown as ConstructorParameters<typeof EditorDraftSession>[0],
    composition,
    hooks,
  );
  return { session, composition, approvals, replaceDraft };
}

function editorOver(session: EditorDraftSession, composition: CompositionController) {
  const chrome = { setHistoryStatus: vi.fn(), paintHistory: vi.fn() };
  const editor = new CompositionEditor({
    authority: { epoch: new StalenessEpoch(), lease: new StalenessEpoch() },
    drafts: session,
    composition,
    chrome,
    children: { chat: () => undefined },
    hasUnsavedStyleChanges: () => false,
  } as unknown as CompositionEditorOptions);
  return { editor, chrome };
}

const HELD_MESSAGE =
  "The last map edit is waiting for separate human approval (proposal proposal-1). Approve it in the Inbox, then reload the map before editing, saving a version or sending an editor turn.";

describe("editor draft session: a held edit", () => {
  it("refuses further edits and undo while held and keeps the first proposal", async () => {
    const replaceDraft = vi.fn(async () => {
      throw new StudioLifecycleApprovalPendingError(HELD);
    });
    const { session, composition, approvals } = sessionReading([mapDraft(1)], replaceDraft);
    const { editor, chrome } = editorOver(session, composition);
    await session.attach("draft-1");

    expect((await editor.dispatch([{ name: "setView", view: { zoom: 4 } }])).approval).toEqual({
      proposalId: "proposal-1",
      proposalUri: "/operations/proposals/proposal-1",
    });
    const second = await editor.dispatch([{ name: "setView", view: { zoom: 6 } }]);
    session.markAwaitingApproval({ ...HELD, proposalId: "proposal-2" });

    expect(second).toEqual({
      ok: false,
      reason: HELD_MESSAGE,
      approval: { proposalId: "proposal-1", proposalUri: "/operations/proposals/proposal-1" },
    });
    expect(await editor.applyHistory("undo")).toBe(false);
    expect(chrome.setHistoryStatus).toHaveBeenCalledWith(HELD_MESSAGE);
    expect(replaceDraft).toHaveBeenCalledOnce();
    expect(session.pendingApproval).toEqual(HELD);
    expect(approvals).toEqual([HELD]);
  });
});

describe("editor draft session: ending a hold", () => {
  it("explains the approval wait before a save or editor turn, until a newer generation arrives", async () => {
    const { session, approvals } = sessionReading([mapDraft(1), mapDraft(1), mapDraft(2)]);
    await session.attach("draft-1");
    session.markAwaitingApproval(HELD);

    await expect(session.prepareTurn()).rejects.toThrow(HELD_MESSAGE);
    expect(session.isEditPending()).toBe(true);

    await session.attach("draft-1"); // Not decided yet: the draft has not advanced.
    expect(session.pendingApproval).toEqual(HELD);

    // The idle refresh re-reads a held draft; the newer generation ends the hold.
    await session.refresh();
    expect(session.pendingApproval).toBeUndefined();
    expect(approvals).toEqual([HELD, undefined]);
    await expect(session.prepareTurn()).resolves.toMatchObject({ draftId: "draft-1", generation: 2 });
  });

  it("lets the person stop waiting and adopt the server draft", async () => {
    const withLayer = mapDraft(1);
    const { session, composition, approvals } = sessionReading([mapDraft(1), withLayer]);
    (withLayer.envelope.body as { layers: unknown[] }).layers = [{ id: "roads", sourceId: "roads", visible: true }];
    await session.attach("draft-1");
    session.markAwaitingApproval(HELD);

    session.discardApprovalHold();
    await session.attach("draft-1");

    expect(session.pendingApproval).toBeUndefined();
    expect(approvals).toEqual([HELD, undefined]);
    expect(composition.state.layers.map((layer) => layer.id)).toEqual(["roads"]);
    await expect(session.prepareTurn()).resolves.toMatchObject({ generation: 1 });
  });
});

describe("editor draft session: work queued behind a held edit", () => {
  it("refuses a queued undo without a second write or a conflict", async () => {
    let rejectHeld!: (error: unknown) => void;
    const replaceDraft = vi
      .fn()
      .mockResolvedValueOnce(mapDraft(2))
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          rejectHeld = reject;
        }),
      );
    const { session, composition } = sessionReading([mapDraft(1)], replaceDraft);
    const { editor, chrome } = editorOver(session, composition);
    await session.attach("draft-1");
    expect(await editor.dispatch([{ name: "setView", view: { zoom: 4 } }])).toEqual({ ok: true });

    const held = editor.dispatch([{ name: "setView", view: { zoom: 6 } }]);
    const undo = editor.applyHistory("undo"); // Queued before the server answers the edit above.
    rejectHeld(new StudioLifecycleApprovalPendingError(HELD));

    expect((await held).approval).toMatchObject({ proposalId: "proposal-1" });
    expect(await undo).toBe(false);
    expect(chrome.setHistoryStatus).toHaveBeenCalledWith(HELD_MESSAGE);
    expect(replaceDraft).toHaveBeenCalledTimes(2);
    await expect(session.prepareTurn()).rejects.toThrow(HELD_MESSAGE); // Held, not conflicted.
  });
});
