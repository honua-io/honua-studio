/**
 * `<honua-studio-activity-log>` — a sibling surface (honua-studio#6, spec
 * REQ-012) rendering a `<honua-studio-chat>`'s `ActivityLog`: every tool
 * call/result and annotation event, appended as structured entries. Wire
 * a chat console's log to this element explicitly —
 * `activityLogEl.log = chatEl.activityLog` — the same "own it vs. render an
 * assigned override" pattern `.studioClient`/`.transport` already use
 * elsewhere in this contract, deliberately NOT implicit
 * event-listening-on-a-shared-ancestor magic.
 *
 * Also owns the replay API: step through recorded entries one at a time
 * (`replayNext()`), re-dispatching each as a typed event so a host (a
 * canvas, a future composition engine) can react — and export/import as
 * JSON.
 */
import {
  type ActivityLog,
  type ActivityLogEntry,
  type ActivityLogReplaySession,
  createActivityLog,
  createReplaySession,
  parseActivityLogExport,
} from "../chat/activity-log.js";
import { HonuaStudioElementBase } from "./base-element.js";
import { activityLogStyles, baseElementStyles } from "./styles.js";
import type { HonuaStudioActivityReplayCompleteDetail, HonuaStudioActivityReplayStepDetail } from "./types.js";

export class HonuaStudioActivityLogElement extends HonuaStudioElementBase {
  static get observedAttributes(): string[] {
    return ["label"];
  }

  #log: ActivityLog | undefined;
  #logUnsubscribe: (() => void) | undefined;
  #replay: ActivityLogReplaySession | undefined;
  #replayedSeqs = new Set<number>();

  /** The log this element renders. Defaults to an empty, self-owned `ActivityLog` (an isolated instance, not connected to any chat console) until a host assigns one — see the module doc. */
  public get log(): ActivityLog {
    if (!this.#log) this.log = createActivityLog();
    // The setter above always assigns #log (biome.json disables noNonNullAssertion repo-wide).
    return this.#log!;
  }

  public set log(log: ActivityLog) {
    this.#logUnsubscribe?.();
    this.#log = log;
    this.#replay = undefined;
    this.#replayedSeqs = new Set();
    this.#logUnsubscribe = log.subscribe(() => this.render());
    this.render();
  }

  /** The entries currently rendered. */
  public get entries(): readonly ActivityLogEntry[] {
    return this.log.entries();
  }

  protected onConnect(): void {
    // Ensure the default log (and its render subscription) exists even if
    // a host never assigns one — `.log`'s getter lazily creates + subscribes.
    void this.log;
  }

  protected onDisconnect(): void {
    this.#logUnsubscribe?.();
    this.#logUnsubscribe = undefined;
  }

  /** Starts (or restarts) a replay session over `entries` (defaults to the current log's own entries). */
  public startReplay(entries: readonly ActivityLogEntry[] = this.log.entries()): void {
    this.#replay = createReplaySession(entries);
    this.#replayedSeqs = new Set();
    this.render();
  }

  /** Advances the active replay session one step, dispatching `honua-studio-activity-replay-step` (or `-complete` once exhausted). Starts a session over the current log automatically if none is active. Returns the entry emitted, or `undefined` if the session is already exhausted. */
  public replayNext(): ActivityLogEntry | undefined {
    if (!this.#replay) this.startReplay();
    const session = this.#replay;
    if (!session) return undefined;
    const entry = session.next();
    if (!entry) {
      this.dispatchTypedEvent<HonuaStudioActivityReplayCompleteDetail>("honua-studio-activity-replay-complete", {
        total: session.length,
      });
      return undefined;
    }
    this.#replayedSeqs.add(entry.seq);
    this.dispatchTypedEvent<HonuaStudioActivityReplayStepDetail>("honua-studio-activity-replay-step", {
      entry,
      index: session.position - 1,
      total: session.length,
    });
    this.render();
    if (!session.hasNext()) {
      this.dispatchTypedEvent<HonuaStudioActivityReplayCompleteDetail>("honua-studio-activity-replay-complete", {
        total: session.length,
      });
    }
    return entry;
  }

  /** Resets the active replay session's position to the start, without discarding it. */
  public resetReplay(): void {
    this.#replay?.reset();
    this.#replayedSeqs = new Set();
    this.render();
  }

  /** Serializes the current log to JSON (`{ version: 1, entries }`). */
  public exportJson(): string {
    return JSON.stringify(this.log.toJSON());
  }

  /** Replaces the current log's entries with a previously-exported JSON string. Throws `InvalidActivityLogExportError` for malformed input — the log is left untouched on failure. */
  public importJson(json: string): void {
    const parsed = parseActivityLogExport(JSON.parse(json));
    this.log.load(parsed.entries);
  }

  protected render(): void {
    const label = this.getAttribute("label") ?? "Activity Log";
    const entries = this.entries;
    const replay = this.#replay;
    this.setShadowHtml(`
      <style>${baseElementStyles()}${activityLogStyles()}</style>
      <section class="activity-log hn-panel" part="panel" aria-label="${escapeHtml(label)}" data-testid="studio-activity-log">
        <div>
          <h2 class="hn-panel-title">${escapeHtml(label)}</h2>
          <p class="hn-register" data-testid="studio-activity-log-count">${entries.length} ${entries.length === 1 ? "entry" : "entries"}</p>
        </div>
        <ul class="activity-log-entries" aria-live="polite" data-testid="studio-activity-log-entries">
          ${
            entries.length === 0
              ? `<li class="hn-muted">No activity yet.</li>`
              : entries.map((entry) => renderEntry(entry, this.#replayedSeqs.has(entry.seq))).join("")
          }
        </ul>
        <div class="activity-log-controls" role="group" aria-label="Replay controls">
          <button type="button" class="hn-btn hn-btn--sm" data-testid="studio-activity-log-replay-start">Start replay</button>
          <button type="button" class="hn-btn hn-btn--sm" data-testid="studio-activity-log-replay-next" ${replay && !replay.hasNext() ? "disabled" : ""}>Step</button>
          <span class="hn-register" data-testid="studio-activity-log-replay-position">${replay ? `${replay.position} / ${replay.length}` : ""}</span>
        </div>
      </section>
    `);

    const root = this.shadowRoot;
    const signal = this.connectedSignal;
    root
      ?.querySelector('[data-testid="studio-activity-log-replay-start"]')
      ?.addEventListener("click", () => this.startReplay(), { signal });
    root
      ?.querySelector('[data-testid="studio-activity-log-replay-next"]')
      ?.addEventListener("click", () => this.replayNext(), { signal });
  }
}

function renderEntry(entry: ActivityLogEntry, replayed: boolean): string {
  return `
    <li class="activity-log-entry${replayed ? " activity-log-entry--replayed" : ""}" data-testid="studio-activity-log-entry" data-entry-seq="${entry.seq}" data-entry-type="${escapeHtml(entry.type)}">
      <span class="activity-log-entry-type">${escapeHtml(entry.type)}</span>
      <span class="activity-log-entry-detail" data-testid="studio-activity-log-entry-detail">${escapeHtml(summarizeDetail(entry))}</span>
    </li>`;
}

function summarizeDetail(entry: ActivityLogEntry): string {
  try {
    return JSON.stringify(entry.detail);
  } catch {
    return "";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
