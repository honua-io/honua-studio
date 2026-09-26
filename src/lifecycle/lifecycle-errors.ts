/**
 * Typed error channel for {@link StudioLifecycleClient} — mirrors the
 * discriminated-error pattern already established by `mcp/errors.ts`
 * (`McpToolError`/`isMcpGenerationConflict`) and
 * `composition/history.ts` (`CompositionDraftError`/`isCompositionDraftConflict`),
 * scaled to the lifecycle API's RFC 7807 problem-details contract
 * (`https://honua.io/problems/studio`) documented in
 * `docs/internal/admin-api/studio-package-lifecycle.md` (honua-server).
 *
 * ## Why not `@honua/sdk-js/studio`'s `HonuaStudioError`
 *
 * Because this taxonomy covers two failure modes the SDK's does not, and
 * both are ones {@link StudioLifecycleClient}'s callers branch on:
 * {@link StudioLifecycleSessionExpiredError} (a `401` that survived the
 * forced-refresh retry — "sign in again", not "the server is down") and
 * {@link StudioLifecycleTransportError} (the request never got a response to
 * classify at all). `HonuaStudioProblemKind` has no discriminant for either;
 * it classifies HTTP statuses, and neither of these has one.
 *
 * The overlapping half is deliberately the SDK's spelling — `.code` carries
 * the same `generation-conflict` / `not-found` / `validation` / `internal`
 * discriminants, so `isStudioLifecycleGenerationConflict` and
 * `isHonuaStudioGenerationConflict` mean the same thing and
 * `./composition-draft-store.ts` can translate one into the other without a
 * lookup table.
 *
 * @module
 */
import type { StudioProblemDetails } from "./lifecycle-types.js";

export type StudioLifecycleErrorCode =
  | "generation-conflict" // 409 — stale `generation` on a draft replace
  | "not-found" // 404
  | "validation" // 400
  | "internal" // 500
  | "session-expired" // 401 after one forced-refresh retry
  | "unknown";

/** Base error for every {@link StudioLifecycleClient} failure. `.problem` carries the parsed RFC 7807 body when the server returned one. */
export class StudioLifecycleError extends Error {
  public readonly code: StudioLifecycleErrorCode;
  public readonly status: number | undefined;
  public readonly problem: StudioProblemDetails | undefined;

  public constructor(
    code: StudioLifecycleErrorCode,
    message: string,
    options: { readonly status?: number; readonly problem?: StudioProblemDetails; readonly cause?: unknown } = {},
  ) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    this.name = "StudioLifecycleError";
    this.code = code;
    this.status = options.status;
    this.problem = options.problem;
  }
}

/** 409 on `PUT /package-drafts/{draftId}` (or a save-as-version that raced a concurrent update) — the caller should reload the draft and retry. */
export class StudioLifecycleConflictError extends StudioLifecycleError {
  public constructor(
    message: string,
    options: { readonly status?: number; readonly problem?: StudioProblemDetails } = {},
  ) {
    super("generation-conflict", message, options);
    this.name = "StudioLifecycleConflictError";
  }
}

/** Thrown when a request 401s even after a forced-refresh retry — the caller should prompt sign-in. Mirrors `client/studio-client.ts`'s `StudioSessionExpiredError`. */
export class StudioLifecycleSessionExpiredError extends StudioLifecycleError {
  public constructor(url: string) {
    super("session-expired", `Your session has expired. Sign in again to reach ${url}.`);
    this.name = "StudioLifecycleSessionExpiredError";
  }
}

/** Network/transport failure — the request never got a response to interpret. */
export class StudioLifecycleTransportError extends StudioLifecycleError {
  public constructor(message: string, cause?: unknown) {
    super("unknown", message, { cause });
    this.name = "StudioLifecycleTransportError";
  }
}

export function isStudioLifecycleGenerationConflict(error: unknown): error is StudioLifecycleConflictError {
  return error instanceof StudioLifecycleError && error.code === "generation-conflict";
}

export function isStudioLifecycleNotFound(error: unknown): error is StudioLifecycleError {
  return error instanceof StudioLifecycleError && error.code === "not-found";
}
