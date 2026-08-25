/**
 * Orchestration: the piece that actually wires a chat tool-call intent to
 * composition state (honua-studio#7 build item 3). The flow, per tool call:
 *
 * ```
 * chat tool-call intent (CompositionToolCall)
 *   -> tool-bridge.ts's resolveToolCall()         [translation]
 *   -> EITHER
 *        (a) a live session is attached AND the resolved command has a
 *            server-tool counterpart (AD-8 authoritative path):
 *            call the honua_studio_* tool directly, refresh local
 *            composition state from the RETURNED draft (never assume the
 *            server applied exactly what was asked — read back what it
 *            says happened), OR
 *        (b) no live session, OR the command has no server-tool
 *            counterpart (pin/unpin/addAnnotation/removeAnnotation — not
 *            part of the server's StudioCompositionBody wire schema at all,
 *            see tool-bridge.ts's module doc): apply through the local
 *            reducer only (fixture/offline mode's only path; also how
 *            annotation/pin commands are always applied, live session or
 *            not)
 *   -> canvas re-render (CompositionController.apply/replaceState already
 *      notifies its subscribers — <honua-studio-canvas> is one)
 *   -> an ActivityLog entry recording the outcome
 * ```
 *
 * The generation-conflict path (path (a) above): a `failed_precondition`
 * from the server tool call triggers exactly one reload
 * (`honua_studio_get_draft`) + retry with the fresh generation — "rebase"
 * here is the same default `CompositionDraftRebase` semantics
 * `composition/history.ts`'s `DraftSync` uses (the client's own intent is
 * retried as-is against the fresh generation, not merged); a second failure
 * is surfaced rather than retried again.
 *
 * Never throws from {@link ToolCallOrchestrator.handleToolCall} — every
 * outcome (bridge failure, local reducer rejection, server tool failure) is
 * a typed {@link ToolCallOrchestrationResult} AND an activity-log entry, so
 * a host never has to wrap this call in its own try/catch to keep the UI
 * responsive.
 *
 * ## What `StudioAgentSession` supersedes here (honua-studio#40)
 *
 * `@honua/sdk-js/studio-agent` now ships `createStudioAgentSession`, and the
 * pin carries it (honua-studio#30). It is the retirement target for this
 * module and for `elements/studio-chat-element.ts`'s turn loop, but it is
 * #40's work, not #30's — wiring it changes behavior (it is what finally
 * CLOSES the model turn: declaring tool definitions to the proxy and feeding
 * tool results back), and #30 deletes mirrors without changing behavior.
 * Concretely, when #40 lands:
 *
 *  - **Superseded.** The turn loop itself — streaming a turn, routing each
 *    tool call to the tool plane, feeding the result back, and deciding when
 *    the turn is done. `StudioAgentSession` owns that, with the same
 *    `failed_precondition` reload-and-retry-once semantics this module
 *    implements below (`parseStudioDraftResult` is the SDK's counterpart to
 *    `studio-tools.ts`'s draft parsing).
 *  - **Not superseded.** Everything that makes a tool call land in *this*
 *    app: `tool-bridge.ts`'s command→tool translation and its
 *    client-local-only commands (pin/annotate), the reducer application,
 *    `CompositionController` refresh from the returned draft, and the
 *    `ActivityLog` entries. `StudioAgentSession` takes a tool plane; it does
 *    not take a composition engine.
 *  - **Also ported, also #40's call.** The SDK's `studio-agent` entrypoint
 *    carries verbatim ports of `./client.ts`, `./protocol.ts`, `./errors.ts`
 *    and `../chat/{ai-contract,sse-parser,sse-transport,transport,capabilities-client}.ts`
 *    (its own module docs say so). Those are mirrors and should go, but they
 *    go with the session that replaces their caller, not before it.
 *
 * @module
 */
import type { ActivityLog } from "../chat/activity-log.js";
import type { CompositionCommand } from "../composition/commands.js";
import type { CompositionController } from "../composition/controller.js";
import { applyCompositionCommand, isCompositionCommandError } from "../composition/reducer.js";
import type { CompositionToolCall } from "../composition/tool-call.js";
import type { McpClient } from "./client.js";
import { isMcpGenerationConflict } from "./errors.js";
import type { StudioMcpDraft, StudioMcpToolName, StudioPackageFamilyWire } from "./studio-tools.js";
import { StudioMcpToolClient, parseStudioDraftResult } from "./studio-tools.js";
import {
  type ToolBridgeErrorCode,
  applyStudioDraft,
  buildServerToolInvocation,
  resolveToolCall,
  toStudioCompositionBody,
} from "./tool-bridge.js";

