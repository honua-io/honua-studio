export interface ReviewAuthor {
  readonly login: string;
  readonly __typename?: string;
}
export interface ReviewComment {
  readonly user: ReviewAuthor & { readonly type?: string };
  readonly body: string;
  readonly updated_at?: string;
  readonly performed_via_github_app?: { readonly id: number; readonly slug: string } | null;
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
  readonly baseRefName: string;
  readonly state: string;
  readonly mergedAt: string | null;
  readonly isDraft: boolean;
  readonly headRepository: { readonly nameWithOwner: string } | null;
  readonly reviews: {
    readonly totalCount: number;
    readonly nodes: readonly {
      readonly author: ReviewAuthor;
      readonly state?: string;
      readonly commit?: { readonly oid: string } | null;
    }[];
  };
  readonly reviewThreads: { readonly totalCount: number; readonly nodes: readonly ReviewThread[] };
}
export interface ReviewGateInput {
  readonly pr: ReviewPullRequest;
  readonly comments: readonly ReviewComment[];
  readonly resolvedFirstPassCommits?: Readonly<Record<string, string>>;
  readonly repository: string;
  readonly eventName: string;
  readonly postMergeAudit?: boolean;
  readonly expectedHead?: string;
  readonly firstPassReviewer?: string;
}
export function completedFirstPassCommit(
  comments: readonly ReviewComment[],
  firstPassReviewer?: string,
): string | undefined;
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
