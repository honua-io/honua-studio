/** Public barrel for the MCP tool plane (honua-studio#7). Side effect free on import, like `../composition/index.ts`. */
export { MCP_PROTOCOL_VERSION } from "./protocol.js";
export type {
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  McpClientInfo,
  McpContentBlock,
  McpInitializeParams,
  McpInitializeResult,
  McpStructuredError,
  McpToolAnnotations,
  McpToolDescriptor,
  McpToolErrorCode,
  McpToolsCallParams,
  McpToolsCallResult,
  McpToolsListParams,
  McpToolsListResult,
} from "./protocol.js";

export {
  McpProtocolError,
  McpToolError,
  McpTransportError,
  isMcpGenerationConflict,
  isMcpNotFound,
  isMcpToolError,
} from "./errors.js";

export { McpClient } from "./client.js";
export type { McpClientOptions, TokenSource as McpTokenSource } from "./client.js";

export {
  STUDIO_MCP_TOOL_NAMES,
  StudioMcpToolClient,
  parseStudioDraftResult,
} from "./studio-tools.js";
export type {
  AddStudioLayerInput,
  AddStudioWidgetInput,
  CreateStudioDraftInput,
  ProposeStudioPublicationInput,
  ProposeStudioPublicationOutput,
  RemoveStudioLayerInput,
  RemoveStudioWidgetInput,
  SetStudioLayerStyleInput,
  SetStudioViewInput,
  StudioCompositionBodyWire,
  StudioMcpDraft,
  StudioMcpLayerInput,
  StudioMcpPreviewPlan,
  StudioMcpToolName,
  StudioMcpValidationSummary,
  StudioMcpViewInput,
  StudioMcpWidgetInput,
  StudioPackageFamilyWire,
  UpdateStudioDraftInput,
} from "./studio-tools.js";

export {
  bridgedToolNames,
  buildServerToolInvocation,
  applyStudioDraft,
  applyStudioDraftBody,
  resolveToolCall,
  toStudioCompositionBody,
} from "./tool-bridge.js";
export type {
  ServerToolInvocation,
  ToolBridgeErrorCode,
  ToolBridgeFailure,
  ToolBridgeResolution,
  ToolBridgeSuccess,
  ToolBridgeVocabulary,
} from "./tool-bridge.js";

export { ToolCallOrchestrator } from "./orchestrator.js";
export type {
  ToolCallOrchestrationErrorCode,
  ToolCallOrchestrationFailure,
  ToolCallOrchestrationMode,
  ToolCallOrchestrationResult,
  ToolCallOrchestrationSuccess,
  ToolCallOrchestratorLiveOptions,
  ToolCallOrchestratorOptions,
} from "./orchestrator.js";