export interface ToolCallOrchestratorLiveOptions {
  readonly client: McpClient;
  /** The Studio package key a lazily-created draft is filed under. Ignored when `draftId` is supplied (attaching to an existing draft). */
  readonly packageKey: string;
  readonly family?: StudioPackageFamilyWire;
  readonly schemaVersion?: string;
  /** Attach to an already-existing draft instead of lazily creating one on the first server-bound tool call. */
  readonly draftId?: string;
  readonly generation?: number;
}

export type ToolCallOrchestrationMode = "local" | "server";

export interface ToolCallOrchestrationSuccess {
  readonly ok: true;
  readonly toolName: string;
  readonly mode: ToolCallOrchestrationMode;
  readonly command: CompositionCommand;
  /** Present only for `mode: "server"` — the draft returned by the server tool call this command resolved to. */
  readonly draft?: StudioMcpDraft;
}

export type ToolCallOrchestrationErrorCode = ToolBridgeErrorCode | "reducer-rejected" | "server-error";

export interface ToolCallOrchestrationFailure {
  readonly ok: false;
  readonly toolName: string;
  readonly code: ToolCallOrchestrationErrorCode;
  readonly reason: string;
}

export type ToolCallOrchestrationResult = ToolCallOrchestrationSuccess | ToolCallOrchestrationFailure;

export interface ToolCallOrchestratorOptions {
  readonly controller: CompositionController;
  /** Shared with the chat console's own log, if the host wants composition entries interleaved with chat entries (`chatEl.activityLog`) — same "shared activity log" pattern the console already documents. Entries are appended if present; orchestration still works without one. */
  readonly activityLog?: ActivityLog;
  /** When present: the AD-8 authoritative path is used for every resolved command that has a server-tool counterpart. Omit for fixture/offline mode (every command applies through the local reducer only). */
  readonly live?: ToolCallOrchestratorLiveOptions;
}

/**
 * Wires tool-call intents to composition state — see the module doc for the
 * full flow. One instance per composition session (one `CompositionController`,
 * at most one live server draft).
 */
export class ToolCallOrchestrator {
  readonly #controller: CompositionController;
  readonly #activityLog: ActivityLog | undefined;
  #live: ToolCallOrchestratorLiveOptions | undefined;
  #studioTools: StudioMcpToolClient | undefined;
  #draftId: string | undefined;
  #generation: number | undefined;
  /** Serializes server-bound calls so two rapid tool-call events never race the same draft's generation against each other. */
  #serverQueue: Promise<unknown> = Promise.resolve();

  public constructor(options: ToolCallOrchestratorOptions) {
    this.#controller = options.controller;
    this.#activityLog = options.activityLog;
    if (options.live) this.attachLiveSession(options.live);
  }

  /** The draft this session is composing against in live mode, or `undefined` (fixture/offline mode, or no draft created yet). */
  public get draftId(): string | undefined {
    return this.#draftId;
  }

  public get generation(): number | undefined {
    return this.#generation;
  }

  public get isLive(): boolean {
    return this.#live !== undefined;
  }

  /** Attaches (or replaces) the live session. Passing `draftId`/`generation` skips lazy draft creation. */
  public attachLiveSession(options: ToolCallOrchestratorLiveOptions): void {
    this.#live = options;
    this.#studioTools = new StudioMcpToolClient(options.client);
    this.#draftId = options.draftId;
    this.#generation = options.generation;
  }

  /** Reverts to fixture/offline mode — every subsequent command applies through the local reducer only. Does not clear local composition state. */
  public detachLiveSession(): void {
    this.#live = undefined;
    this.#studioTools = undefined;
    this.#draftId = undefined;
    this.#generation = undefined;
  }

