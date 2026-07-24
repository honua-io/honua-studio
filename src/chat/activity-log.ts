/**
 * The replayable activity log (honua-studio#6): every tool call/result and
 * annotation event `<honua-studio-chat>` produces is appended here as a
 * structured entry (spec REQ-012: "annotations are visible, removable, and
 * recorded in the activity log like any other context"). `<honua-studio-chat>`
 * owns one `ActivityLog` instance (`.activityLog`, read-only); a sibling
 * `<honua-studio-activity-log>` element renders one via its settable `.log`
 * property — the same "own it vs. render an assigned override" pattern
 * `studio-app-element.ts` already uses for `.studioClient`.
 */

export type ActivityLogEntryType =
  | "user_message_sent"
  | "annotations_attached"
  | "assistant_turn_started"
  | "tool_call_started"
  | "tool_call_completed"
  | "assistant_turn_completed"
  | "assistant_turn_error"
  | "assistant_turn_cancelled"
  | "annotation_added"
  | "annotation_removed"
  // honua-studio#7: the orchestrator's own record of what a tool-call intent
  // actually did to composition state — distinct from `tool_call_completed`
  // (which only records that the model's tool call finished; these two
  // record whether `../mcp/tool-bridge.ts`'s resolution + application
  // succeeded and, in live-session mode, whether the server draft mutation
  // landed).
  | "composition_command_applied"
  | "composition_command_rejected"
  // honua-studio#9: draft/version/publish/rollback actions taken in
  // `<honua-studio-lifecycle-panel>`, logged into the same shared activity
  // log — `detail.kind` carries the finer-grained lifecycle action
  // (`HonuaStudioLifecycleActivityDetail["kind"]` in `../elements/types.js`).
  | "lifecycle_action"
  // honua-studio#10: GP authoring/validation/preview/execution actions taken
  // in `<honua-studio-gp-panel>` — `detail.kind` carries the finer-grained
  // GP action (`HonuaStudioGpActivityDetail["kind"]` in `../elements/types.js`).
  | "gp_action";

export interface ActivityLogEntry {
  /** Monotonic within one log instance, assigned on append (1-based). */
  readonly seq: number;
  readonly type: ActivityLogEntryType;
  /** ISO 8601. Supplied by the log's clock (injectable — see `createActivityLog`'s `clock` option — so fixture replay stays byte-stable). */
  readonly at: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface ActivityLogExport {
  readonly version: 1;
  readonly entries: readonly ActivityLogEntry[];
}

export type Unsubscribe = () => void;

export interface ActivityLog {
  entries(): readonly ActivityLogEntry[];
  append(type: ActivityLogEntryType, detail: Record<string, unknown>): ActivityLogEntry;
  clear(): void;
  /** Replaces the log's contents wholesale (used by `importActivityLogJson`) — `seq` continues from the loaded entries' own max, never resets to collide with future appends. */
  load(entries: readonly ActivityLogEntry[]): void;
  /** Notified after every `append`/`clear`/`load`. */
  subscribe(listener: () => void): Unsubscribe;
  toJSON(): ActivityLogExport;
}

export interface CreateActivityLogOptions {
  /** Defaults to `() => new Date().toISOString()`. Inject a fixed/incrementing clock for deterministic (fixture-replay) tests. */
  clock?: () => string;
}

export function createActivityLog(options: CreateActivityLogOptions = {}): ActivityLog {
  const clock = options.clock ?? (() => new Date().toISOString());
  const listeners = new Set<() => void>();
  let entries: ActivityLogEntry[] = [];
  let seq = 0;

  function notify(): void {
    for (const listener of listeners) listener();
  }

  return {
    entries: () => entries,
    append(type, detail) {
      seq += 1;
      const entry: ActivityLogEntry = { seq, type, at: clock(), detail: { ...detail } };
      entries = [...entries, entry];
      notify();
      return entry;
    },
    clear() {
      entries = [];
      seq = 0;
      notify();
    },
    load(loaded) {
      entries = [...loaded];
      seq = entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    toJSON() {
      return { version: 1, entries };
    },
  };
}

export class InvalidActivityLogExportError extends Error {
  constructor(reason: string) {
    super(`Invalid activity log export: ${reason}`);
    this.name = "InvalidActivityLogExportError";
  }
}

/** Runtime-validates parsed JSON as an {@link ActivityLogExport} — the boundary `.importJson()` uses before calling `ActivityLog.load()`. */
export function parseActivityLogExport(value: unknown): ActivityLogExport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidActivityLogExportError("expected a JSON object.");
  }
  const { version, entries } = value as Record<string, unknown>;
  if (version !== 1) throw new InvalidActivityLogExportError('"version" must be 1.');
  if (!Array.isArray(entries)) throw new InvalidActivityLogExportError('"entries" must be an array.');
  return { version: 1, entries: entries as ActivityLogEntry[] };
}

/** Steps through a fixed list of entries one at a time, re-emitting each via the caller's callback — the "replay API" spec REQ-012 calls for. No timers; every step is caller-driven. */
export interface ActivityLogReplaySession {
  readonly length: number;
  readonly position: number;
  hasNext(): boolean;
  /** Advances one step and returns the entry just emitted, or `undefined` once exhausted. */
  next(): ActivityLogEntry | undefined;
  reset(): void;
}

export function createReplaySession(entries: readonly ActivityLogEntry[]): ActivityLogReplaySession {
  const snapshot = [...entries];
  let position = 0;
  return {
    length: snapshot.length,
    get position() {
      return position;
    },
    hasNext: () => position < snapshot.length,
    next() {
      const entry = snapshot[position];
      if (entry === undefined) return undefined;
      position += 1;
      return entry;
    },
    reset() {
      position = 0;
    },
  };
}
