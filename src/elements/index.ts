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
export { AUTH_STATUS_LABELS } from "./auth-status.js";
export { HonuaStudioElementBase } from "./base-element.js";
export { HonuaStudioAppElement } from "./studio-app-element.js";
export { HonuaStudioCanvasElement } from "./studio-canvas-element.js";
export { HonuaStudioChatElement } from "./studio-chat-element.js";
export { HonuaStudioActivityLogElement } from "./studio-activity-log-element.js";
export { resolveInjectedAuth } from "./session.js";
export type { HasOptionalAuth } from "./session.js";
export {
  HonuaStudioElementRegistryError,
  STUDIO_ELEMENT_TAGS,
  createStudioComponentRegistry,
  registerAllStudioElements,
  registerStudioElement,
} from "./registry.js";
export type {
  AuthSession,
  AuthState,
  AuthStatus,
  HonuaStudioActivityReplayCompleteDetail,
  HonuaStudioActivityReplayStepDetail,
  HonuaStudioAnnotateDetail,
  HonuaStudioCanvasResizeDetail,
  HonuaStudioChatAnnotationAddedDetail,
  HonuaStudioChatAnnotationRemovedDetail,
  HonuaStudioChatMessageDetail,
  HonuaStudioChatToolCallResultDetail,
  HonuaStudioChatToolCallStartDetail,
  HonuaStudioChatTurnCancelledDetail,
  HonuaStudioChatTurnCompleteDetail,
  HonuaStudioChatTurnErrorDetail,
  HonuaStudioComponentRegistry,
  HonuaStudioErrorDetail,
  HonuaStudioNavigateDetail,
  HonuaStudioReadyDetail,
  HonuaStudioRoutingMode,
  HonuaStudioSessionRequiredDetail,
  HonuaStudioThemeChangeDetail,
  HonuaStudioThemeSwitcherVisibility,
  SessionAdapter,
  ThemeMode,
  ThemeSet,
} from "./types.js";
// The full chat-console typed surface (honua-studio#6): AnnotationRef,
// ActivityLog(Entry), ChatTransport implementations, ChatState/ChatMessage,
// fixture-conversation types, etc. — one barrel, see src/chat/index.ts.
export * from "../chat/index.js";
