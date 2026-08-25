/**
 * Undo/redo history and the server-draft sync seam (honua-studio#8; AD-8,
 * `.specifica/studio-v0/spec.md`).
 *
 * AD-8 is load-bearing: composition state is **server-draft-backed**. The
 * reducer (`reducer.ts`) is a pure client-side projection/merge engine, not
 * the source of truth; `CompositionHistory` here is the client's revision
 * stack, and `DraftSync` is what keeps that stack's current revision
 * persisted to (and reconciled with) a Studio package lifecycle draft.
 * "Undo/redo maps to draft revisions" (AD-8's own words) — in v0 that means
 * every `CompositionHistory.apply()` both pushes a local revision AND (when
 * a `DraftSync` is attached) fires an `apply()` against the draft; `undo()`
 * moves the local pointer back and re-syncs the draft to the restored
 * state, so the draft's own `generation` history becomes, in effect, the
 * durable half of the undo stack.
 *
 * ## Why {@link CompositionDraftStore} is an interface, not an SDK import
 *
 * The real implementation is `@honua/sdk-js/studio`'s
 * `HonuaStudioLifecycleClient.drafts`, and the adapter onto it now exists
 * and is compiler-checked: `../lifecycle/composition-draft-store.ts`. This
 * module still declares the seam as a structural interface for a reason
 * that has nothing to do with the SDK's release history:
 *
 *  - **{@link FixtureDraftStore} is the other implementation.** NFR-001
 *    requires a deterministic, model- and network-free fixture mode, and
 *    that mode has no HTTP client to hand `DraftSync`. Two implementations
 *    means an interface.
 *  - **This module must not import the SDK's lifecycle client.** Everything
 *    under `src/composition/**` is agent-reachable, and the human gate
 *    (spec REQ-009, `test/lifecycle/human-gate.test.ts`) is enforced partly
 *    by the fact that no file here can reach a client with
 *    publish/rollback methods on it. Depending on a narrow three-method
 *    interface is what keeps that provable by inspection.
 *
 * The seam's field and method names are still the SDK's
 * (`draftId`/`generation`/`envelope.body`, `create`/`get`/`replace`,
 * `generation`-conflict as a distinguishable error), so the adapter is a
 * projection, not a translation layer.
 *
 * @module
 */

import type { CompositionCommand } from "./commands.js";
import type { CompositionState } from "./model.js";
import { type CompositionApplyResult, type CompositionDiff, applyCompositionCommand } from "./reducer.js";

// ---------------------------------------------------------------------------
// Undo/redo revision stack
// ---------------------------------------------------------------------------

export interface CompositionRevision {
  readonly state: CompositionState;
  /** The command that produced this revision from the previous one; `undefined` for the initial revision. */
  readonly command?: CompositionCommand;
  readonly diff?: CompositionDiff;
  readonly timestamp: string;
}

export interface CompositionHistoryOptions {
  readonly now?: () => string;
  /** Caps the undo stack (oldest revisions drop first); redo stack is unaffected. `undefined` (default) means unbounded. */
  readonly maxRevisions?: number;
  readonly draftSync?: DraftSync;
}

/**
 * A linear undo/redo revision stack over {@link CompositionState}. `apply()`
 * always pushes a new revision and clears any pending redo stack (standard
 * editor semantics — redo is only valid immediately after undo, not after a
 * fresh edit). Every mutating method is synchronous over local state; when a
 * {@link DraftSync} is attached, the corresponding draft sync is fired but
 * NOT awaited by these methods — callers that need to know sync landed (or
 * conflicted) use `draftSync` directly, or await {@link CompositionHistory.flush}.
 */
export class CompositionHistory {
  readonly #now: () => string;
  readonly #maxRevisions: number | undefined;
  readonly #draftSync: DraftSync | undefined;
  #undoStack: CompositionRevision[];
  #redoStack: CompositionRevision[] = [];
  #pendingSync: Promise<unknown> = Promise.resolve();

