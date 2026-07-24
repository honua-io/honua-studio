import { describe, expect, it, vi } from "vitest";

import {
  type ActivityLogEntry,
  InvalidActivityLogExportError,
  createActivityLog,
  createReplaySession,
  parseActivityLogExport,
} from "../../src/chat/activity-log.js";

describe("chat/activity-log", () => {
  it("append assigns a monotonic 1-based seq and an injectable clock's timestamp", () => {
    let tick = 0;
    const log = createActivityLog({
      clock: () => {
        tick += 1;
        return `t${tick}`;
      },
    });
    const first = log.append("user_message_sent", { text: "hi" });
    const second = log.append("annotation_added", { id: "a1" });
    expect(first).toEqual({ seq: 1, type: "user_message_sent", at: "t1", detail: { text: "hi" } });
    expect(second).toEqual({ seq: 2, type: "annotation_added", at: "t2", detail: { id: "a1" } });
    expect(log.entries()).toEqual([first, second]);
  });

  it("clear() empties entries and resets the seq counter", () => {
    const log = createActivityLog({ clock: () => "t" });
    log.append("user_message_sent", {});
    log.clear();
    expect(log.entries()).toEqual([]);
    const next = log.append("user_message_sent", {});
    expect(next.seq).toBe(1);
  });

  it("subscribe fires on append, clear, and load; unsubscribe stops further notifications", () => {
    const log = createActivityLog({ clock: () => "t" });
    const listener = vi.fn();
    const unsubscribe = log.subscribe(listener);

    log.append("user_message_sent", {});
    expect(listener).toHaveBeenCalledTimes(1);
    log.clear();
    expect(listener).toHaveBeenCalledTimes(2);
    log.load([{ seq: 5, type: "annotation_added", at: "t", detail: {} }]);
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    log.append("user_message_sent", {});
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("load() continues the seq counter from the loaded entries' max, never colliding with future appends", () => {
    const log = createActivityLog({ clock: () => "t" });
    log.load([
      { seq: 3, type: "user_message_sent", at: "t", detail: {} },
      { seq: 7, type: "annotation_added", at: "t", detail: {} },
    ]);
    const appended = log.append("annotation_removed", { id: "x" });
    expect(appended.seq).toBe(8);
  });

  it("toJSON()/parseActivityLogExport() round-trip", () => {
    const log = createActivityLog({ clock: () => "t" });
    log.append("user_message_sent", { text: "hi" });
    const exported = JSON.parse(JSON.stringify(log.toJSON()));
    const parsed = parseActivityLogExport(exported);
    expect(parsed).toEqual({ version: 1, entries: log.entries() });
  });

  it("parseActivityLogExport rejects malformed input", () => {
    expect(() => parseActivityLogExport(null)).toThrow(InvalidActivityLogExportError);
    expect(() => parseActivityLogExport({ version: 2, entries: [] })).toThrow(InvalidActivityLogExportError);
    expect(() => parseActivityLogExport({ version: 1, entries: "nope" })).toThrow(InvalidActivityLogExportError);
  });
});

describe("chat/activity-log replay session", () => {
  const entries: ActivityLogEntry[] = [
    { seq: 1, type: "user_message_sent", at: "t1", detail: {} },
    { seq: 2, type: "tool_call_started", at: "t2", detail: {} },
    { seq: 3, type: "tool_call_completed", at: "t3", detail: {} },
  ];

  it("steps through entries one at a time in order", () => {
    const session = createReplaySession(entries);
    expect(session.length).toBe(3);
    expect(session.position).toBe(0);
    expect(session.hasNext()).toBe(true);
    expect(session.next()).toEqual(entries[0]);
    expect(session.position).toBe(1);
    expect(session.next()).toEqual(entries[1]);
    expect(session.next()).toEqual(entries[2]);
    expect(session.hasNext()).toBe(false);
    expect(session.next()).toBeUndefined();
  });

  it("reset() rewinds to the start without discarding the entry list", () => {
    const session = createReplaySession(entries);
    session.next();
    session.next();
    session.reset();
    expect(session.position).toBe(0);
    expect(session.next()).toEqual(entries[0]);
  });

  it("is a snapshot — mutating the source array afterward doesn't affect an in-progress session", () => {
    const source = [...entries];
    const session = createReplaySession(source);
    source.push({ seq: 4, type: "annotation_added" as const, at: "t4", detail: {} });
    expect(session.length).toBe(3);
  });
});
