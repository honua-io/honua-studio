/**
 * The shared scripted tool-call shape.
 *
 * Chat fixtures and this engine share one deliberately minimal shape, so
 * neither side invents a near-identical one. {@link CompositionToolCall}
 * uses `toolName` and `arguments`, matching
 * `HonuaStudioChatToolCallResultDetail` field-for-field, so a caller can
 * build one from the chat tool-call event without renaming fields.
 *
 * Fixture tool names are a separate vocabulary from
 * {@link COMPOSITION_COMMAND_NAMES}: chat fixtures use snake_case names
 * such as `add_layer`, while this engine uses camelCase names that mirror
 * `@honua/sdk-js`'s agent-tool vocabulary (see `reducer.ts` for why that
 * alignment is load-bearing). Argument shapes differ too. A fixture-authored
 * `toolName` is not assumed to equal a {@link CompositionCommandName};
 * translating names is the tool bridge's job, not this module's.
 *
 * Kept free of any dependency on `model.ts` or `commands.ts` so conversation
 * code can import it without pulling in the reducer or the composition model.
 *
 * @module
 */

/**
 * One scripted tool call, matching `HonuaStudioChatToolCallResultDetail`
 * field-for-field: `toolName` names a tool (in this engine's own fixtures,
 * a {@link CompositionCommandName}; from a chat fixture, whatever vocabulary
 * the fixture used — see the module doc). `arguments` is that tool's payload
 * minus the `name`/`toolName` field.
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
