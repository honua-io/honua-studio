# Vocabulary renames (#217)

Studio's public names follow the Honua vocabulary: Studio content is a Map or App, with Draft, Version and Released states, and the editor is not a workspace. The canonical terms are in honua-server `docs/concepts/domain/README.md`.

Studio has only preview releases, so these names are renamed outright, with no deprecated aliases, dual event dispatch, old host attribute or old global. This is a breaking change: Honua Console must move to the new names when it bumps its Studio release lock. Server-owned wire names (`packageKey`, `family`, `workspaceId`, `X-Honua-Workspace`) are unchanged.

`test/vocabulary/retired-terms.test.ts` fails when an old name below returns to a tracked file, other than the files listed in its `RENAME_RECORDS`, or drops off this page.

## Public names

| Old | New |
| --- | --- |
| `createWorkspaceDraft` / `attachWorkspaceDraft` / `refreshWorkspaceDraft` | `createEditorDraft` / `attachEditorDraft` / `refreshEditorDraft` |
| `prepareWorkspaceTurn` | `prepareEditorTurn` |
| `saveWorkspaceVersion` / `listWorkspaceVersions` / `reopenWorkspaceVersion` | `saveEditorVersion` / `listEditorVersions` / `reopenEditorVersion` |
| `reviewWorkspacePublication` / `publishWorkspaceVersion` / `readWorkspacePublication` | `reviewEditorRelease` / `releaseEditorVersion` / `readEditorRelease` |
| `setWorkspaceConversation` (app and chat) / `createWorkspaceStyleProvider` | `setEditorConversation` / `createEditorStyleProvider` |
| `enableLiveComposition` / `disableLiveComposition` | `enableLiveEditing` / `disableLiveEditing` |
| `prepareWorkspaceTask` / `attachWorkspaceTask` / `refreshWorkspaceTask` (processes elements) | `prepareEditorTask` / `attachEditorTask` / `refreshEditorTask` |
| event `honua-workspace-draft-change` | `honua-studio-draft-change` |
| event `honua-studio-composition-mode-change` | `honua-studio-editing-mode-change` |
| host attribute `data-workspace-host` (`dataset` key `workspaceHost`) | `data-editor-host` (`dataset` key `editorHost`) |
| `createWorkspaceAgentSession` / `workspaceAgentFeatures` | `createEditorAgentSession` / `editorAgentFeatures` |
| `ServerProcessWorkspace` / `LocalProcessWorkspace` | `ServerProcessEditor` / `LocalProcessEditor` |
| `createWorkspaceLifecycleReader` / `WorkspaceLifecycleReader` | `createContentLifecycleReader` / `ContentLifecycleReader` |
| `createReadOnlyCompositionView` / `ReadOnlyCompositionView` / `ReadOnlyCompositionViewOptions` / `ReadOnlyCompositionDocument` | `createReadOnlyAppView` / `ReadOnlyAppView` / `ReadOnlyAppViewOptions` / `ReadOnlyAppDocument` |
| `HonuaStudioCompositionModeChangeDetail` / `LiveCompositionOptions` (internal types, not exported) | `HonuaStudioEditingModeChangeDetail` / `LiveEditingOptions` |
| global `HonuaStudioWorkspace` | `HonuaStudioEditor` |
| activity-log entry type `composition_mode_changed` | `editing_mode_changed` |
| activity-log `assistant_turn_error` phase `workspace-command` | `editor-command` |
| `<honua-studio-gp-panel>` button "Add to composition" | "Add to map" |

## Error messages

Hosts that match on error text should use the new messages.

| Old | New |
| --- | --- |
| The workspace draft or authority changed. | The editor draft or authority changed. |
| The workspace authority changed. | The editor authority changed. |
| The workspace session changed. | The editor session changed. |
| The selected style workspace authority changed. | The selected style editor authority changed. |
| Use 1–200 letters, numbers, dots, dashes or underscores for the package key. | Use 1–200 letters, numbers, dots, dashes or underscores for the content key. |
| Save or explicitly reload the pending Studio edits before sending a workspace turn. | Save or explicitly reload the pending Studio edits before sending an editor turn. |
| The workspace session or map changed. | The editor session or map changed. |
| Review the saved version in the current workspace before publishing. | Review the saved version in the current editor session before publishing. |
| Review the saved version again in the original workspace session before publishing. | Review the saved version again in the original editor session before publishing. |
| ${WORKSPACE_AUTHORITY_CHANGED} Reopen this draft in its original workspace. | ${EDITOR_AUTHORITY_CHANGED} Reopen this draft in its original editor session. |
| Retry this submission only in its original workspace authority. | Retry this submission only in its original editor authority. |
| Retry this submission with its original inputs and workspace authority. | Retry this submission with its original inputs and editor authority. |
| The workspace draft is unavailable. | The editor draft is unavailable. |
| The workspace draft changed while opening the style editor. | The editor draft changed while opening the style editor. |
| Invalid content item page. | Invalid Studio content page. |
| Invalid content item identity or state. | Invalid Studio content identity or state. |
| Content item pagination repeated a cursor. | Studio content pagination repeated a cursor. |
| Content items exceeded the bounded page limit. | Studio content exceeded the bounded page limit. |
| ${CONTROL_KIND_LABELS[control.kind]} "${control.id}" reads from "${control.sourceId}", which is not a layer in this composition (nor a source any layer binds). | ${CONTROL_KIND_LABELS[control.kind]} "${control.id}" reads from "${control.sourceId}", which is not a layer in this map (nor a source any layer binds). |
| Invalid workspace conversation projection. | Invalid editor conversation history. |
| The local workspace session changed. | The local process session changed. |
| The composition refused that change. | The map refused that change. |
| The import workspace changed during the request. | The import scope changed during the request. |
| Server returned no verified immutable package hash. | Server returned no verified immutable workflow hash. |
| The immutable workflow package reference does not match. | The immutable workflow reference does not match. |
| Command acceptance is unknown or belongs to another package. No new run was submitted. | Command acceptance is unknown or belongs to another workflow. No new run was submitted. |
| The command publication identity is bound to another immutable package. | The command publication identity is bound to another immutable workflow. |
| Attach an authorized workspace draft before editing. | Attach an authorized editor draft before editing. |
| No approved render layer remains for this composition layer. | No approved render layer remains for this drawing layer. |
| Source "${layer.sourceId}" requests layer type "${authoredType}", which the composition map cannot render yet. | Source "${layer.sourceId}" requests layer type "${authoredType}", which the map cannot render yet. |
| Source "${layer.sourceId}" is raster (${descriptor.geometryType}); the composition map renders vector sources only so far. | Source "${layer.sourceId}" is raster (${descriptor.geometryType}); the map renders vector sources only so far. |
| Source "${layer.sourceId}" advertises protocol "${protocol ?? "unknown"}", which the composition map cannot render yet. | Source "${layer.sourceId}" advertises protocol "${protocol ?? "unknown"}", which the map cannot render yet. |
| No live Studio composition session is attached. | No live Studio editing session is attached. |
| Live Studio composition session changed while its draft was being created. | Live Studio editing session changed while its draft was being created. |
| The selected map consumer is not a supported canonical map package. | The selected map consumer is not a supported canonical map. |
| The composition changed since the suggestion. | The map changed since the suggestion. |
