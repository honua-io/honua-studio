/**
 * Type declaration for byom-preview-model.mjs, consulted only by `tsc --noEmit`.
 */

export interface ByomPreviewEvent {
  readonly type: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly toolArguments?: Readonly<Record<string, unknown>>;
  readonly toolArgumentsDelta?: string;
  readonly text?: string;
  readonly errorMessage?: string;
  readonly stopReason?: string;
}

export declare function planByomPreviewTurn(input: {
  readonly messages?: ReadonlyArray<{ readonly role?: string; readonly content?: string }>;
  readonly tools?: ReadonlyArray<{ readonly name?: string; readonly inputSchema?: unknown }>;
  readonly toolChoice?: { readonly mode?: string; readonly toolName?: string };
}): { readonly events: readonly ByomPreviewEvent[] };
