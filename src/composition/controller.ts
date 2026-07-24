/**
 * A tiny reactive wrapper over {@link CompositionHistory} plus an ephemeral
 * selection (honua-studio#8 build item 6): the one piece of DOM-adjacent
 * state `<honua-studio-canvas>` needs that composition state itself does not
 * carry (a target the user just clicked, before any command references it).
 * Still pure data + subscription bookkeeping — no DOM reference lives here;
 * the element (`../elements/studio-canvas-element.ts`) is the only thing
 * that touches `document`.
 *
 * @module
 */

import type { CompositionCommand } from "./commands.js";
import { CompositionHistory, type CompositionHistoryOptions } from "./history.js";
import type { CompositionState, CompositionTarget } from "./model.js";
import type { CompositionDiff } from "./reducer.js";

export type CompositionControllerListener = () => void;
export type Unsubscribe = () => void;

/**
 * Wraps one {@link CompositionHistory}, adds an ephemeral (non-undoable,
 * non-synced) selection, and notifies subscribers after every state-shaping
 * operation (`apply`/`undo`/`redo`/`select`) — the minimal reactive surface
 * a rendering element needs.
 */
export class CompositionController {
  readonly #history: CompositionHistory;
  readonly #listeners = new Set<CompositionControllerListener>();
  #selection: readonly CompositionTarget[] = [];

  public constructor(initialState: CompositionState, options: CompositionHistoryOptions = {}) {
    this.#history = new CompositionHistory(initialState, options);
  }

  public get history(): CompositionHistory {
    return this.#history;
  }

  public get state(): CompositionState {
    return this.#history.current;
  }

  public get selection(): readonly CompositionTarget[] {
    return this.#selection;
  }

  public canUndo(): boolean {
    return this.#history.canUndo();
  }

  public canRedo(): boolean {
    return this.#history.canRedo();
  }

  /** Applies a command through the underlying history. Throws {@link CompositionCommandError} on rejection — the controller does not swallow it, so a host can surface the failure. */
  public apply(input: CompositionCommand | unknown): CompositionDiff {
    const diff = this.#history.apply(input);
    this.#notify();
    return diff;
  }

  public undo(): boolean {
    const restored = this.#history.undo();
    if (restored === undefined) return false;
    this.#notify();
    return true;
  }

  public redo(): boolean {
    const restored = this.#history.redo();
    if (restored === undefined) return false;
    this.#notify();
    return true;
  }

  /** Sets the current deictic selection — targets a chat message can reference as "THIS" (honua-studio#8 REQ-012 / honua-studio#6's annotation chips). Replaces any prior selection. */
  public select(targets: readonly CompositionTarget[]): void {
    this.#selection = [...targets];
    this.#notify();
  }

  public clearSelection(): void {
    if (this.#selection.length === 0) return;
    this.#selection = [];
    this.#notify();
  }

  public subscribe(listener: CompositionControllerListener): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
