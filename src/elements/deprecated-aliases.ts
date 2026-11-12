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

/** Set alongside `data-editor-host` for one release. */
export const DEPRECATED_EDITOR_HOST_ATTRIBUTE = "data-workspace-host";

const pendingAliasDispatches: Array<{ dispatch?: () => void }> = [];
let dispatchDepth = 0;

/**
 * Dispatches `event` and, when its type has a deprecated name, a copy under that name. Copies are queued until
 * the outermost dispatch returns, so listeners of either name see nested announcements in the same order.
 */
export function dispatchWithDeprecatedAlias<D>(target: EventTarget, event: CustomEvent<D>): boolean {
  const deprecated = DEPRECATED_EVENT_ALIASES[event.type as keyof typeof DEPRECATED_EVENT_ALIASES];
  const pending: { dispatch?: () => void } = {};
  if (deprecated) pendingAliasDispatches.push(pending);
  dispatchDepth += 1;
  let accepted: boolean;
  try {
    accepted = target.dispatchEvent(event);
  } finally {
    dispatchDepth -= 1;
  }
  if (deprecated) {
    pending.dispatch = () =>
      target.dispatchEvent(
        new CustomEvent<D>(deprecated, { bubbles: event.bubbles, composed: event.composed, detail: event.detail }),
      );
  }
  if (dispatchDepth === 0) {
    for (let next = pendingAliasDispatches.shift(); next; next = pendingAliasDispatches.shift()) next.dispatch?.();
  }
  return accepted;
}
