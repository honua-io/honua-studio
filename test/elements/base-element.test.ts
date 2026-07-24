// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { HonuaStudioElementBase } from "../../src/elements/base-element.js";

class ProbeElement extends HonuaStudioElementBase {
  connectCalls = 0;
  disconnectCalls = 0;
  renderCalls = 0;
  externalTarget: EventTarget | undefined;
  externalListener = vi.fn();

  protected onConnect(signal: AbortSignal): void {
    this.connectCalls += 1;
    if (this.externalTarget) this.listen(this.externalTarget, "probe-event", this.externalListener);
    void signal;
  }

  protected onDisconnect(): void {
    this.disconnectCalls += 1;
  }

  protected render(): void {
    this.renderCalls += 1;
    this.setShadowHtml(`<input id="probe-input" data-testid="probe-input" value="hello" />`);
  }
}

if (!customElements.get("probe-element")) customElements.define("probe-element", ProbeElement);

describe("elements/base-element HonuaStudioElementBase", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("attaches an open shadow root and renders on connect", () => {
    const element = document.createElement("probe-element") as ProbeElement;
    document.body.appendChild(element);
    expect(element.shadowRoot).not.toBeNull();
    expect(element.shadowRoot?.mode).toBe("open");
    expect(element.connectCalls).toBe(1);
    expect(element.renderCalls).toBeGreaterThanOrEqual(1);
  });

  it("dispatches honua-studio-ready exactly once, after the first render", () => {
    const element = document.createElement("probe-element") as ProbeElement;
    const readyListener = vi.fn();
    element.addEventListener("honua-studio-ready", readyListener);
    document.body.appendChild(element);
    expect(readyListener).toHaveBeenCalledTimes(1);
    const event = readyListener.mock.calls[0]?.[0] as CustomEvent;
    expect(event.detail).toEqual({ tagName: "probe-element" });
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);

    // Reconnecting (remove + re-append) fires connectedCallback again but
    // must not double-fire "ready" as if this were a first mount forever —
    // it only guards the very first connection this instance ever makes.
    document.body.removeChild(element);
    document.body.appendChild(element);
    expect(readyListener).toHaveBeenCalledTimes(1);
  });

  it("removes listeners registered through listen() on disconnect — no leaked listeners", () => {
    const external = new EventTarget();
    const element = document.createElement("probe-element") as ProbeElement;
    element.externalTarget = external;
    document.body.appendChild(element);

    external.dispatchEvent(new Event("probe-event"));
    expect(element.externalListener).toHaveBeenCalledTimes(1);

    document.body.removeChild(element);
    expect(element.disconnectCalls).toBe(1);

    external.dispatchEvent(new Event("probe-event"));
    // Still only 1 — the listener registered pre-disconnect never fires again.
    expect(element.externalListener).toHaveBeenCalledTimes(1);
  });

  it("preserves focus and text selection across a setShadowHtml re-render", () => {
    const element = document.createElement("probe-element") as ProbeElement;
    document.body.appendChild(element);
    const input = element.shadowRoot?.querySelector<HTMLInputElement>("#probe-input");
    expect(input).not.toBeNull();
    input?.focus();
    input?.setSelectionRange(1, 3);
    expect(element.shadowRoot?.activeElement).toBe(input);

    // Force a re-render (replaces the DOM node entirely).
    (element as unknown as { render(): void }).render();

    const nextInput = element.shadowRoot?.querySelector<HTMLInputElement>("#probe-input");
    expect(nextInput).not.toBe(input); // proves this is a real replace, not a no-op
    expect(element.shadowRoot?.activeElement).toBe(nextInput);
    expect(nextInput?.selectionStart).toBe(1);
    expect(nextInput?.selectionEnd).toBe(3);
  });
});
