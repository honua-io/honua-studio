/**
 * The shared scripted tool-call shape (honua-studio#8 build item 5).
 * honua-studio#6 (chat console, streaming, deterministic fixture-conversation
 * mode) built the conversation/authoring side of fixture conversations in
 * parallel with this issue's execution side — rather than each issue
 * defining its own near-identical shape, this single, deliberately minimal
 * module is the coordination point both adopt.
 *
 * ## Reconciliation with #6's shipped shape
 *
 * This module originally used `{ tool, input }`, written before #6 shipped.
 * #6 landed (PR #14, `src/chat/ai-contract.ts` + `src/elements/studio-chat-element.ts`)
 * with the field names `toolName`/`arguments` end to end: the wire
 * `StudioAiChatEvent.toolCallStop` carries `toolName` (from the earlier
 * `toolCallStart`) and `toolArguments`, and `<honua-studio-chat>` dispatches
 * `honua-studio-chat-tool-call-result` with detail
 * `{ messageId, toolCallId, toolName, arguments }`
 * (`HonuaStudioChatToolCallResultDetail`, `src/elements/types.ts`) — the
 * exact "tool-call intent" event that module's own doc comment names this
 * engine as the intended consumer of. {@link CompositionToolCall} is renamed
 * to `{ toolName, arguments }` here to match that shape field-for-field, so
 * honua-studio#7 (wiring the two together) can construct one directly from
 * the event detail without a field-renaming shim:
 * `{ toolName: detail.toolName, arguments: detail.arguments }`.
 *
 * ## Open mismatch #7 still needs to bridge (vocabulary, not shape)
 *
 * #6's own fixtures (`src/chat/fixtures/*.json`) script tool NAMES that do
 * not match this engine's {@link COMPOSITION_COMMAND_NAMES `commands.ts`}
 * vocabulary: `add_layer`, `add_chart`, `filter_layer`,
 * `get_feature_attributes` (snake_case, presumably placeholder/demo names
 * chosen independently) versus this engine's `addLayer`, `addWidget`, …
 * (camelCase, deliberately mirroring `@honua/sdk-js`'s `src/agent-tools/index.ts`
 * — see `reducer.ts`'s module doc for why that alignment is load-bearing and
 * not just style). Argument shapes differ too — e.g. #6's `add_layer` fixture
 * arguments are `{ datasetId, styleBy }`, not this engine's
 * `{ layer: { id, sourceId, styleRef, … } }`. Renaming this module's fields
 * closes the SHAPE gap; closing the NAME/argument-schema gap (a tool-name
 * translation table, e.g. via the honua-server#3002 vocabulary both sides
 * are meant to converge on) is explicitly #7's job, not this module's — a
 * fixture-authored `toolName` is not assumed to already equal a
 * {@link CompositionCommandName}.
 *
 * Kept intentionally free of any dependency on `model.ts`/`commands.ts` so
 * it can be imported by #6's conversation-authoring code without pulling in
 * the reducer or the composition state model.
 *
 * @module
 */

/**
 * One scripted tool call, matching `HonuaStudioChatToolCallResultDetail`
 * field-for-field: `toolName` names a tool (in THIS engine's own fixtures,
 * a {@link CompositionCommandName}; from a live/#6-fixture conversation,
 * whatever vocabulary the model/fixture used — see the module doc's open
 * mismatch note), `arguments` is that tool's payload minus the `name`/
 * `toolName` field.
 */
export interface CompositionToolCall<TArguments = Readonly<Record<string, unknown>>> {
  readonly toolName: string;
  readonly arguments: TArguments;
}

/** A named, ordered sequence of tool calls — one fixture conversation's composition side. */
export interface CompositionToolCallScript {
  readonly id: string;
  readonly description?: string;
  readonly calls: readonly CompositionToolCall[];
}

/** Structural guard: true for any value shaped like a {@link CompositionToolCall} (string `toolName`, plain-object `arguments`). Does not validate `arguments` against a specific command — see `commands.ts`'s `validateCompositionCommand` for that. */
export function isCompositionToolCall(value: unknown): value is CompositionToolCall {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.toolName === "string" && isPlainObject(record.arguments);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
