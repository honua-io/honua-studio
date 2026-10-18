// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioProcessesElement } from "../../src/elements/studio-processes-element.js";
import type { ServerProcessWorkspace } from "../../src/gp/process-workspace.js";
registerAllStudioElements();
afterEach(() => {
  document.body.innerHTML = "";
});
it("preserves dirty graph text across registry/status rerenders and refuses stale task projection", async () => {
  const element = document.createElement("honua-studio-processes") as HonuaStudioProcessesElement;
  const readVersion = vi.fn();
  element.client = {
    registry: async () => ({ registryVersion: "real", nodes: [] }),
    readVersion,
  } as unknown as ServerProcessWorkspace;
  document.body.appendChild(element);
  const editor = element.shadowRoot!.querySelector("textarea")!;
  editor.value = "{ still editing invalid JSON";
  editor.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  element.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="registry"]')!.click();
  await vi.waitFor(() => expect(element.shadowRoot!.querySelector("pre")!.textContent).toContain("real"));
  expect(element.shadowRoot!.querySelector("textarea")!.value).toBe("{ still editing invalid JSON");
  await expect(element.prepareWorkspaceTask()).rejects.toThrow("Save and validate");
  expect(await element.attachWorkspaceTask({ packageId: "pkg", version: 1, contentHash: "a".repeat(64) })).toBe(false);
  expect(readVersion).not.toHaveBeenCalled();
});
