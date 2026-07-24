// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { createActivityLog } from "../../src/chat/activity-log.js";
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioActivityLogElement } from "../../src/elements/studio-activity-log-element.js";

registerAllStudioElements();

function mountLog(): HonuaStudioActivityLogElement {
  const el = document.createElement("honua-studio-activity-log") as HonuaStudioActivityLogElement;
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("<honua-studio-activity-log>", () => {
  it("renders 'No activity yet.' with an assigned empty log", () => {
    const el = mountLog();
    expect(el.shadowRoot?.querySelector('[data-testid="studio-activity-log-entries"]')?.textContent).toContain(
      "No activity yet.",
    );
    expect(el.shadowRoot?.querySelector('[data-testid="studio-activity-log-count"]')?.textContent).toContain("0 entries");
  });

  it("re-renders reactively when its assigned .log receives an append (subscribe wiring)", () => {
    const el = mountLog();
    const log = createActivityLog({ clock: () => "t" });
    el.log = log;
    log.append("user_message_sent", { text: "hi" });

    const entries = el.shadowRoot?.querySelectorAll('[data-testid="studio-activity-log-entry"]');
    expect(entries?.length).toBe(1);
    expect(entries?.[0]?.getAttribute("data-entry-type")).toBe("user_message_sent");
  });

  it("startReplay()/replayNext() step through entries in order, dispatching honua-studio-activity-replay-step", () => {
    const el = mountLog();
    const log = createActivityLog({ clock: () => "t" });
    log.append("user_message_sent", { text: "a" });
    log.append("tool_call_started", { toolCallId: "1" });
    el.log = log;

    const steps = vi.fn();
    const complete = vi.fn();
    el.addEventListener("honua-studio-activity-replay-step", steps);
    el.addEventListener("honua-studio-activity-replay-complete", complete);

    el.startReplay();
    const first = el.replayNext();
    expect(first?.type).toBe("user_message_sent");
    expect(steps).toHaveBeenCalledTimes(1);
    expect((steps.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({ index: 0, total: 2 });
    expect(complete).not.toHaveBeenCalled();

    const second = el.replayNext();
    expect(second?.type).toBe("tool_call_started");
    expect(complete).toHaveBeenCalledTimes(1);
    expect((complete.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ total: 2 });

    expect(el.replayNext()).toBeUndefined();
  });

  it("replayNext() auto-starts a session over the current log if none is active", () => {
    const el = mountLog();
    const log = createActivityLog({ clock: () => "t" });
    log.append("user_message_sent", { text: "a" });
    el.log = log;
    const entry = el.replayNext();
    expect(entry?.type).toBe("user_message_sent");
  });

  it("resetReplay() rewinds an active session without discarding it", () => {
    const el = mountLog();
    const log = createActivityLog({ clock: () => "t" });
    log.append("user_message_sent", { text: "a" });
    el.log = log;
    el.startReplay();
    el.replayNext();
    el.resetReplay();
    const replayed = el.replayNext();
    expect(replayed?.type).toBe("user_message_sent");
  });

  it("exportJson()/importJson() round-trip the log's entries", () => {
    const source = mountLog();
    const log = createActivityLog({ clock: () => "t" });
    log.append("user_message_sent", { text: "hi" });
    log.append("annotation_added", { id: "a1" });
    source.log = log;

    const json = source.exportJson();

    const target = mountLog();
    target.importJson(json);
    expect(target.entries).toEqual(log.entries());
  });

  it("importJson() throws for malformed JSON and leaves the log untouched", () => {
    const el = mountLog();
    const log = createActivityLog({ clock: () => "t" });
    log.append("user_message_sent", { text: "hi" });
    el.log = log;
    expect(() => el.importJson('{"version":2,"entries":[]}')).toThrow();
    expect(el.entries).toEqual(log.entries());
  });
});
