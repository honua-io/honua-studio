/**
 * Preview conversation projection for a governed publication proposal
 * (honua-studio#26). This module records a proposal handle and turns a
 * status read into the line the chat shows. It cannot approve, publish,
 * or invent a link: a URL is copied only from an `Active` status payload.
 */

export const SHARE_PROPOSAL_STORAGE_KEY = "honua.studio.preview.share-proposal";

export interface ShareProposalHandle {
  readonly proposalId: string;
  readonly proposalUri: string;
  readonly itemId: string;
  readonly versionId: string;
  readonly contentHash: string;
  readonly route: string;
  readonly visibility: string;
  readonly operationInstanceId: string;
  readonly auditId: string;
  readonly correlationId: string;
  readonly idempotencyIdentity: string;
}

export interface ShareProposalStatus {
  readonly proposalId: string;
  readonly status: string;
  readonly publicationUrl?: string;
  readonly reason?: string;
}

export interface ShareProposalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ShareConversationNote {
  readonly text: string;
  /** Present only when the note is the server-issued Active URL. */
  readonly publicationUrl?: string;
}

export interface ShareProposalSubmission {
  readonly itemId: string;
  readonly versionId: string;
  readonly contentHash: string;
  readonly route: string;
  readonly visibility: string;
  readonly proposalId: string;
  readonly proposalUri: string;
  readonly operationInstanceId: string;
  readonly auditId: string;
  readonly correlationId: string;
  readonly idempotencyIdentity: string;
  readonly status: string;
  readonly humanConfirmationRequired: boolean;
}

const REQUIRED_HANDLE_KEYS = [
  "proposalId",
  "proposalUri",
  "itemId",
  "versionId",
  "contentHash",
  "route",
  "visibility",
  "operationInstanceId",
  "auditId",
  "correlationId",
  "idempotencyIdentity",
] as const;

export function sessionShareStorage(): ShareProposalStorage | undefined {
  try {
    if (typeof sessionStorage === "undefined") return undefined;
    return sessionStorage;
  } catch {
    return undefined;
  }
}

export function shareHandleFromSubmission(submission: ShareProposalSubmission): ShareProposalHandle | undefined {
  if (submission.status !== "AwaitingApproval" || submission.humanConfirmationRequired !== true) return undefined;
  if (!submission.proposalUri.startsWith("honua://proposals/")) return undefined;
  const handle: ShareProposalHandle = {
    proposalId: submission.proposalId,
    proposalUri: submission.proposalUri,
    itemId: submission.itemId,
    versionId: submission.versionId,
    contentHash: submission.contentHash,
    route: submission.route,
    visibility: submission.visibility,
    operationInstanceId: submission.operationInstanceId,
    auditId: submission.auditId,
    correlationId: submission.correlationId,
    idempotencyIdentity: submission.idempotencyIdentity,
  };
  return validHandle(handle) ? handle : undefined;
}

export function retainShareProposal(storage: ShareProposalStorage, handle: ShareProposalHandle): void {
  if (!validHandle(handle)) throw new TypeError("Refusing to retain a publication handle that is not a proposal.");
  storage.setItem(SHARE_PROPOSAL_STORAGE_KEY, JSON.stringify(handle));
}

export function loadShareProposal(storage: ShareProposalStorage | undefined): ShareProposalHandle | undefined {
  if (!storage) return undefined;
  const raw = storage.getItem(SHARE_PROPOSAL_STORAGE_KEY);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return validHandle(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The conversation line for one status read. `publicationUrl` is set only
 * for `Active` when the payload itself carries a verified http(s) URL that
 * is not the proposal URI.
 */
export function projectShareConversation(
  handle: ShareProposalHandle,
  status: ShareProposalStatus,
): ShareConversationNote {
  const label = `${handle.visibility} publication ${handle.proposalUri}`;
  if (status.proposalId !== handle.proposalId) {
    return {
      text: `${label} is pending separate human approval. The status read did not match this handle, so no link was issued.`,
    };
  }
  switch (status.status) {
    case "AwaitingApproval":
      return { text: `${label} is pending separate human approval. Nothing has been published.` };
    case "Approved":
      return { text: `${label} is approved and not yet active. No link is available until it is active.` };
    case "Executing":
      return { text: `${label} is executing. No link is available until it is active.` };
    case "Rejected":
      return { text: `${label} was rejected${status.reason ? `: ${status.reason}` : ""}. No link was issued.` };
    case "Failed":
      return { text: `${label} failed${status.reason ? `: ${status.reason}` : ""}. No link was issued.` };
    case "Active": {
      const publicationUrl = verifiedPublicationUrl(status.publicationUrl, handle.proposalUri);
      if (!publicationUrl) {
        return { text: `${label} is active, but the server did not return a verified link.` };
      }
      return { text: `Shared — ${publicationUrl}`, publicationUrl };
    }
    default:
      return { text: `${label} is not in a final state (${status.status}). No link was issued.` };
  }
}

/**
 * Accepts only an absolute http(s) URL that is not the proposal handle.
 * Schemes are allowlisted after parsing. A denylist of `javascript:` or
 * `data:` is incomplete (`vbscript:` and other schemes would still pass).
 */
export function verifiedPublicationUrl(candidate: unknown, proposalUri: string): string | undefined {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate === proposalUri) return undefined;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password) return undefined;
  return candidate;
}

export async function fetchShareProposalStatus(
  baseUrl: string,
  proposalId: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ShareProposalStatus | undefined> {
  if (!baseUrl || !proposalId || !token) return undefined;
  const response = await fetchImpl(
    `${baseUrl.replace(/\/$/, "")}/v1/studio/publication-proposals/${encodeURIComponent(proposalId)}`,
    { headers: { accept: "application/json", authorization: `Bearer ${token}` } },
  );
  if (!response.ok) return undefined;
  const body = (await response.json()) as { data?: unknown };
  const data = body.data;
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  if (typeof record.proposalId !== "string" || typeof record.status !== "string") return undefined;
  const status: ShareProposalStatus = { proposalId: record.proposalId, status: record.status };
  if (typeof record.publicationUrl === "string") return { ...status, publicationUrl: record.publicationUrl };
  if (typeof record.reason === "string") return { ...status, reason: record.reason };
  return status;
}

function validHandle(value: unknown): value is ShareProposalHandle {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (!REQUIRED_HANDLE_KEYS.every((key) => typeof record[key] === "string" && record[key] !== "")) return false;
  return typeof record.proposalUri === "string" && record.proposalUri.startsWith("honua://proposals/");
}
