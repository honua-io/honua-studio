import type { CompositionController } from "../composition/controller.js";
import { createEmptyCompositionState } from "../composition/model.js";
import type { StudioLifecycleClient } from "../lifecycle/lifecycle-client.js";
import { WorkspaceDraftBinding } from "../lifecycle/workspace-draft.js";
import { MAP_COMPOSITION_ENVELOPE, toCompositionDraftBody } from "../mcp/composition-envelope.js";
import { type EpochToken, StalenessEpoch } from "./staleness-epoch.js";
import { WORKSPACE_SESSION_CHANGED, type WorkspaceAuthority } from "./workspace-authority.js";

export type WorkspaceDraftIdentity = { draftId: string; generation: number; packageKey: string };

/** Element callbacks; the public methods stay the seam hosts and tests can wrap. */
export interface WorkspaceDraftSessionHooks {
  readonly prepareWorkspaceTurn: () => Promise<unknown>;
  readonly attachWorkspaceDraft: (draftId: string) => Promise<void>;
  readonly hasDirtyForm: () => boolean;
  readonly settleStyleEdits: () => Promise<void>;
  /** Runs when an attach targets a draft other than the active one. */
  readonly onDraftRequested: () => void;
  /** Runs before the active map changes to another draft. */
  readonly beforeMapSwitch: (draftId: string) => void;
  readonly afterMapSwitch: () => void;
  readonly onDraftChange: (identity: WorkspaceDraftIdentity | undefined) => void;
}

/**
 * The authorized server draft the workspace edits. Every read or write of it runs through one queue, so
 * a later operation observes the result of an earlier one; `activeMap` advances when another draft
 * becomes active.
 */
export class WorkspaceDraftSession {
  readonly activeMap = new StalenessEpoch();
  #binding: WorkspaceDraftBinding | undefined;
  #conflict = false;
  historyBusy = false;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly authority: WorkspaceAuthority,
    private readonly composition: CompositionController,
    private readonly hooks: WorkspaceDraftSessionHooks,
  ) {}

  get binding(): WorkspaceDraftBinding | undefined {
    return this.#binding;
  }

  get identity(): WorkspaceDraftIdentity | undefined {
    return this.#binding?.identity;
  }

  /** Blocks further edits until the human explicitly reloads the draft. */
  markConflict(): void {
    this.#conflict = true;
  }

  /** Runs `task` after every queued draft operation; a failure never blocks the queue. */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async settled(): Promise<void> {
    await this.#queue;
  }

  isEditPending(): boolean {
    return this.historyBusy || this.#conflict || this.hooks.hasDirtyForm();
  }

  /** Forgets the draft of a former authority. */
  detach(): void {
    this.#binding = undefined;
    this.#conflict = false;
  }

  rebind(client: StudioLifecycleClient): void {
    this.#binding?.rebind(client);
  }

  announce(): void {
    this.hooks.onDraftChange(this.identity);
  }

  async create(packageKey: string): Promise<WorkspaceDraftIdentity> {
    const key = packageKey.trim();
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(key))
      throw new Error("Use 1–200 letters, numbers, dots, dashes or underscores for the package key.");
    const generation = this.authority.epoch.current;
    await this.hooks.prepareWorkspaceTurn();
    this.authority.epoch.assertCurrent(generation, WORKSPACE_SESSION_CHANGED);
    const client = this.authority.lifecycleClient();
    const created = await client.createDraft({
      packageKey: key,
      envelope: {
        ...MAP_COMPOSITION_ENVELOPE,
        body: toCompositionDraftBody(createEmptyCompositionState(), key),
      },
    });
    this.authority.epoch.assertCurrent(generation, WORKSPACE_SESSION_CHANGED);
    await this.hooks.attachWorkspaceDraft(created.draftId);
    const identity = this.identity;
    if (!identity || identity.draftId !== created.draftId) throw new Error("The created draft was not attached.");
    return identity;
  }

  attach(draftId: string, mayAccept?: () => void): Promise<void> {
    if (draftId !== this.identity?.draftId) this.hooks.onDraftRequested();
    const generation = this.authority.epoch.current;
    return this.enqueue(() => this.observe(draftId, generation, mayAccept));
  }

  async observe(draftId: string, generation: EpochToken, mayAccept?: () => void): Promise<void> {
    this.#requireAcceptable(generation, mayAccept);
    const previous = this.identity;
    // Observe prospectively: a refused read must not advance the active binding's generation.
    const binding = new WorkspaceDraftBinding(this.authority.lifecycleClient());
    const state = await binding.observe(draftId);
    this.#requireAcceptable(generation, mayAccept);
    // A same-principal lease can renew while the prospective GET is in flight.
    // Adopt its observed state with the current transport, not the expired lease.
    binding.rebind(this.authority.lifecycleClient());
    const switchesMap = previous?.draftId !== draftId;
    if (switchesMap) {
      this.hooks.beforeMapSwitch(draftId);
      this.activeMap.next();
    }
    this.#binding = binding;
    this.#conflict = false;
    const reset = switchesMap || previous?.generation !== binding.identity?.generation;
    const attach = reset
      ? this.composition.resetBaseline.bind(this.composition)
      : this.composition.replaceState.bind(this.composition);
    attach({
      ...state,
      pins: switchesMap ? state.pins : this.composition.state.pins,
      annotations: switchesMap ? state.annotations : this.composition.state.annotations,
    });
    if (switchesMap) {
      this.composition.clearSelection();
      this.hooks.afterMapSwitch();
    }
    this.announce();
  }

  async refresh(): Promise<boolean> {
    const binding = this.#binding;
    const generation = this.authority.epoch.current;
    await this.#queue;
    const identity = binding?.identity;
    if (!identity || binding !== this.#binding || this.isEditPending()) return false;
    try {
      await this.hooks.attachWorkspaceDraft(identity.draftId);
    } catch (error) {
      if (!this.authority.epoch.isCurrent(generation) || this.isEditPending()) return false;
      throw error;
    }
    return this.authority.epoch.isCurrent(generation) && !this.hooks.hasDirtyForm();
  }

  async prepareTurn(): Promise<WorkspaceDraftIdentity | undefined> {
    await this.hooks.settleStyleEdits();
    await this.#queue;
    if (this.isEditPending())
      throw new Error("Save or explicitly reload the pending Studio edits before sending a workspace turn.");
    return this.identity;
  }

  #requireAcceptable(generation: EpochToken, mayAccept: (() => void) | undefined): void {
    this.authority.epoch.assertCurrent(generation, WORKSPACE_SESSION_CHANGED);
    mayAccept?.();
    if (this.hooks.hasDirtyForm()) throw new Error("Save pending Studio edits before attaching a draft.");
  }
}
