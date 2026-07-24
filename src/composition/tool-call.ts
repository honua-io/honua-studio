/**
 * The shared `{ tool, input }` fixture tool-call shape (honua-studio#8 build
 * item 5). honua-studio#6 (chat console, streaming, deterministic
 * fixture-conversation mode) is building the conversation/authoring side of
 * fixture conversations in parallel with this issue's execution side —
 * rather than each issue defining its own near-identical shape, this
 * single, deliberately minimal module is the coordination point both adopt.
 *
 * Kept intentionally free of any dependency on `model.ts`/`commands.ts` so
 * it can be imported by #6's conversation-authoring code without pulling in
 * the reducer or the composition state model.
 *
 * @module
 */

/** One scripted tool call: `tool` names a composition command (see `commands.ts`'s `COMPOSITION_COMMAND_NAMES`), `input` is that command's payload minus the `name` field. */
export interface CompositionToolCall<TInput = Readonly<Record<string, unknown>>> {
  readonly tool: string;
  readonly input: TInput;
}

/** A named, ordered sequence of tool calls — one fixture conversation's composition side. */
export interface CompositionToolCallScript {
  readonly id: string;
  readonly description?: string;
  readonly calls: readonly CompositionToolCall[];
}

/** Structural guard: true for any value shaped like a {@link CompositionToolCall} (string `tool`, plain-object `input`). Does not validate `input` against a specific command — see `commands.ts`'s `validateCompositionCommand` for that. */
export function isCompositionToolCall(value: unknown): value is CompositionToolCall {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.tool === "string" && isPlainObject(record.input);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