  public constructor(initialState: CompositionState, options: CompositionHistoryOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#maxRevisions = options.maxRevisions;
    this.#draftSync = options.draftSync;
    this.#undoStack = [{ state: initialState, timestamp: this.#now() }];
  }

  public get current(): CompositionState {
    return this.#currentRevision().state;
  }

  public get draftSync(): DraftSync | undefined {
    return this.#draftSync;
  }

  public canUndo(): boolean {
    return this.#undoStack.length > 1;
  }

  public canRedo(): boolean {
    return this.#redoStack.length > 0;
  }

  public revisions(): readonly CompositionRevision[] {
    return [...this.#undoStack];
  }

  /** Applies `input` through the reducer, pushes the resulting revision, and returns the diff. Throws {@link CompositionCommandError} on rejection — the stack is untouched on failure. */
  public apply(input: CompositionCommand | unknown): CompositionDiff {
    const result: CompositionApplyResult = applyCompositionCommand(this.current, input);
    this.#redoStack = [];
    this.#pushRevision({
      state: result.state,
      command: result.diff.command,
      diff: result.diff,
      timestamp: this.#now(),
    });
    this.#sync(result.state);
    return result.diff;
  }

  /** Moves one revision back, syncing the restored state to the draft. Returns the restored state, or `undefined` if already at the initial revision. */
  public undo(): CompositionState | undefined {
    if (!this.canUndo()) return undefined;
    const revision = this.#undoStack.pop();
    if (!revision) return undefined;
    this.#redoStack.push(revision);
    const restored = this.current;
    this.#sync(restored);
    return restored;
  }

  /** Moves one revision forward. Returns the restored state, or `undefined` if there is nothing to redo. */
  public redo(): CompositionState | undefined {
    const revision = this.#redoStack.pop();
    if (!revision) return undefined;
    this.#undoStack.push(revision);
    this.#sync(revision.state);
    return revision.state;
  }

  /** Resolves once every `DraftSync.apply()` call fired by `apply()`/`undo()`/`redo()` so far has settled (fulfilled or rejected) — awaits the batching queue, does not throw. */
  public async flush(): Promise<void> {
    await this.#pendingSync;
  }

  /**
   * Pushes `state` as a new revision WITHOUT running it through the reducer
   * and WITHOUT firing `DraftSync` (honua-studio#7, AD-8: "the browser
   * renders live state, it does not own it"). For when an external
   * authority — a Studio lifecycle draft, already mutated server-side by an
   * MCP tool call the caller just made directly — reports the resulting
   * state, and the local stack needs to reflect it without re-deriving or
   * re-syncing something that IS the sync target. Clears the redo stack,
   * exactly like `apply()`.
   */
  public replaceState(state: CompositionState): void {
    this.#redoStack = [];
    this.#pushRevision({ state, timestamp: this.#now() });
  }

  #currentRevision(): CompositionRevision {
    const revision = this.#undoStack[this.#undoStack.length - 1];
    if (!revision) throw new Error("CompositionHistory: undo stack is unexpectedly empty");
    return revision;
  }

  #pushRevision(revision: CompositionRevision): void {
    this.#undoStack.push(revision);
    if (this.#maxRevisions !== undefined && this.#undoStack.length > this.#maxRevisions) {
      this.#undoStack.splice(0, this.#undoStack.length - this.#maxRevisions);
    }
  }

  #sync(state: CompositionState): void {
    if (!this.#draftSync) return;
    // Chained onto the existing pending-sync promise (not fired independently)
    // so `flush()` observes every sync call in order, and a rejected sync
    // never becomes an unhandled rejection.
    this.#pendingSync = this.#pendingSync.then(
      () => this.#draftSync?.apply(state),
      () => this.#draftSync?.apply(state),
    );
  }
}

// ---------------------------------------------------------------------------
// Draft store — the structural seam onto the SDK's Studio lifecycle client
// ---------------------------------------------------------------------------

/** The envelope body a composition draft carries — mirrors `StudioPackageEnvelope.body` on the real lifecycle client. */
export interface CompositionDraftEnvelope {
  readonly body: CompositionState;
}

