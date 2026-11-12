import "./theme/tokens.css";
import "./theme/theme-console.css";
export { registerAllStudioElements } from "./elements/registry.js";
export { EXPLORE_DATASET_RECIPE } from "./recipes/explore-dataset.js";
export type { ExploreDatasetInput, ExploreDatasetMetadata } from "./recipes/explore-dataset.js";
export { createEditorAgentSession, editorAgentFeatures } from "./workspace-agent.js";

export { StudioAiTranscriptVerifier, InMemoryStudioAiReplayStore } from "@honua/sdk-js/studio-agent";

export {
  DatasetImportTaskClient,
  DatasetImportUploadClient,
  DatasetImportSubmissionClient,
  hashDatasetImportFile,
} from "@honua/sdk-js/control-plane";

export { ServerProcessEditor } from "./gp/process-workspace.js";
export { HonuaStudioProcessesElement, type ProcessSourcePicker } from "./elements/studio-processes-element.js";

export { LocalProcessEditor } from "./gp/custom-process-workspace.js";

export { HonuaStudioCustomProcessesElement } from "./elements/studio-custom-processes-element.js";

export { MapStyleEditor, type MapStyleEditorOptions, type MapStyleEditorScope } from "./styles/map-style-editor.js";
export type { MapStyleDocument } from "./styles/map-style-edit.js";

export { createContentLifecycleReader, type ContentLifecycleReader } from "./lifecycle/workspace-reader.js";
export {
  readSharedStyleMapConsumer,
  type SharedStyleMapConsumer,
  type SharedStyleMapConsumerReference,
} from "./styles/shared-style-consumer.js";

export { createSharedStylePreview, type SharedStylePreviewOptions } from "./styles/shared-style-preview.js";

export { AuthoritativeStyleProvider } from "./styles/authoritative-style-provider.js";
export {
  AudienceStyleProvider,
  type AudienceStyleProviderOptions,
  type AudienceStyleTransport,
} from "./styles/audience-style-provider.js";

export {
  createReadOnlyMapCanvas,
  type ReadOnlyMapCanvas,
  type ReadOnlyMapCanvasOptions,
} from "./map/read-only-map-canvas.js";

export {
  createReadOnlyAppView,
  type ReadOnlyAppView,
  type ReadOnlyAppViewOptions,
  type ReadOnlyAppDocument,
} from "./map/read-only-composition-view.js";

export * from "./console-entry-deprecated.js";
