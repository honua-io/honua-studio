const TRUSTED_REVIEWERS = new Set(["claude[bot]", "claude", "github-actions[bot]"]);

/** Pure admission policy. Review text is evidence, never executable input. */
export function evaluateSecondReview({
  pr,
  comments,
  repository,
  eventName,
  postMergeAudit = false,
  expectedHead = "",
  firstPassReviewer = "chatgpt-codex-connector",
}) {
  const headSha = pr.headRefOid;
  const mode = postMergeAudit ? "post-merge-audit" : "second-review";
  const marker = `<!-- claude-${mode}: ${headSha} -->`;
  const threads = pr.reviewThreads.nodes;
  const firstPass = (login) => (login ?? "").toLowerCase().includes(firstPassReviewer.toLowerCase());
  const firstThreads = threads.filter((thread) => firstPass(thread.comments.nodes[0]?.author?.login));
  const checks = {
    lifecycle: postMergeAudit ? pr.state === "MERGED" && Boolean(pr.mergedAt) : pr.state === "OPEN",
    manual_audit: !postMergeAudit || eventName === "workflow_dispatch",
    exact_head: /^[a-f0-9]{40}$/.test(headSha) && (!postMergeAudit || expectedHead === headSha),
    head_in_repo: pr.headRepository?.nameWithOwner === repository,
    not_draft: !pr.isDraft,
    pages_complete: pr.reviews.totalCount <= 100 && pr.reviewThreads.totalCount <= 100,
    first_pass_done: pr.reviews.nodes.some((review) => firstPass(review.author?.login)) || firstThreads.length > 0,
    threads_resolved: firstThreads.every((thread) => thread.isResolved),
    not_already_reviewed: !comments.some(
      (comment) => TRUSTED_REVIEWERS.has(comment.user?.login) && comment.body?.includes(marker),
    ),
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
