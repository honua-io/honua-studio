import type { CatalogDataset } from "../client/studio-client.js";
import type { CompositionCommand } from "../composition/commands.js";
import type { CompositionController } from "../composition/controller.js";
import type { CompositionState } from "../composition/model.js";
import { applyCompositionCommands } from "../composition/reducer.js";
import type { HonuaStudioCanvasElement } from "../elements/studio-canvas-element.js";
import type { HonuaStudioChatElement } from "../elements/studio-chat-element.js";
import type { HonuaStudioChatToolCallResultDetail, HonuaStudioCommandOutcome } from "../elements/types.js";
import type { WorkspaceDraftBinding } from "../lifecycle/workspace-draft.js";
import type { ToolCallOrchestrator } from "../mcp/orchestrator.js";
import { resolveToolCall } from "../mcp/tool-bridge.js";
import type { ShellChrome } from "./shell-chrome.js";
import type { SourceCatalog } from "./source-catalog.js";
import type { EpochToken } from "./staleness-epoch.js";
import type { WorkspaceAuthority } from "./workspace-authority.js";
import type { WorkspaceDraftSession } from "./workspace-draft-session.js";

type HistoryAction = "undo" | "redo";
type CommandOptions = { readonly isCurrent?: () => boolean };
type PublishedLayer = { readonly layerId: number; readonly serviceName: string; readonly layerName?: string };

interface DraftEdit {
  readonly binding: WorkspaceDraftBinding;
  readonly generation: EpochToken;
  readonly commands: readonly CompositionCommand[];
  readonly isCurrent?: () => boolean;
}

export interface CompositionEditorOptions {
  readonly authority: WorkspaceAuthority;
  readonly drafts: WorkspaceDraftSession;
  readonly catalog: SourceCatalog;
  readonly composition: CompositionController;
  readonly chrome: ShellChrome;
  readonly orchestrator: () => ToolCallOrchestrator;
  readonly chat: () => HonuaStudioChatElement | undefined;
  readonly canvas: () => HonuaStudioCanvasElement | undefined;
  readonly hasUnsavedStyleChanges: () => boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findPublishedSource(catalog: readonly CatalogDataset[], layer: PublishedLayer): CatalogDataset {
  const suffix = `/rest/services/${layer.serviceName.split("/").map(encodeURIComponent).join("/")}/FeatureServer`;
  const matches = catalog.filter(
    (entry) =>
      entry.locator?.layerId === layer.layerId &&
      typeof entry.locator.url === "string" &&
      entry.locator.url.endsWith(suffix),
  );
  if (matches.length !== 1) throw new Error("The published layer has no unique verified catalog source.");
  return matches[0]!;
}

/** Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z and Ctrl/Cmd+Y outside text entry. */
export function historyShortcutAction(event: KeyboardEvent): HistoryAction | undefined {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return undefined;
  const editsText = event
    .composedPath()
    .some(
      (target) =>
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)),
    );
  if (editsText) return undefined;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  return key === "y" ? "redo" : undefined;
}

/**
 * The one composition write path for widgets, chat, recipes and the editor. With an attached draft every
 * edit lands on the server first; otherwise the orchestrator applies it locally or through live MCP tools.
 */
export class CompositionEditor {
  constructor(private readonly options: CompositionEditorOptions) {}

  /**
   * Commands run in order and stop at the first failure: a compare switch's two toggles are one gesture,
   * and half of it landing is worse than none of it.
   */
  async dispatch(
    commands: readonly CompositionCommand[],
    options?: CommandOptions,
  ): Promise<HonuaStudioCommandOutcome> {
    if (options?.isCurrent?.() === false) return { ok: false, reason: "The initiating view changed." };
    if (this.options.hasUnsavedStyleChanges() && commands.some((command) => command.name !== "setMapStyle"))
      return { ok: false, reason: "Save or discard visual style edits before changing the map." };
    const { binding } = this.options.drafts;
    if (binding) {
      const generation = this.options.authority.epoch.current;
      return this.#dispatchToDraft({ binding, generation, commands, isCurrent: options?.isCurrent });
    }
    const { session } = this.options.authority;
    if (session && "kind" in session && session.kind === "cookie")
      return { ok: false, reason: "Attach the shared server draft before editing the map." };
    for (const command of commands) {
      const result = await this.options.orchestrator().handleToolCall({
        toolName: command.name,
        arguments: { ...command } as Record<string, unknown>,
      });
      if (!result.ok) return { ok: false, reason: result.reason };
    }
    return { ok: true };
  }

