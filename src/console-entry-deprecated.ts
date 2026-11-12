import { LocalProcessEditor } from "./gp/custom-process-workspace.js";
import { ServerProcessEditor } from "./gp/process-workspace.js";
import { type ContentLifecycleReader, createContentLifecycleReader } from "./lifecycle/workspace-reader.js";
import {
  type ReadOnlyAppDocument,
  type ReadOnlyAppView,
  type ReadOnlyAppViewOptions,
  createReadOnlyAppView,
} from "./map/read-only-composition-view.js";
import { createEditorAgentSession, editorAgentFeatures } from "./workspace-agent.js";

/** @deprecated Use createEditorAgentSession. Removed in the next minor. */
export const createWorkspaceAgentSession = createEditorAgentSession;
/** @deprecated Use editorAgentFeatures. Removed in the next minor. */
export const workspaceAgentFeatures = editorAgentFeatures;
/** @deprecated Use ServerProcessEditor. Removed in the next minor. */
export const ServerProcessWorkspace = ServerProcessEditor;
/** @deprecated Use ServerProcessEditor. Removed in the next minor. */
export type ServerProcessWorkspace = ServerProcessEditor;
/** @deprecated Use LocalProcessEditor. Removed in the next minor. */
export const LocalProcessWorkspace = LocalProcessEditor;
/** @deprecated Use LocalProcessEditor. Removed in the next minor. */
export type LocalProcessWorkspace = LocalProcessEditor;
/** @deprecated Use createContentLifecycleReader. Removed in the next minor. */
export const createWorkspaceLifecycleReader = createContentLifecycleReader;
/** @deprecated Use ContentLifecycleReader. Removed in the next minor. */
export type WorkspaceLifecycleReader = ContentLifecycleReader;
/** @deprecated Use createReadOnlyAppView. Removed in the next minor. */
export const createReadOnlyCompositionView = createReadOnlyAppView;
/** @deprecated Use ReadOnlyAppView. Removed in the next minor. */
export type ReadOnlyCompositionView = ReadOnlyAppView;
/** @deprecated Use ReadOnlyAppViewOptions. Removed in the next minor. */
export type ReadOnlyCompositionViewOptions = ReadOnlyAppViewOptions;
/** @deprecated Use ReadOnlyAppDocument. Removed in the next minor. */
export type ReadOnlyCompositionDocument = ReadOnlyAppDocument;
