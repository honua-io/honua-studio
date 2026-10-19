import type { StudioPublicationIdentifiers } from "@honua/sdk-js/studio";

/** A durable operation awaiting a separate approval; no content pointer has moved. */
export interface StudioApprovalPending extends StudioPublicationIdentifiers {
  readonly status: "awaiting-approval";
  readonly operationInstanceId: string;
  readonly proposalId: string;
  readonly requestId?: string;
  readonly itemId?: string;
  readonly versionId?: string;
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
  const resources = operation.resourceIds;
  const identities: { requestId?: string; itemId?: string; versionId?: string } = {};
  if (resources && typeof resources === "object" && !Array.isArray(resources)) {
    for (const key of ["requestId", "itemId", "versionId"] as const) {
      const id = (resources as Record<string, unknown>)[key];
      if (typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id)) identities[key] = id;
    }
  }
  return {
    status: "awaiting-approval",
    operationInstanceId: operation.operationInstanceId,
    proposalId: operation.proposalId,
    ...identities,
    ...(typeof operation.auditId === "string" ? { auditId: operation.auditId } : {}),
    ...(typeof operation.correlationId === "string" ? { correlationId: operation.correlationId } : {}),
    ...(typeof operation.proposalUri === "string" ? { proposalUri: operation.proposalUri } : {}),
  };
}