  /** Resolves one chat tool-call intent. Never throws: every outcome lands in the activity log. */
  async handleChatToolCall(detail: HonuaStudioChatToolCallResultDetail): Promise<void> {
    if (!detail.toolName) return;
    const args = isPlainObject(detail.arguments) ? detail.arguments : {};
    if (!this.options.drafts.binding) {
      await this.options.orchestrator().handleToolCall({ toolName: detail.toolName, arguments: args });
      return;
    }
    const resolved = resolveToolCall({ toolName: detail.toolName, arguments: args });
    const outcome = resolved.ok ? await this.dispatch([resolved.command]) : resolved;
    if (!outcome.ok)
      this.options.chat()?.activityLog.append("assistant_turn_error", {
        phase: "workspace-command",
        errorMessage: outcome.reason,
      });
  }

  async addCatalogSource(dataset: CatalogDataset): Promise<void> {
    const { catalog } = this.options;
    if (!catalog.catalog?.some((entry) => entry.id === dataset.id)) {
      catalog.apply([...(catalog.catalog ?? []), dataset]);
    }
    const result = await this.dispatch([
      { name: "addLayer", layer: { id: dataset.id, sourceId: dataset.id, title: dataset.title } },
    ]);
    if (!result.ok) throw new Error(result.reason);
  }

  /** Resolve an observed published receipt against the live catalog before adding it to the map. */
  async addPublishedLayer(layer: PublishedLayer, options?: CommandOptions): Promise<HonuaStudioCommandOutcome> {
    const { authority } = this.options;
    const lease = { auth: authority.auth, token: authority.lease.current };
    const requireOriginalTarget = this.#originalTargetGuard(options);
    requireOriginalTarget();
    const catalog = await this.#readCatalogUnderLease(lease, requireOriginalTarget);
    const source = findPublishedSource(catalog, layer);
    this.options.catalog.apply(catalog);
    return this.dispatch(
      [{ name: "addLayer", layer: { id: source.id, sourceId: source.id, title: layer.layerName ?? source.title } }],
      options,
    );
  }

  /** Undo/redo in the authoritative draft before advancing the visible history. */
  async applyHistory(action: HistoryAction): Promise<boolean> {
    const { drafts, chrome, authority } = this.options;
    if (drafts.historyBusy || this.options.hasUnsavedStyleChanges()) return false;
    const authGeneration = authority.epoch.current;
    drafts.historyBusy = true;
    chrome.paintHistory();
    try {
      return await this.#runHistory(action);
    } catch (error) {
      if (drafts.binding && authority.epoch.isCurrent(authGeneration)) drafts.markConflict();
      chrome.setHistoryStatus(error instanceof Error ? error.message : `Unable to ${action}.`);
      return false;
    } finally {
      drafts.historyBusy = false;
      chrome.paintHistory();
    }
  }

