// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioAppElement } from "../../src/elements/studio-app-element.js";
import type { HonuaStudioCanvasElement } from "../../src/elements/studio-canvas-element.js";
import type { HonuaStudioChatElement } from "../../src/elements/studio-chat-element.js";
import type { HonuaStudioChatToolCallResultDetail, SessionAdapter } from "../../src/elements/types.js";

registerAllStudioElements();

function fixtureSession(): SessionAdapter {
  return { getToken: async () => "fixture-token", onExpired: () => () => {} };
}

function mount(): HonuaStudioAppElement {
  const app = document.createElement("honua-studio-app") as HonuaStudioAppElement;
  app.session = fixtureSession();
  document.body.appendChild(app);
  return app;
}

function dispatchToolCallResult(chat: HonuaStudioChatElement, detail: HonuaStudioChatToolCallResultDetail): void {
  chat.dispatchEvent(new CustomEvent("honua-studio-chat-tool-call-result", { bubbles: true, composed: true, detail }));
}

describe("elements/studio-app-element MCP tool-call orchestration wiring (honua-studio#7)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network disabled in unit tests"))),
    );
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("wires the auto-composed canvas to .composition", () => {
    const app = mount();
    const canvas = app.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas");
    expect(canvas?.composition).toBe(app.composition);
  });

  it("wires the canvas's commandDispatch to the one orchestrator, so a widget toggle takes the tool-bridge route", async () => {
    const app = mount();
    const canvas = app.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas");
    expect(canvas?.commandDispatch).toBeTypeOf("function");

    app.composition.apply({ name: "addLayer", layer: { id: "parcels", sourceId: "hi-parcels" } });
    const outcome = await canvas!.commandDispatch!([
      { name: "setVisibility", target: { kind: "layer", id: "parcels" }, visible: false },
    ]);

    // No live session here, so the orchestrator applies through the reducer —
    // the same decision it makes per command from the bridge's serverToolName.
    expect(outcome).toEqual({ ok: true });
    expect(app.composition.state.layers[0]?.visible).toBe(false);
  });

  it("reports a refused command back to the widget rather than throwing into its event handler", async () => {
    const app = mount();
    const canvas = app.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas");
    app.composition.apply({ name: "addLayer", layer: { id: "parcels", sourceId: "hi-parcels" } });
    app.composition.apply({ name: "pin", target: { kind: "layer", id: "parcels" } });

    const outcome = await canvas!.commandDispatch!([
      { name: "setVisibility", target: { kind: "layer", id: "parcels" }, visible: false },
    ]);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toContain("pinned");
    expect(app.composition.state.layers[0]?.visible).toBe(true);
  });

  it("a batch stops at the first refusal — half a compare switch is worse than none of it", async () => {
    const app = mount();
    const canvas = app.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas");
    app.composition.apply({ name: "addLayer", layer: { id: "left", sourceId: "s-left" } });
    app.composition.apply({ name: "addLayer", layer: { id: "right", sourceId: "s-right" } });
    app.composition.apply({ name: "pin", target: { kind: "layer", id: "left" } });

    const outcome = await canvas!.commandDispatch!([
      { name: "setVisibility", target: { kind: "layer", id: "left" }, visible: false },
      { name: "setVisibility", target: { kind: "layer", id: "right" }, visible: true },
    ]);

    expect(outcome.ok).toBe(false);
    expect(app.composition.state.layers.map((layer) => layer.visible)).toEqual([true, true]);
  });

  it("a chat-fixture-vocabulary tool-call-result event mutates composition state and re-renders the canvas", async () => {
    const app = mount();
    const chat = app.querySelector<HonuaStudioChatElement>("honua-studio-chat")!;

    dispatchToolCallResult(chat, {
      messageId: "m1",
      toolCallId: "call-1",
      toolName: "add_layer",
      arguments: { datasetId: "hi-parcels", styleBy: "district" },
    });
    // The orchestrator's handleToolCall is async (returns a Promise the
    // event listener fires-and-forgets) — flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(app.composition.state.layers.map((l) => l.id)).toEqual(["hi-parcels"]);
    const canvas = app.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas")!;
    expect(canvas.shadowRoot?.querySelector('[data-testid="studio-canvas-layers"]')?.textContent).toContain(
      "hi-parcels",
    );
  });

  it("an unresolved tool call (no toolName) is a silent no-op — nothing to resolve", async () => {
    const app = mount();
    const chat = app.querySelector<HonuaStudioChatElement>("honua-studio-chat")!;

    dispatchToolCallResult(chat, { messageId: "m1", toolCallId: "call-1", arguments: {} });
    await Promise.resolve();

    expect(app.composition.state.layers).toHaveLength(0);
  });

  it("an unsupported/unknown tool call is recorded on the shared activity log, not silently dropped", async () => {
    const app = mount();
    const chat = app.querySelector<HonuaStudioChatElement>("honua-studio-chat")!;

    dispatchToolCallResult(chat, {
      messageId: "m1",
      toolCallId: "call-1",
      toolName: "filter_layer",
      arguments: { layerId: "hi-parcels", filter: { zoning: "AG" } },
    });
    await Promise.resolve();
    await Promise.resolve();

    const entries = chat.activityLog.entries();
    const rejected = entries.find((entry) => entry.type === "composition_command_rejected");
    expect(rejected?.detail).toMatchObject({ toolName: "filter_layer", code: "unsupported" });
  });

  it(".toolCallOrchestrator shares the auto-composed chat's ActivityLog", async () => {
    const app = mount();
    const chat = app.querySelector<HonuaStudioChatElement>("honua-studio-chat")!;

    dispatchToolCallResult(chat, {
      messageId: "m1",
      toolCallId: "call-1",
      toolName: "addLayer",
      arguments: { layer: { id: "roads", sourceId: "s" } },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(chat.activityLog.entries().some((entry) => entry.type === "composition_command_applied")).toBe(true);
  });
});
