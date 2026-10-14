export interface ReviewAuthor {
  readonly login: string;
}
export interface ReviewThread {
  readonly isResolved: boolean;
  readonly isOutdated?: boolean;
  readonly path?: string;
  readonly line?: number;
  readonly comments: { readonly nodes: readonly { readonly author: ReviewAuthor; readonly body: string }[] };
}
export interface ReviewPullRequest {
  readonly headRefOid: string;
  readonly state: string;
  readonly mergedAt: string | null;
  readonly isDraft: boolean;
  readonly headRepository: { readonly nameWithOwner: string } | null;
  readonly reviews: { readonly totalCount: number; readonly nodes: readonly { readonly author: ReviewAuthor }[] };
  readonly reviewThreads: { readonly totalCount: number; readonly nodes: readonly ReviewThread[] };
}
export interface ReviewGateInput {
  readonly pr: ReviewPullRequest;
  readonly comments: readonly { readonly user: ReviewAuthor; readonly body: string }[];
  readonly repository: string;
  readonly eventName: string;
  readonly postMergeAudit?: boolean;
  readonly expectedHead?: string;
  readonly firstPassReviewer?: string;
}
export function evaluateSecondReview(input: ReviewGateInput): {
  headSha: string;
  mode: string;
  marker: string;
  shouldReview: boolean;
  checks: Record<string, boolean>;
  firstPassThreads: number;
  unresolvedOther: number;
  resolvedThreads: string;
};