/** Mirrors `StudioPackageDraft` (`@honua/sdk-js`'s `src/studio/lifecycle-types.ts`) restricted to the fields this module reads. */
export interface CompositionDraft {
  readonly draftId: string;
  readonly itemId?: string;
  readonly packageKey: string;
  readonly generation: number;
  readonly envelope: CompositionDraftEnvelope;
}

/** Mirrors `StudioPackageDraftCreateRequest`. */
export interface CompositionDraftCreateRequest {
  readonly packageKey: string;
  readonly itemId?: string;
  readonly envelope: CompositionDraftEnvelope;
}

/** Mirrors `StudioPackageDraftReplaceRequest` — omitting `generation` means last-write-wins; passing the last-seen value gets strict optimistic-concurrency checking. */
export interface CompositionDraftReplaceRequest {
  readonly packageKey: string;
  readonly envelope: CompositionDraftEnvelope;
  readonly generation?: number;
}

/**
 * Structural mirror of `HonuaStudioLifecycleClient.drafts`
 * (`create`/`get`/`replace`) from `@honua/sdk-js`'s `src/studio/lifecycle-client.ts`
 * — see this module's doc for why this is a local interface rather than an
 * import. Any object with these three methods (the real lifecycle client's
 * `.drafts` resource group, a thin adapter over it, or {@link FixtureDraftStore})
 * satisfies {@link DraftSync}.
 */
export interface CompositionDraftStore {
  create(request: CompositionDraftCreateRequest): Promise<CompositionDraft>;
  get(draftId: string): Promise<CompositionDraft>;
  replace(draftId: string, request: CompositionDraftReplaceRequest): Promise<CompositionDraft>;
}

export type CompositionDraftErrorCode = "generation-conflict" | "not-found" | "validation" | "internal" | "unknown";

/** Mirrors `HonuaStudioError`'s `.code` discriminant (`src/studio/lifecycle-errors.ts`) — a `CompositionDraftStore` implementation should throw this (or something `isCompositionDraftConflict` recognizes) rather than a bare `Error`. */
export class CompositionDraftError extends Error {
  public readonly code: CompositionDraftErrorCode;

  public constructor(code: CompositionDraftErrorCode, message: string, options: { readonly cause?: unknown } = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "CompositionDraftError";
    this.code = code;
  }
}

/** True only for the optimistic-concurrency discriminant — mirrors `isHonuaStudioGenerationConflict`. */
export function isCompositionDraftConflict(error: unknown): error is CompositionDraftError {
  return error instanceof CompositionDraftError && error.code === "generation-conflict";
}

// ---------------------------------------------------------------------------
// DraftSync — apply(state) with single-flight batching + reload/rebase
// ---------------------------------------------------------------------------

export interface DraftSyncConflict {
  readonly draftId: string;
  readonly staleGeneration: number;
  readonly serverGeneration: number;
  readonly serverState: CompositionState;
}

/** Given the state that failed to apply (`local`) and the freshly reloaded server state (`server`), returns the state to retry with. Default: `local` wins outright (the client's intent is retried against the fresh generation) — see the module doc's rebase note for why a smarter merge is a future extension, not this module's job. */
export type CompositionDraftRebase = (local: CompositionState, server: CompositionState) => CompositionState;

export interface DraftSyncOptions {
  readonly store: CompositionDraftStore;
  readonly packageKey: string;
  readonly itemId?: string;
  readonly onConflict?: (conflict: DraftSyncConflict) => void;
  readonly rebase?: CompositionDraftRebase;
}

const defaultRebase: CompositionDraftRebase = (local) => local;

