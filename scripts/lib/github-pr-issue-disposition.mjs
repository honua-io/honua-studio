import process from "node:process";

import { automationExemption, parsePullRequestDisposition } from "./pr-issue-disposition.mjs";

const GITHUB_GRAPHQL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequest(number: $number) {
      number
      body
      title
      state
      updatedAt
      headRefName
      headRefOid
      baseRefName
      baseRefOid
      headRepository { nameWithOwner }
      baseRepository { nameWithOwner }
      author { __typename login }
      closingIssuesReferences(first: 100) {
        nodes { number repository { nameWithOwner } }
        pageInfo { hasNextPage }
      }
    }
  }
}`;

const GITHUB_GRAPHQL_ISSUE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue { number state }
      ... on PullRequest { number state }
    }
  }
}`;

function normalizedRepository(value) {
  return String(value ?? "").toLowerCase();
}

function snapshotKey(input) {
  return JSON.stringify({
    body: input.body,
    title: input.title,
    state: input.state,
    updatedAt: input.updatedAt,
    headRefName: input.headRefName,
    headSha: input.headSha,
    baseRefName: input.baseRefName,
    baseSha: input.baseSha,
    headRepository: input.headRepository,
    baseRepository: input.baseRepository,
    authorLogin: input.authorLogin,
    authorType: input.authorType,
    closingIssueNumbers: input.closingIssueNumbers,
  });
}

function parseGraphqlSnapshot(payload, input) {
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error("GitHub GraphQL returned an error while reading current pull-request metadata.");
  }

  const repository = payload?.data?.repository;
  const pullRequest = repository?.pullRequest;
  if (
    normalizedRepository(repository?.nameWithOwner) !== normalizedRepository(input.repository) ||
    pullRequest?.number !== input.pullRequestNumber
  ) {
    throw new Error(`GitHub did not return ${input.repository}#${input.pullRequestNumber}.`);
  }
  if (pullRequest.state !== "OPEN") {
    throw new Error(`Pull request #${input.pullRequestNumber} is ${String(pullRequest.state).toLowerCase()}.`);
  }
  if (normalizedRepository(pullRequest.baseRepository?.nameWithOwner) !== normalizedRepository(input.repository)) {
    throw new Error(`Pull request #${input.pullRequestNumber} returned unexpected base-repository metadata.`);
  }

  const closing = pullRequest.closingIssuesReferences;
  if (!Array.isArray(closing?.nodes) || closing.pageInfo?.hasNextPage !== false) {
    throw new Error("GitHub closingIssuesReferences metadata is missing or exceeds the 100-item bound.");
  }

  const closingIssueNumbers = [];
  for (const issue of closing.nodes) {
    if (normalizedRepository(issue?.repository?.nameWithOwner) !== normalizedRepository(input.repository)) {
      throw new Error(`GitHub parsed a cross-repository closing reference to ${issue?.repository?.nameWithOwner}.`);
    }
    closingIssueNumbers.push(issue.number);
  }

  return {
    ...input,
    body: pullRequest.body ?? "",
    title: pullRequest.title ?? "",
    state: pullRequest.state,
    updatedAt: pullRequest.updatedAt,
    headRefName: pullRequest.headRefName ?? "",
    headSha: pullRequest.headRefOid ?? "",
    baseRefName: pullRequest.baseRefName ?? "",
    baseSha: pullRequest.baseRefOid ?? "",
    headRepository: pullRequest.headRepository?.nameWithOwner ?? "",
    baseRepository: pullRequest.baseRepository?.nameWithOwner ?? "",
    authorLogin: pullRequest.author?.login ?? "",
    authorType: pullRequest.author?.__typename ?? "",
    closingIssueNumbers,
  };
}

/** Make an authenticated GitHub JSON request with a bounded timeout. */
export async function githubRequest(url, options = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required when --metadata is not supplied.");
  const response = await fetch(url, {
    ...options,
    redirect: "follow",
    signal: options.signal ?? AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "honua-pr-issue-disposition",
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API request failed with HTTP ${response.status} for ${new URL(url).pathname}.`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function queryPullRequest(input, request) {
  const [owner, name] = input.repository.split("/");
  const apiRoot = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const graphqlUrl = process.env.GITHUB_GRAPHQL_URL ?? `${apiRoot}/graphql`;
  const payload = await request(graphqlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: GITHUB_GRAPHQL_QUERY,
      variables: { owner, name, number: input.pullRequestNumber },
    }),
  });
  return parseGraphqlSnapshot(payload, input);
}

async function loadIssue(input, issueNumber, request) {
  const [owner, name] = input.repository.split("/");
  const apiRoot = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const graphqlUrl = process.env.GITHUB_GRAPHQL_URL ?? `${apiRoot}/graphql`;
  const payload = await request(graphqlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: GITHUB_GRAPHQL_ISSUE_QUERY,
      variables: { owner, name, number: issueNumber },
    }),
  });
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error(`GitHub GraphQL returned an error while reading issue #${issueNumber}.`);
  }
  const repository = payload?.data?.repository;
  const issue = repository?.issueOrPullRequest;
  if (normalizedRepository(repository?.nameWithOwner) !== normalizedRepository(input.repository)) {
    throw new Error(`Issue #${issueNumber} returned unexpected repository metadata.`);
  }
  if (issue?.number !== issueNumber || !["Issue", "PullRequest"].includes(issue?.__typename)) {
    throw new Error(`GitHub did not return issue or pull request #${issueNumber}.`);
  }
  return {
    number: issue.number,
    repository: repository.nameWithOwner,
    state: String(issue?.state ?? "").toLowerCase(),
    isPullRequest: issue.__typename === "PullRequest",
  };
}

/**
 * Load and stabilize the current PR snapshot instead of trusting a queued event
 * body. The final query fails a stale or reordered workflow run closed.
 */
export async function loadCurrentPullRequestDisposition(input, request = githubRequest) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input?.repository) ||
    !Number.isSafeInteger(input?.pullRequestNumber) ||
    input.pullRequestNumber <= 0
  ) {
    throw new Error("A valid repository and pull-request number are required.");
  }
  const initial = await queryPullRequest(input, request);
  const exemption = automationExemption(initial);
  const dispositions = exemption ? [] : parsePullRequestDisposition(initial.body);
  const issueNumbers = [...new Set(dispositions.map(({ issueNumber }) => issueNumber))];
  const issues = await Promise.all(issueNumbers.map((issueNumber) => loadIssue(initial, issueNumber, request)));
  const current = await queryPullRequest(input, request);

  if (snapshotKey(initial) !== snapshotKey(current)) {
    throw new Error("Pull-request metadata changed during validation; a current workflow run is required.");
  }
  return { ...current, issues };
}