  async #runHistory(action: HistoryAction): Promise<boolean> {
    const { composition, drafts } = this.options;
    const { binding } = drafts;
    let applied: boolean;
    if (binding) {
      const target = action === "undo" ? composition.history.peekUndo() : composition.history.peekRedo();
      if (!target) return false;
      applied = await this.#replaceDraftHistory(binding, target, action);
    } else applied = await this.options.orchestrator().applyHistoryAction(action);
    const { draftId, generation } = this.options.orchestrator();
    if (applied && draftId && generation !== undefined) {
      this.options.chat()?.agentSession?.attachDraft({ draftId, generation });
    }
    this.options.chrome.setHistoryStatus(
      applied ? (action === "undo" ? "Undone" : "Redone") : `Unable to ${action}. Review the activity log.`,
    );
    return applied;
  }

  #replaceDraftHistory(
    binding: WorkspaceDraftBinding,
    target: CompositionState,
    action: HistoryAction,
  ): Promise<boolean> {
    const { authority, composition, drafts } = this.options;
    const generation = authority.epoch.current;
    return drafts.enqueue(async () => {
      authority.epoch.assertCurrent(generation, "The workspace session changed.");
      const observed = await binding.replace(target);
      authority.epoch.assertCurrent(generation, "The workspace session changed.");
      const changed = action === "undo" ? composition.undo() : composition.redo();
      composition.replaceState(observed);
      drafts.announce();
      return changed;
    });
  }

  #dispatchToDraft(edit: DraftEdit): Promise<HonuaStudioCommandOutcome> {
    const { authority, drafts } = this.options;
    return drafts.enqueue(async (): Promise<HonuaStudioCommandOutcome> => {
      if (edit.isCurrent?.() === false)
        return { ok: false, reason: "The initiating view changed before the edit began." };
      try {
        await this.#applyToDraft(edit);
        return { ok: true };
      } catch (error) {
        if (authority.epoch.isCurrent(edit.generation) && edit.binding === drafts.binding) drafts.markConflict();
        return { ok: false, reason: errorMessage(error) };
      }
    });
  }

  async #applyToDraft(edit: DraftEdit): Promise<void> {
    const { authority, composition, drafts } = this.options;
    const { binding, generation, commands } = edit;
    authority.epoch.assertCurrent(generation, "The workspace session changed.");
    if (binding !== drafts.binding) throw new Error("The active map changed before the edit began.");
    const styleCommand = commands.length === 1 && commands[0]?.name === "setMapStyle" ? commands[0] : undefined;
    const anchor = styleCommand ? await this.#styleAnchor(edit) : composition.state;
    const target = applyCompositionCommands(anchor, commands).state;
    const observed = styleCommand
      ? {
          ...(await binding.replaceStyle(styleCommand.mapSpec)),
          pins: target.pins,
          annotations: target.annotations,
        }
      : await binding.replace(target);
    authority.epoch.assertCurrent(generation, "The workspace session changed.");
    // The accepted style response establishes one authoritative revision;
    // replaying it against the older source anchor would reject valid additions.
    if (!styleCommand) for (const command of commands) composition.apply(command);
    composition.replaceState(observed);
    drafts.announce();
  }

  /**
   * New composition sources are resolved by the authorized canvas, not supplied by the editor, so a style
   * candidate is validated against the canvas's current style snapshot.
   */
  async #styleAnchor(edit: DraftEdit): Promise<CompositionState> {
    const { authority, composition, drafts } = this.options;
    const current = composition.state;
    const canvas = this.options.canvas();
    if (!canvas) throw new Error("Open the map canvas before editing its style.");
    const mapSpec = await canvas.editableMapStyle();
    if (!authority.epoch.isCurrent(edit.generation) || edit.binding !== drafts.binding)
      throw new Error("The workspace session changed.");
    if (current !== composition.state || edit.isCurrent?.() === false)
      throw new Error("The map changed while preparing its style.");
    return { ...current, mapSpec };
  }

  #originalTargetGuard(options: CommandOptions | undefined): () => void {
    const { authority, drafts } = this.options;
    const mapEpoch = drafts.activeMap.current;
    const authorityGeneration = authority.epoch.current;
    return () => {
      if (
        !drafts.activeMap.isCurrent(mapEpoch) ||
        !authority.epoch.isCurrent(authorityGeneration) ||
        options?.isCurrent?.() === false
      )
        throw new Error("The active map changed while resolving the published layer. Review the map and try again.");
    };
  }

  /** A same-authority cookie lease may renew during discovery; never dispatch a catalog read by the old lease. */
  async #readCatalogUnderLease(
    lease: { readonly auth: unknown; readonly token: EpochToken },
    requireOriginalTarget: () => void,
  ): Promise<readonly CatalogDataset[]> {
    const { authority } = this.options;
    const catalog = await authority.studioClient.listCatalog();
    requireOriginalTarget();
    if (authority.auth === lease.auth && authority.lease.isCurrent(lease.token)) return catalog;
    const renewed = { auth: authority.auth, token: authority.lease.current };
    const renewedCatalog = await authority.studioClient.listCatalog();
    requireOriginalTarget();
    if (authority.auth !== renewed.auth || !authority.lease.isCurrent(renewed.token))
      throw new Error("The Studio target changed while resolving the published layer.");
    return renewedCatalog;
  }
}
