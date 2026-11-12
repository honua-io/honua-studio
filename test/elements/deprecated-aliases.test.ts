// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import * as consoleEntryAliases from "../../src/console-entry-deprecated.js";
import {
  DEPRECATED_APP_ELEMENT_ALIASES,
  DEPRECATED_CHAT_ELEMENT_ALIASES,
  DEPRECATED_CUSTOM_PROCESSES_ELEMENT_ALIASES,
  DEPRECATED_PROCESSES_ELEMENT_ALIASES,
  dispatchWithDeprecatedAlias,
} from "../../src/elements/deprecated-aliases.js";
import { HonuaStudioAppElement } from "../../src/elements/studio-app-element.js";
import { HonuaStudioChatElement } from "../../src/elements/studio-chat-element.js";
import { HonuaStudioCustomProcessesElement } from "../../src/elements/studio-custom-processes-element.js";
import { HonuaStudioProcessesElement } from "../../src/elements/studio-processes-element.js";
import { LocalProcessEditor } from "../../src/gp/custom-process-workspace.js";
import { ServerProcessEditor } from "../../src/gp/process-workspace.js";
import { createContentLifecycleReader } from "../../src/lifecycle/workspace-reader.js";
import { createReadOnlyAppView } from "../../src/map/read-only-composition-view.js";
import { createEditorAgentSession, editorAgentFeatures } from "../../src/workspace-agent.js";

const elements = [
  [HonuaStudioAppElement, DEPRECATED_APP_ELEMENT_ALIASES],
  [HonuaStudioChatElement, DEPRECATED_CHAT_ELEMENT_ALIASES],
  [HonuaStudioProcessesElement, DEPRECATED_PROCESSES_ELEMENT_ALIASES],
  [HonuaStudioCustomProcessesElement, DEPRECATED_CUSTOM_PROCESSES_ELEMENT_ALIASES],
] as const;

it.each(elements)(
  "%o keeps each deprecated method as a delegate with the same arguments and result",
  (element, aliases) => {
    for (const [deprecated, current] of Object.entries(aliases)) {
      expect(typeof (element.prototype as unknown as Record<string, unknown>)[current]).toBe("function");
      const receiver = { [current]: vi.fn(() => "result") };
      const alias = (element.prototype as unknown as Record<string, (...args: unknown[]) => unknown>)[deprecated];
      expect(alias.call(receiver, "a", 2)).toBe("result");
      expect(receiver[current]).toHaveBeenCalledWith("a", 2);
    }
  },
);

it("dispatches the deprecated event name after the current one with the same detail", () => {
  const target = new EventTarget();
  const seen: string[] = [];
  for (const type of ["honua-studio-draft-change", "honua-workspace-draft-change"])
    target.addEventListener(type, (event) => seen.push(`${type}:${(event as CustomEvent).detail.draftId}`));
  dispatchWithDeprecatedAlias(target, new CustomEvent("honua-studio-draft-change", { detail: { draftId: "d1" } }));
  expect(seen).toEqual(["honua-studio-draft-change:d1", "honua-workspace-draft-change:d1"]);
});

it("keeps nested announcements in the same order for listeners of the current and deprecated names", () => {
  const target = new EventTarget();
  const current: string[] = [];
  const deprecated: string[] = [];
  const announce = (mode: string) =>
    dispatchWithDeprecatedAlias(target, new CustomEvent("honua-studio-editing-mode-change", { detail: { mode } }));
  target.addEventListener("honua-studio-editing-mode-change", (event) => {
    const { mode } = (event as CustomEvent<{ mode: string }>).detail;
    current.push(mode);
    if (mode === "live") announce("fixture");
  });
  target.addEventListener("honua-studio-composition-mode-change", (event) =>
    deprecated.push((event as CustomEvent<{ mode: string }>).detail.mode),
  );
  announce("live");
  expect(current).toEqual(["live", "fixture"]);
  expect(deprecated).toEqual(["live", "fixture"]);
});

it("keeps the deprecated Console exports bound to the current implementations", () => {
  expect({ ...consoleEntryAliases }).toEqual({
    createWorkspaceAgentSession: createEditorAgentSession,
    workspaceAgentFeatures: editorAgentFeatures,
    ServerProcessWorkspace: ServerProcessEditor,
    LocalProcessWorkspace: LocalProcessEditor,
    createWorkspaceLifecycleReader: createContentLifecycleReader,
    createReadOnlyCompositionView: createReadOnlyAppView,
  });
});
