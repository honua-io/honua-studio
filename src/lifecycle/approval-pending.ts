import type { StudioPublicationIdentifiers } from "@honua/sdk-js/studio";

/** A durable operation awaiting a separate approval; no content pointer has moved. */
export interface StudioApprovalPending extends StudioPublicationIdentifiers {
  readonly status: "awaiting-approval";
  readonly operationInstanceId: string;
  readonly proposalId: string;
}

/** Decode the server's HTTP 202 OperationHandle, not a publication request. */
export function readStudioApprovalPending(value: unknown): StudioApprovalPending | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const operation = value as Record<string, unknown>;
  // OperationHandleStatus.RequiresApproval is 4 in the canonical server enum.
  // Named serialization is also accepted; other pending states are not approval.
  if (![4, "RequiresApproval", "requiresApproval"].includes(operation.status as string | number)) return undefined;
  if (typeof operation.operationInstanceId !== "string" || !operation.operationInstanceId.trim()) return undefined;
  if (typeof operation.proposalId !== "string" || !operation.proposalId.trim()) return undefined;
  return {
    status: "awaiting-approval",
    operationInstanceId: operation.operationInstanceId,
    proposalId: operation.proposalId,
    ...(typeof operation.auditId === "string" ? { auditId: operation.auditId } : {}),
    ...(typeof operation.correlationId === "string" ? { correlationId: operation.correlationId } : {}),
    ...(typeof operation.proposalUri === "string" ? { proposalUri: operation.proposalUri } : {}),
  };
}
