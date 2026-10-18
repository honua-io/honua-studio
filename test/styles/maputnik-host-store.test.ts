// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";

it("does not accept an invalid field when another field commits a valid change", async () => {
  // Load the exact adapter copied into upstream Maputnik; its type-only
  // definitions resolve inside that pinned checkout, not this application.
  const moduleUrl = new URL("../../scripts/maputnik/host-store.ts", import.meta.url).href;
  const { createStyleStore } = await import(/* @vite-ignore */ moduleUrl);
  const channel = "a".repeat(64);
  window.location.hash = new URLSearchParams({ channel, parentOrigin: location.origin }).toString();
  const messages: Record<string, unknown>[] = [];
  const post = vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => { messages.push(message as Record<string, unknown>); });
  const style = { version: 8, sources: {}, layers: [] };
  const send = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent("message", { source: window.parent, origin: location.origin, data: { ...data, channel } }));
  try {
    const pending = createStyleStore(() => {});
    send({ type: "honua:style-load", style });
    const store = await pending;
    const app = document.createElement("div"); app.id = "app";
    const panel = document.createElement("div"); panel.className = "maputnik-layer-editor";
    const invalid = document.createElement("textarea");
    const valid = document.createElement("input");
    panel.append(invalid, valid); app.append(panel); document.body.append(app);
    invalid.value = "{ invalid JSON"; invalid.dispatchEvent(new Event("input", { bubbles: true }));
    valid.value = "Accepted"; valid.dispatchEvent(new Event("input", { bubbles: true }));
    store.save({ ...style, id: "honua-host-draft", name: "Accepted" });
    send({ type: "honua:style-flush", requestId: "first" });
    await vi.waitFor(() => expect(messages.find((message) => message.requestId === "first")?.settled).toBe(false));
    invalid.value = "{}"; invalid.dispatchEvent(new Event("input", { bubbles: true }));
    store.save({ ...style, id: "honua-host-draft", name: "Corrected" });
    send({ type: "honua:style-flush", requestId: "corrected" });
    await vi.waitFor(() => expect(messages.find((message) => message.requestId === "corrected")?.settled).toBe(true));
    const code = document.createElement("div"); code.className = "cm-editor";
    const content = document.createElement("div"); code.append(content); panel.append(code);
    window.dispatchEvent(new CustomEvent("honua:style-raw-input", { detail: { element: content } }));
    valid.dispatchEvent(new Event("input", { bubbles: true }));
    store.save({ ...style, id: "honua-host-draft", name: "Other valid edit" });
    send({ type: "honua:style-flush", requestId: "raw-json" });
    await vi.waitFor(() => expect(messages.find((message) => message.requestId === "raw-json")?.settled).toBe(false));
  } finally { post.mockRestore(); window.location.hash = ""; document.body.innerHTML = ""; }
});
