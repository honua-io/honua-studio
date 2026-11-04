import type { HonuaStudioCanvasElement } from "../elements/studio-canvas-element.js";
import type { HonuaStudioChatElement } from "../elements/studio-chat-element.js";

/** The light-DOM chat and canvas children of `<honua-studio-app>`, looked up live. */
export class StudioAppChildren {
  constructor(private readonly host: HTMLElement) {}

  /** Composes a default chat and canvas unless the host already supplied its own. */
  ensureDefaults(): void {
    if (!this.chat()) this.#append("honua-studio-chat", "chat", "Chat");
    if (!this.canvas()) this.#append("honua-studio-canvas", "canvas", "Canvas");
  }

  chat(): HonuaStudioChatElement | undefined {
    return this.host.querySelector<HonuaStudioChatElement>("honua-studio-chat") ?? undefined;
  }

  canvas(): HonuaStudioCanvasElement | undefined {
    return this.host.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas") ?? undefined;
  }

  canvases(): readonly HonuaStudioCanvasElement[] {
    return [...this.host.querySelectorAll<HonuaStudioCanvasElement>("honua-studio-canvas")];
  }

  #append(tagName: string, slot: string, label: string): void {
    const child = document.createElement(tagName);
    child.slot = slot;
    child.setAttribute("label", label);
    this.host.appendChild(child);
  }
}
