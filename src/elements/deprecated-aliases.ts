/** Deprecated public method names, kept for one release as delegates to their current names. */
export const DEPRECATED_APP_ELEMENT_ALIASES = {
  createWorkspaceStyleProvider: "createEditorStyleProvider",
  setWorkspaceConversation: "setEditorConversation",
  enableLiveComposition: "enableLiveEditing",
  disableLiveComposition: "disableLiveEditing",
  createWorkspaceDraft: "createEditorDraft",
  attachWorkspaceDraft: "attachEditorDraft",
  refreshWorkspaceDraft: "refreshEditorDraft",
  prepareWorkspaceTurn: "prepareEditorTurn",
  saveWorkspaceVersion: "saveEditorVersion",
  listWorkspaceVersions: "listEditorVersions",
  reviewWorkspacePublication: "reviewEditorRelease",
  publishWorkspaceVersion: "releaseEditorVersion",
  readWorkspacePublication: "readEditorRelease",
  reopenWorkspaceVersion: "reopenEditorVersion",
} as const;

export const DEPRECATED_CHAT_ELEMENT_ALIASES = { setWorkspaceConversation: "setEditorConversation" } as const;

export const DEPRECATED_PROCESSES_ELEMENT_ALIASES = {
  prepareWorkspaceTask: "prepareEditorTask",
  attachWorkspaceTask: "attachEditorTask",
} as const;

export const DEPRECATED_CUSTOM_PROCESSES_ELEMENT_ALIASES = {
  ...DEPRECATED_PROCESSES_ELEMENT_ALIASES,
  refreshWorkspaceTask: "refreshEditorTask",
} as const;

/** Deprecated event names, dispatched alongside their current names for one release. */
export const DEPRECATED_EVENT_ALIASES = {
  "honua-studio-draft-change": "honua-workspace-draft-change",
  "honua-studio-editing-mode-change": "honua-studio-composition-mode-change",
} as const;

type MethodKey<T> = { [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never }[keyof T] & string;

export function defineDeprecatedAliases<T extends object>(
  target: { readonly prototype: T },
  aliases: Readonly<Record<string, MethodKey<T>>>,
): void {
  for (const [deprecated, current] of Object.entries(aliases)) {
    Object.defineProperty(target.prototype, deprecated, {
      configurable: true,
      writable: true,
      value(this: T, ...args: unknown[]) {
        return (this[current] as (...callArgs: unknown[]) => unknown).apply(this, args);
      },
    });
  }
}

/** Dispatches `event` and, when its type has a deprecated name, a copy under that name. */
export function dispatchWithDeprecatedAlias<D>(target: EventTarget, event: CustomEvent<D>): boolean {
  const accepted = target.dispatchEvent(event);
  const deprecated = DEPRECATED_EVENT_ALIASES[event.type as keyof typeof DEPRECATED_EVENT_ALIASES];
  if (deprecated) {
    target.dispatchEvent(
      new CustomEvent<D>(deprecated, { bubbles: event.bubbles, composed: event.composed, detail: event.detail }),
    );
  }
  return accepted;
}
