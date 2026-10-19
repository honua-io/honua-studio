import { matchingReceipt } from "./second-review-delivery.mjs";

/** Only the installed connector's latest summary can attest comment-only completion. */
export function completedFirstPassCommit(comments, firstPassReviewer = "chatgpt-codex-connector") {
  if (firstPassReviewer !== "chatgpt-codex-connector") return undefined;
  const summaries = comments
    .filter(
      (comment) =>
        comment.user?.login === "chatgpt-codex-connector[bot]" &&
        comment.user?.type === "Bot" &&
        comment.performed_via_github_app?.id === 1144995 &&
        comment.performed_via_github_app?.slug === "chatgpt-codex-connector" &&
        Number.isFinite(Date.parse(comment.updated_at)) &&
        comment.body?.startsWith("<!-- codex-pull-request-review-summary -->"),
    )
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  if (summaries.length > 1 && Date.parse(summaries[0].updated_at) === Date.parse(summaries[1].updated_at))
    return undefined;
  const rows = (summaries[0]?.body ?? "")
    .split("\n")
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .filter((cells) => cells.length === 6 && /^(?:📝 )?\*\*Code Review\*\*$/.test(cells[1]));
  if (rows.length !== 1) return undefined;
  const [, , status, commit] = rows[0];
  const completed = /^✅ \*\*Completed\*\* <relative-time datetime="([^"]+)">([^<]+)<\/relative-time>$/.exec(status);
  if (!completed || !Number.isFinite(Date.parse(completed[1])) || completed[1] !== completed[2]) return undefined;
  return /^`([a-f0-9]{7,40})`$/.exec(commit)?.[1];
}

/** Pure admission policy. Review text is evidence, never executable input. */
export function evaluateSecondReview({
  pr,
  comments,
  repository,
  eventName,
  postMergeAudit = false,
  expectedHead = "",
  firstPassReviewer = "chatgpt-codex-connector",
  resolvedFirstPassCommits = {},
}) {
  const headSha = pr.headRefOid;
  const mode = postMergeAudit ? "post-merge-audit" : "second-review";
  const marker = `<!-- claude-${mode}: ${headSha} -->`;
  const threads = pr.reviewThreads.nodes;
  const firstPass = (login) => (login ?? "").toLowerCase().includes(firstPassReviewer.toLowerCase());
  const firstThreads = threads.filter((thread) => firstPass(thread.comments.nodes[0]?.author?.login));
  const recordedFirstPass =
    pr.reviews.nodes.some((review) => firstPass(review.author?.login)) || firstThreads.length > 0;
  const completedCommit = completedFirstPassCommit(comments, firstPassReviewer);
  const completedSummary = Boolean(completedCommit && resolvedFirstPassCommits[completedCommit] === headSha);
  const checks = {
    lifecycle: postMergeAudit ? pr.state === "MERGED" && Boolean(pr.mergedAt) : pr.state === "OPEN",
    manual_audit: !postMergeAudit || eventName === "workflow_dispatch",
    exact_head: /^[a-f0-9]{40}$/.test(headSha) && (!postMergeAudit || expectedHead === headSha),
    head_in_repo: pr.headRepository?.nameWithOwner === repository,
    not_draft: !pr.isDraft,
    pages_complete: pr.reviews.totalCount <= 100 && pr.reviewThreads.totalCount <= 100,
    first_pass_done: recordedFirstPass || completedSummary,
    comment_completion_threads_resolved:
      recordedFirstPass || !completedSummary || threads.every((thread) => thread.isResolved),
    threads_resolved: firstThreads.every((thread) => thread.isResolved),
    not_already_reviewed: !matchingReceipt(comments, { headSha, mode }),
  };
  const resolvedThreads = firstThreads
    .filter((thread) => thread.isResolved)
    .map(
      (thread) =>
        `### Resolved thread — ${thread.path ?? "(no file)"}${thread.line ? `:${thread.line}` : ""}${thread.isOutdated ? " (outdated)" : ""}\n\n${thread.comments.nodes.map((comment) => `**${comment.author?.login ?? "unknown"}**:\n\n${comment.body}`).join("\n\n---\n\n")}`,
    )
    .join("\n\n");
  return {
    headSha,
    mode,
    marker,
    shouldReview: Object.values(checks).every(Boolean),
    checks,
    firstPassThreads: firstThreads.length,
    unresolvedOther: threads.filter((thread) => !thread.isResolved && !firstThreads.includes(thread)).length,
    resolvedThreads: resolvedThreads || "(No resolved review threads on this pull request.)",
  };
}
