// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioCustomProcessesElement } from "../../src/elements/studio-custom-processes-element.js";
import type { LocalProcessWorkspace } from "../../src/gp/custom-process-workspace.js";
registerAllStudioElements();
afterEach(() => {
  document.body.innerHTML = "";
});
const identity = {
  projectId: "a".repeat(32),
  revision: 1,
  sourceDigest: "b".repeat(64),
  image: `sha256:${"c".repeat(64)}`,
  binding: { ownerActorId: "owner", tenantId: null, environmentId: "target", workspaceId: "workspace" },
};
const project = {
  ...identity,
  files: [{ path: "tool.py", content: "original source", sha256: "d".repeat(64) }],
  ideHandoff: { kind: "vscode", workspace: "/paired/project" },
};
function mount(save = vi.fn()) {
  const element = document.createElement("honua-studio-custom-processes") as HonuaStudioCustomProcessesElement;
  element.client = {
    bind: async () => identity,
    project: async () => project,
    identity: async () => identity,
    save,
  } as unknown as LocalProcessWorkspace;
  document.body.appendChild(element);
  return element;
}
function click(element: HonuaStudioCustomProcessesElement, action: string) {
  element.shadowRoot!.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.click();
}
it("projects only actual project references and preserves dirty source during task attachment", async () => {
  const element = mount();
  const tasks: unknown[] = [];
  element.addEventListener("honua-local-process-task-change", (event) => tasks.push((event as CustomEvent).detail));
  click(element, "load");
  await vi.waitFor(() => expect(element.shadowRoot!.querySelector("textarea")!.value).toBe("original source"));
  expect(await element.prepareWorkspaceTask()).toEqual({
    projectId: identity.projectId,
    revision: 1,
    sourceDigest: identity.sourceDigest,
  });
  expect(JSON.stringify(tasks)).not.toContain("original source");
  const editor = element.shadowRoot!.querySelector("textarea")!;
  editor.value = "unsaved edit";
  editor.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  expect(tasks.at(-1)).toBeNull();
  await expect(element.prepareWorkspaceTask()).rejects.toThrow("save source");
  expect(await element.attachWorkspaceTask(identity)).toBe(false);
  expect(editor.value).toBe("unsaved edit");
});
it("does not acknowledge newer typing as the source accepted by an in-flight save", async () => {
  let release!: (value: unknown) => void;
  const save = vi.fn(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const element = mount(save);
  click(element, "load");
  await vi.waitFor(() => expect(element.shadowRoot!.querySelector("textarea")!.value).toBe("original source"));
  const editor = element.shadowRoot!.querySelector("textarea")!;
  editor.value = "first edit";
  editor.dispatchEvent(new Event("input", { composed: true }));
  click(element, "save");
  await vi.waitFor(() => expect(save).toHaveBeenCalled());
  editor.value = "second edit";
  editor.dispatchEvent(new Event("input", { composed: true }));
  release({
    path: "tool.py",
    sha256: "e".repeat(64),
    projectId: identity.projectId,
    revision: 2,
    sourceDigest: "f".repeat(64),
  });
  await vi.waitFor(() => expect(element.shadowRoot!.querySelector("pre")!.textContent).toContain("Source saved"));
  expect(element.shadowRoot!.querySelector("textarea")!.value).toBe("second edit");
  await expect(element.prepareWorkspaceTask()).rejects.toThrow("save source");
});

it("refreshes accepted agent source changes only when clean and exposes conflicts without replacing dirty text", async () => {
  const element = mount();
  click(element, "load");
  await vi.waitFor(() => expect(element.shadowRoot!.querySelector("textarea")!.value).toBe("original source"));
  const changed = {
    ...project,
    revision: 2,
    sourceDigest: "e".repeat(64),
    files: [{ path: "tool.py", content: "agent correction", sha256: "f".repeat(64) }],
  };
  element.client!.identity = async () => changed;
  element.client!.project = async () => changed;
  expect(await element.refreshWorkspaceTask()).toBe(true);
  expect(element.shadowRoot!.querySelector("textarea")!.value).toBe("agent correction");
  const editor = element.shadowRoot!.querySelector("textarea")!;
  editor.value = "human unsaved correction";
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  element.client!.identity = async () => ({ ...changed, revision: 3, sourceDigest: "1".repeat(64) });
  expect(await element.refreshWorkspaceTask()).toBe(false);
  expect(element.shadowRoot!.querySelector("textarea")!.value).toBe("human unsaved correction");
  expect(element.shadowRoot!.querySelector("pre")!.textContent).toContain("changed outside this editor");
});
