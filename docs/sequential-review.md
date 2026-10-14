# Sequential review and retrospective audit

Studio follows the sequential first-pass and Claude second-pass policy in
honua-devops#166. Ordinary review requires an open same-repository PR, a completed
first pass, resolved first-pass threads, and no trusted review marker for its
current head. The model has 80 turns within the existing 20-minute job limit.

An explicitly requested retrospective audit is available only through the manual
workflow input `post_merge_audit=true`, alongside `pull_request_number` and an
`expected_head_sha` matching the PR's 40-character head SHA. It requires an actually
merged same-repository PR and the same first-pass/thread checks. Forks, closed
unmerged PRs, automatic audit requests and stale head bindings are refused.

The gate checks out `github.workflow_sha` to keep the helper and the active
workflow version together. On PR events this may be PR-authored code; it is not
an isolation boundary against same-repository workflow authors. Fork events
remain excluded, and manually requested audits validate the head repository
before the credentialed review job. Use the default-main workflow for the
ordinary review of changes to this workflow itself.

A retrospective comment starts with `<!-- claude-post-merge-audit: HEAD -->` and
states that it does not establish historical pre-merge clearance. Ordinary
comments retain `<!-- claude-second-review: HEAD -->`. Only trusted review authors
can deduplicate the matching mode and head; the two markers never substitute for
one another. A failed or absent historical review stays failed or absent.

This workflow change does not repair fleet admission policy and does not alter
branch protection. PR 87 merged at 2026-10-14T09:37:02Z before a completed final-head
second-pass review. Any later audit is additional evidence, not a rewritten merge
history. Do not dispatch its audit until this workflow change is normally merged
and the audit action is explicitly requested.
