/**
 * Type declaration for github-pr-issue-disposition.mjs, consulted only by
 * `tsc --noEmit` (test/scripts/pr-issue-disposition.test.ts imports the real
 * .mjs at runtime via vitest/vite-node; TypeScript without `allowJs` needs a
 * declaration file to type-check that import).
 */
import type { DispositionIssue } from "./pr-issue-disposition.mjs";

export type GithubRequest = (url: string, options?: Record<string, unknown>) => Promise<unknown>;

export interface PullRequestSnapshot {
  repository: string;
  pullRequestNumber: number;
  body: string;
  title: string;
  state: string;
  updatedAt: string;
  headRefName: string;
  headSha: string;
  baseRefName: string;
  baseSha: string;
  headRepository: string;
  baseRepository: string;
  authorLogin: string;
  authorType: string;
  closingIssueNumbers: number[];
  issues: Required<DispositionIssue>[];
}

export declare function githubRequest(url: string, options?: Record<string, unknown>): Promise<unknown>;

export declare function loadCurrentPullRequestDisposition(
  input: { repository: string; pullRequestNumber: number },
  request?: GithubRequest,
): Promise<PullRequestSnapshot>;
