/**
 * Public entry point for the `honua-studio-*` embeddable element kit
 * (honua-studio#5). Side-effect-free on import — see registry.ts's doc for
 * why. A host registers what it needs explicitly:
 *
 * ```ts
 * import { registerAllStudioElements } from "@honua/studio/elements";
 * registerAllStudioElements();
 * document.body.append(document.createElement("honua-studio-app"));
 * ```
 */
export { HonuaStudioElementBase } from "./base-element.js";
export { HonuaStudioAppElement } from "./studio-app-element.js";
export { HonuaStudioCanvasElement } from "./studio-canvas-element.js";
export { HonuaStudioChatElement } from "./studio-chat-element.js";
export { resolveInjectedSession } from "./session.js";
export type { HasOptionalSession } from "./session.js";
export {
  HonuaStudioElementRegistryError,
  STUDIO_ELEMENT_TAGS,
  createStudioComponentRegistry,
  registerAllStudioElements,
  registerStudioElement,
} from "./registry.js";
export type {
  HonuaStudioCanvasResizeDetail,
  HonuaStudioChatMessageDetail,
  HonuaStudioComponentRegistry,
  HonuaStudioErrorDetail,
  HonuaStudioNavigateDetail,
  HonuaStudioReadyDetail,
  HonuaStudioRoutingMode,
  HonuaStudioSessionAdapter,
  HonuaStudioSessionRequiredDetail,
  HonuaStudioSessionSnapshot,
  HonuaStudioThemeChangeDetail,
  HonuaStudioThemeSwitcherVisibility,
  ThemeMode,
  ThemeSet,
} from "./types.js";
