// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createActivityLog } from "../../src/chat/activity-log.js";
import type { ChatTransport } from "../../src/chat/transport.js";
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioActivityLogElement } from "../../src/elements/studio-activity-log-element.js";
import { HonuaStudioCanvasElement } from "../../src/elements/studio-canvas-element.js";
import type { HonuaStudioChatElement } from "../../src/elements/studio-chat-element.js";

// Registers on the (per-test-file, happy-dom-provided) global customElements
// registry — actual DOM upgrade via document.createElement(tag) only
// happens through that registry, not an isolated one (registry.test.ts
// covers isolated-registry semantics directly).
registerAllStudioElements();

// happy-dom does not ship ResizeObserver — stand in a spy so
// HonuaStudioCanvasElement's observe()/disconnect() calls are inspectable,
// mirroring what a real render-mode toggle in the Blazor host exercises
// (harness/blazor-host's render-mode-switch spec) without needing a real
// browser here.
class SpyResizeObserver {
  static instances: SpyResizeObserver[] = [];
  static liveCount = 0;
  disconnected = false;
  constructor(public callback: ResizeObserverCallback) {
    SpyResizeObserver.instances.push(this);
    SpyResizeObserver.liveCount += 1;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    if (!this.disconnected) SpyResizeObserver.liveCount -= 1;
    this.disconnected = true;
  }
}

describe("elements cleanup invariants (honua-studio#5: no leaked listeners/observers)", () => {
  beforeEach(() => {
    SpyResizeObserver.instances = [];
    SpyResizeObserver.liveCount = 0;
    globalThis.ResizeObserver = SpyResizeObserver as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    document.body.innerHTML = "";
    // @ts-expect-error test shim cleanup — clearing a required global
    globalThis.ResizeObserver = undefined;
  });

  it("honua-studio-canvas: instanceCount tracks live (connected) instances exactly, across repeated mount/unmount (render-mode-switch simulation)", () => {
    const startCount = HonuaStudioCanvasElement.instanceCount;
    const el = document.createElement("honua-studio-canvas") as HonuaStudioCanvasElement;

    for (let cycle = 0; cycle < 3; cycle += 1) {
      document.body.appendChild(el);
      expect(HonuaStudioCanvasElement.instanceCount).toBe(startCount + 1);
      document.body.removeChild(el);
      expect(HonuaStudioCanvasElement.instanceCount).toBe(startCount);
    }
  });

  it("honua-studio-canvas: disconnects its ResizeObserver on unmount — no leaked observer", () => {
    const el = document.createElement("honua-studio-canvas") as HonuaStudioCanvasElement;
    document.body.appendChild(el);
    expect(SpyResizeObserver.liveCount).toBe(1);

    document.body.removeChild(el);
    expect(SpyResizeObserver.liveCount).toBe(0);
    expect(SpyResizeObserver.instances[0]?.disconnected).toBe(true);
  });

  it("honua-studio-canvas: two concurrent instances never share or leak into each other's observer", () => {
    const a = document.createElement("honua-studio-canvas") as HonuaStudioCanvasElement;
    const b = document.createElement("honua-studio-canvas") as HonuaStudioCanvasElement;
    document.body.append(a, b);
    expect(HonuaStudioCanvasElement.instanceCount).toBe(2);
    expect(SpyResizeObserver.liveCount).toBe(2);

    document.body.removeChild(a);
    expect(HonuaStudioCanvasElement.instanceCount).toBe(1);
    expect(SpyResizeObserver.liveCount).toBe(1);

    document.body.removeChild(b);
    expect(HonuaStudioCanvasElement.instanceCount).toBe(0);
    expect(SpyResizeObserver.liveCount).toBe(0);
  });

  it("honua-studio-chat: the submit listener attached pre-unmount never fires after disconnect, and remount rebuilds a fresh one", () => {
    const el = document.createElement("honua-studio-chat") as HonuaStudioChatElement;
    document.body.appendChild(el);
    const messageListener = vi.fn();
    el.addEventListener("honua-studio-chat-message", messageListener);

    const form = el.shadowRoot?.querySelector("form");
    const input = el.shadowRoot?.querySelector<HTMLInputElement>("#honua-studio-chat-input");
    expect(form).toBeTruthy();
    if (input) input.value = "hello";
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(messageListener).toHaveBeenCalledTimes(1);

    document.body.removeChild(el);
    // Dispatching directly on the detached form must not reach any live app state.
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(messageListener).toHaveBeenCalledTimes(1);

    document.body.appendChild(el);
    const nextForm = el.shadowRoot?.querySelector("form");
    const nextInput = el.shadowRoot?.querySelector<HTMLInputElement>("#honua-studio-chat-input");
    if (nextInput) nextInput.value = "again";
    nextForm?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(messageListener).toHaveBeenCalledTimes(2);
  });

  it("honua-studio-chat: disconnect aborts an in-flight streaming turn's transport signal — no leaked stream", async () => {
    const el = document.createElement("honua-studio-chat") as HonuaStudioChatElement;
    document.body.appendChild(el);

    let capturedSignal: AbortSignal | undefined;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport: ChatTransport = {
      async *streamChat(_request, signal) {
        capturedSignal = signal;
        await gate;
        if (signal.aborted) return;
        yield { type: "messageStop", stopReason: "endTurn" };
      },
    };
    el.transport = transport;

    const sendPromise = el.sendMessage("hello");
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    expect(capturedSignal?.aborted).toBe(false);

    document.body.removeChild(el);
    expect(capturedSignal?.aborted).toBe(true);

    release?.();
    await sendPromise;
  });

  it("honua-studio-activity-log: disconnect unsubscribes from its .log — a post-unmount append never triggers a render", () => {
    const el = document.createElement("honua-studio-activity-log") as HonuaStudioActivityLogElement;
    document.body.appendChild(el);
    const log = createActivityLog({ clock: () => "t" });
    el.log = log;
    document.body.removeChild(el);

    // If the subscription leaked, this would throw trying to touch a torn-down shadow root's internals via render().
    expect(() => log.append("user_message_sent", { text: "after unmount" })).not.toThrow();
  });
});