/**
 * Keeps a {@link CompositionState} synced to one {@link CompositionDraftStore}
 * draft. `apply(state)`:
 *
 *  - Creates the draft on the first call, replaces it (with the last-known
 *    `generation`) on every call after.
 *  - Is **single-flight**: overlapping `apply()` calls never race two
 *    concurrent requests. A call that arrives while one is already in
 *    flight does not start a second request — it records its state as the
 *    latest pending intent and shares the in-flight flush loop's eventual
 *    result.
 *  - Is **batched**: if three `apply()` calls land before the first
 *    request even starts, only the LAST one's state is ever sent — a rapid
 *    sequence of reducer commands (e.g. an agent's multi-step refinement)
 *    produces one draft write, not N.
 *  - On a `generation-conflict` (409): reloads the draft (`store.get`),
 *    invokes `onConflict` with the server's state/generation, computes a
 *    retry state via `rebase` (default: local intent wins, replayed against
 *    the fresh generation), and retries automatically — the caller's
 *    `apply()` promise does not reject for a conflict it already recovered
 *    from.
 */
export class DraftSync {
  readonly #store: CompositionDraftStore;
  readonly #packageKey: string;
  readonly #itemId: string | undefined;
  readonly #onConflict: ((conflict: DraftSyncConflict) => void) | undefined;
  readonly #rebase: CompositionDraftRebase;
  #draft: CompositionDraft | undefined;
  #pendingState: CompositionState | undefined;
  #flushLoop: Promise<CompositionDraft> | undefined;

  public constructor(options: DraftSyncOptions) {
    this.#store = options.store;
    this.#packageKey = options.packageKey;
    this.#itemId = options.itemId;
    this.#onConflict = options.onConflict;
    this.#rebase = options.rebase ?? defaultRebase;
  }

  public get draftId(): string | undefined {
    return this.#draft?.draftId;
  }

  public get generation(): number | undefined {
    return this.#draft?.generation;
  }

  public apply(state: CompositionState): Promise<CompositionDraft> {
    this.#pendingState = state;
    if (!this.#flushLoop) {
      this.#flushLoop = this.#runFlushLoop().finally(() => {
        this.#flushLoop = undefined;
      });
    }
    return this.#flushLoop;
  }

  async #runFlushLoop(): Promise<CompositionDraft> {
    let result: CompositionDraft | undefined;
    for (;;) {
      // Yield one microtask tick before reading #pendingState: `apply()`
      // itself is synchronous, so every call made in the same synchronous
      // burst as the one that started this loop (the common "several
      // reducer commands in a row" case) has a chance to overwrite
      // #pendingState BEFORE the first request is ever dispatched — that is
      // what makes this a true batching coalesce (only the last state in a
      // burst is sent) rather than "first request always wins, rest queue
      // behind it".
      await Promise.resolve();
      if (this.#pendingState === undefined) break;
      const toSend = this.#pendingState;
      this.#pendingState = undefined;
      result = await this.#flushOnce(toSend);
    }
    if (!result) throw new Error("DraftSync: flush loop completed without a result — this is a bug.");
    return result;
  }

  async #flushOnce(state: CompositionState): Promise<CompositionDraft> {
    if (!this.#draft) {
      this.#draft = await this.#store.create({
        packageKey: this.#packageKey,
        ...(this.#itemId !== undefined ? { itemId: this.#itemId } : {}),
        envelope: { body: state },
      });
      return this.#draft;
    }
    try {
      this.#draft = await this.#store.replace(this.#draft.draftId, {
        packageKey: this.#packageKey,
        envelope: { body: state },
        generation: this.#draft.generation,
      });
      return this.#draft;
    } catch (error) {
      if (!isCompositionDraftConflict(error)) throw error;
      return this.#reloadAndRebase(state);
    }
  }

  async #reloadAndRebase(state: CompositionState): Promise<CompositionDraft> {
    const draftId = this.#draft?.draftId;
    if (!draftId) throw new Error("DraftSync: generation conflict reported before a draft existed — this is a bug.");
    const server = await this.#store.get(draftId);
    const conflict: DraftSyncConflict = {
      draftId: server.draftId,
      staleGeneration: this.#draft?.generation ?? server.generation,
      serverGeneration: server.generation,
      serverState: server.envelope.body,
    };
    this.#draft = server;
    this.#onConflict?.(conflict);
    const retryState = this.#rebase(state, server.envelope.body);
    // Queue the rebased retry as the next flush-loop iteration rather than
    // recursing directly — if a newer `apply()` call already queued a
    // fresher `#pendingState` while this reload was in flight, that fresher
    // intent wins (still against the now-current generation); only fall
    // back to the rebased retry when nothing newer is waiting.
    this.#pendingState = this.#pendingState ?? retryState;
    return server;
  }
}