  /**
   * Resolves and applies one tool-call intent. Never throws — see the
   * module doc. Server-bound calls are queued (never overlapped) so a burst
   * of tool-call events applies to the draft strictly in order.
   */
  public async handleToolCall(call: CompositionToolCall): Promise<ToolCallOrchestrationResult> {
    const resolution = resolveToolCall(call);
    if (!resolution.ok) {
      return this.#reject(call.toolName, resolution.code, resolution.reason);
    }

    const useServer = this.#live !== undefined && resolution.serverToolName !== undefined;
    if (!useServer) {
      return this.#applyLocal(call.toolName, resolution.command);
    }

    // Queued: a burst of tool-call events (e.g. a multi-step assistant turn)
    // must hit the draft strictly in order, never two in flight at once
    // racing the same generation.
    const run = this.#serverQueue.then(() =>
      this.#applyServer(call.toolName, resolution.command, resolution.serverToolName as StudioMcpToolName),
    );
    // Swallow so one failed call doesn't poison the queue for the next one.
    this.#serverQueue = run.catch(() => undefined);
    return run;
  }

  #applyLocal(toolName: string, command: CompositionCommand): ToolCallOrchestrationResult {
    try {
      this.#controller.apply(command);
    } catch (error) {
      const reason = isCompositionCommandError(error) ? error.message : String(error);
      return this.#reject(toolName, "reducer-rejected", reason);
    }
    return this.#accept(toolName, "local", command);
  }

  async #applyServer(
    toolName: string,
    command: CompositionCommand,
    serverToolName: StudioMcpToolName,
  ): Promise<ToolCallOrchestrationResult> {
    // Pre-flight local validation against this client's cached view — fails
    // fast (duplicate id, out-of-bounds zoom, pinned target, …) without a
    // network round trip. Never committed to the controller's history: the
    // server's response is what actually lands via `replaceState` below, so
    // this check exists purely to reject obviously-invalid commands early.
    try {
      applyCompositionCommand(this.#controller.state, command);
    } catch (error) {
      const reason = isCompositionCommandError(error) ? error.message : String(error);
      return this.#reject(toolName, "reducer-rejected", reason);
    }

    let draftId: string;
    let generation: number;
    try {
      ({ draftId, generation } = await this.#ensureDraft());
    } catch (error) {
      return this.#reject(toolName, "server-error", errorMessage(error));
    }

    const invocation = buildServerToolInvocation(
      { ok: true, toolName, vocabulary: "composition", command, serverToolName },
      { draftId, generation },
    );
    if (!invocation) {
      // Unreachable given `useServer`'s own guard, but keeps this method
      // total rather than asserting.
      return this.#reject(toolName, "unsupported", `"${command.name}" has no server tool invocation to build.`);
    }

    let draft: StudioMcpDraft;
    try {
      draft = await this.#callServerTool(invocation);
    } catch (error) {
      return this.#reject(toolName, "server-error", errorMessage(error));
    }

    this.#generation = draft.generation;
    this.#controller.replaceState(applyStudioDraft(draft, this.#controller.state));
    return this.#accept(toolName, "server", command, draft);
  }

  /** One generation-conflict reload+retry, per the module doc. */
  async #callServerTool(
    invocation: { readonly name: StudioMcpToolName; readonly arguments: Record<string, unknown> },
    retried = false,
  ): Promise<StudioMcpDraft> {
    const live = this.#live;
    if (!live) throw new Error("ToolCallOrchestrator: no live session attached.");
    try {
      const result = await live.client.callTool(invocation.name, invocation.arguments);
      return parseStudioDraftResult(result);
    } catch (error) {
      if (retried || !isMcpGenerationConflict(error) || !this.#draftId || !this.#studioTools) throw error;
      const refreshed = await this.#studioTools.getDraft(this.#draftId);
      this.#generation = refreshed.generation;
      this.#controller.replaceState(applyStudioDraft(refreshed, this.#controller.state));
      const retryInvocation = {
        ...invocation,
        arguments: { ...invocation.arguments, generation: refreshed.generation },
      };
      return this.#callServerTool(retryInvocation, true);
    }
  }

  /** Lazily creates the draft this session composes against, seeded with whatever local composition state already exists — idempotent once a draft is established. */
  async #ensureDraft(): Promise<{ readonly draftId: string; readonly generation: number }> {
    if (this.#draftId !== undefined && this.#generation !== undefined) {
      return { draftId: this.#draftId, generation: this.#generation };
    }
    const live = this.#live;
    const tools = this.#studioTools;
    if (!live || !tools) throw new Error("ToolCallOrchestrator: no live session attached.");
    const draft = await tools.createDraft({
      packageKey: live.packageKey,
      family: live.family ?? "map",
      schemaVersion: live.schemaVersion ?? "1",
      body: toStudioCompositionBody(this.#controller.state),
    });
    this.#draftId = draft.draftId;
    this.#generation = draft.generation;
    this.#controller.replaceState(applyStudioDraft(draft, this.#controller.state));
    return { draftId: draft.draftId, generation: draft.generation };
  }

  #accept(
    toolName: string,
    mode: ToolCallOrchestrationMode,
    command: CompositionCommand,
    draft?: StudioMcpDraft,
  ): ToolCallOrchestrationSuccess {
    this.#activityLog?.append("composition_command_applied", {
      toolName,
      mode,
      command: command.name,
      ...(draft ? { draftId: draft.draftId, generation: draft.generation } : {}),
    });
    return { ok: true, toolName, mode, command, ...(draft ? { draft } : {}) };
  }

  #reject(toolName: string, code: ToolCallOrchestrationErrorCode, reason: string): ToolCallOrchestrationFailure {
    this.#activityLog?.append("composition_command_rejected", { toolName, code, reason });
    return { ok: false, toolName, code, reason };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
