import type { HonuaStudioCanvasElement } from "../elements/studio-canvas-element.js";
import type { HonuaStudioChatElement } from "../elements/studio-chat-element.js";

/** The light-DOM chat and canvas children of `<honua-studio-app>`, looked up live. */
export class StudioAppChildren {
  constructor(private readonly host: ParentNode) {}

  chat(): HonuaStudioChatElement | undefined {
    return this.host.querySelector<HonuaStudioChatElement>("honua-studio-chat") ?? undefined;
  }

  canvas(): HonuaStudioCanvasElement | undefined {
    return this.host.querySelector<HonuaStudioCanvasElement>("honua-studio-canvas") ?? undefined;
  }

  canvases(): readonly HonuaStudioCanvasElement[] {
    return [...this.host.querySelectorAll<HonuaStudioCanvasElement>("honua-studio-canvas")];
  }
}