// ---------------------------------------------------------------------------
// FixtureDraftStore — in-memory CompositionDraftStore for tests + fixture mode
// ---------------------------------------------------------------------------

export interface FixtureDraftStoreOptions {
  readonly now?: () => string;
  readonly idPrefix?: string;
}

/**
 * Pure in-memory {@link CompositionDraftStore} — no network, no server. This
 * is the store the fixture-conversation mode (`fixture-conversation.ts`,
 * NFR-001) and this module's own tests use, and it is also the reference
 * implementation the real lifecycle-client adapter (see this module's doc)
 * must remain behaviorally compatible with: `generation` starts at `1` on
 * `create`, increments by exactly `1` on every successful `replace`, and
 * `replace` with a stale `generation` throws
 * {@link CompositionDraftError} with `code: "generation-conflict"` — the
 * same optimistic-concurrency contract `HonuaStudioLifecycleClient` documents.
 */
export class FixtureDraftStore implements CompositionDraftStore {
  readonly #now: () => string;
  readonly #idPrefix: string;
  readonly #drafts = new Map<string, CompositionDraft>();
  #nextId = 1;

  public constructor(options: FixtureDraftStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#idPrefix = options.idPrefix ?? "fixture-draft";
  }

  public async create(request: CompositionDraftCreateRequest): Promise<CompositionDraft> {
    void this.#now();
    const draftId = `${this.#idPrefix}-${this.#nextId}`;
    this.#nextId += 1;
    const draft: CompositionDraft = {
      draftId,
      itemId: request.itemId ?? draftId,
      packageKey: request.packageKey,
      generation: 1,
      envelope: request.envelope,
    };
    this.#drafts.set(draftId, draft);
    return cloneDraft(draft);
  }

  public async get(draftId: string): Promise<CompositionDraft> {
    const draft = this.#drafts.get(draftId);
    if (!draft) throw new CompositionDraftError("not-found", `FixtureDraftStore: no draft "${draftId}"`);
    return cloneDraft(draft);
  }

  public async replace(draftId: string, request: CompositionDraftReplaceRequest): Promise<CompositionDraft> {
    const existing = this.#drafts.get(draftId);
    if (!existing) throw new CompositionDraftError("not-found", `FixtureDraftStore: no draft "${draftId}"`);
    if (request.generation !== undefined && request.generation !== existing.generation) {
      throw new CompositionDraftError(
        "generation-conflict",
        `FixtureDraftStore: draft "${draftId}" generation ${request.generation} is stale (current: ${existing.generation})`,
      );
    }
    const next: CompositionDraft = {
      ...existing,
      packageKey: request.packageKey,
      generation: existing.generation + 1,
      envelope: request.envelope,
    };
    this.#drafts.set(draftId, next);
    return cloneDraft(next);
  }

  /** Test/simulation hook: bump a draft's generation out from under `DraftSync` (an "external writer") without going through `replace`, to exercise the conflict + reload/rebase path deterministically. */
  public simulateExternalWrite(draftId: string, envelope: CompositionDraftEnvelope): CompositionDraft {
    const existing = this.#drafts.get(draftId);
    if (!existing) throw new CompositionDraftError("not-found", `FixtureDraftStore: no draft "${draftId}"`);
    const next: CompositionDraft = { ...existing, generation: existing.generation + 1, envelope };
    this.#drafts.set(draftId, next);
    return cloneDraft(next);
  }
}

function cloneDraft(draft: CompositionDraft): CompositionDraft {
  return structuredClone(draft);
}
