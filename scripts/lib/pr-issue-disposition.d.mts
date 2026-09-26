/**
 * Type declaration for pr-issue-disposition.mjs, consulted only by
 * `tsc --noEmit` (test/scripts/pr-issue-disposition.test.ts imports the real
 * .mjs at runtime via vitest/vite-node; TypeScript without `allowJs` needs a
 * declaration file to type-check that import).
 */

export declare const DEPENDABOT_EXEMPTION: string;

/** Every `code` the validator can fail with; the messages name the violation. */
export type PullRequestDispositionCode =
  | "ambiguous-closing-keyword"
  | "closed-issue-target"
  | "cross-repository-issue"
  | "duplicate-disposition"
  | "github-closing-mismatch"
  | "invalid-closing-metadata"
  | "invalid-issue-metadata"
  | "invalid-reference-explanation"
  | "invalid-repository"
  | "misplaced-reference"
  | "missing-body"
  | "missing-footer"
  | "missing-issue-metadata"
  | "missing-referenced-issue"
  | "nested-reference"
  | "pull-request-target"
  | "reference-would-close"
  | "too-many-dispositions";

export declare class PullRequestDispositionError extends Error {
  constructor(code: PullRequestDispositionCode, message: string);
  readonly code: PullRequestDispositionCode;
}

export interface PullRequestDisposition {
  mode: "closes" | "refs";
  issueNumber: number;
  explanation?: string;
}

export interface DispositionIssue {
  number: number;
  repository?: string;
  state?: string;
  isPullRequest?: boolean;
}

export interface AutomationExemptionInput {
  authorLogin?: string;
  authorType?: string;
  headRefName?: string;
}

export interface DispositionValidationInput extends AutomationExemptionInput {
  repository?: string;
  body?: unknown;
  title?: string;
  issues?: unknown;
  closingIssueNumbers?: unknown;
}

export interface DispositionValidationResult {
  status: "valid" | "exempt";
  exemption: string | null;
  closes: number[];
  refs: number[];
}

export declare function automationExemption(input: AutomationExemptionInput): string | null;

export declare function parsePullRequestDisposition(body: unknown): PullRequestDisposition[];

export declare function validatePullRequestDisposition(input: DispositionValidationInput): DispositionValidationResult;
