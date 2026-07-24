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
export { HonuaStudioContentBrowserElement } from "./studio-content-browser-element.js";
export { HonuaStudioLifecyclePanelElement } from "./studio-lifecycle-panel-element.js";
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
  HonuaStudioLifecycleActivityDetail,
  HonuaStudioNavigateDetail,
  HonuaStudioOpenItemDetail,
  HonuaStudioReadyDetail,
  HonuaStudioRoutingMode,
  HonuaStudioSelectionChangeDetail,
  HonuaStudioSessionRequiredDetail,
  HonuaStudioThemeChangeDetail,
  HonuaStudioThemeSwitcherVisibility,
  SessionAdapter,
  ThemeMode,
  ThemeSet,
} from "./types.js";
// The Studio package lifecycle client (honua-studio#9) — REST client,
// errors, and wire types over honua-server's Studio package lifecycle API.
// `TokenSource` is deliberately NOT re-exported here — `../chat/index.js`
// (re-exported above) already establishes that name in this barrel
// (`sse-transport.ts`'s `TokenSource`); both shapes are structurally
// identical (`getAccessToken(options?): Promise<string | undefined>`), so
// import `TokenSource` from `../lifecycle/lifecycle-client.js` directly if
// you specifically need the lifecycle client's copy of the type.
export {
  StudioLifecycleClient,
  StudioLifecycleConflictError,
  StudioLifecycleError,
  StudioLifecycleSessionExpiredError,
  StudioLifecycleTransportError,
  isStudioLifecycleGenerationConflict,
  isStudioLifecycleNotFound,
} from "../lifecycle/index.js";
export type { StudioLifecycleClientOptions, StudioLifecycleErrorCode } from "../lifecycle/index.js";
export type {
  StudioContentItemListResponse,
  StudioContentItemPublicationBadge,
  StudioContentItemQuery,
  StudioContentItemState,
  StudioContentItemSummary,
  StudioContentVersion,
  StudioContentVersionListResponse,
  StudioPackageDraft,
  StudioPackageDraftCreateRequest,
  StudioPackageDraftListResponse,
  StudioPackageDraftQuery,
  StudioPackageDraftReplaceRequest,
  StudioPackageEnvelope,
  StudioPackageFamily,
  StudioPackageFamilyCapabilities,
  StudioPreviewPlan,
  StudioPublicationIntent,
  StudioPublicationRequest,
  StudioPublishRequestInput,
  StudioRollbackPointer,
  StudioRollbackRequest,
  StudioRollbackRequestInput,
  StudioValidationSummary,
  StudioVersionComparison,
  StudioVersionComparisonRequest,
} from "../lifecycle/lifecycle-types.js";
// The full chat-console typed surface (honua-studio#6): AnnotationRef,
// ActivityLog(Entry), ChatTransport implementations, ChatState/ChatMessage,
// fixture-conversation types, etc. — one barrel, see src/chat/index.ts.
export * from "../chat/index.js";
