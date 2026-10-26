# Pull requests: checks, issue disposition and review

Read this before opening or updating a PR in honua-studio. The fleet rules in `AGENTS.md`
cover base branch, template and the basic footer; this page covers what this repo enforces.

## Checks

CI (`.github/workflows/ci.yml`, PR + push to `main`) runs `typecheck`, `check`, `unit` (`npm test`) and `build`.
`smoke-suite.yml` runs directly on the same events for `container-smoke`, `browser-smoke`, `console-assets-smoke` and `blazor-host-smoke`
(builds the host, then `npx playwright test --grep @blazor`), preserving the existing required check names.
`smoke-suite.yml` also exposes `workflow_call` so `release.yml`
runs the identical smokes — and `needs:` them — before it pushes a versioned image to GHCR; it declares its own
`NODE_VERSION`/`DOTNET_VERSION` because a reusable workflow does not inherit the caller's `env`.
`pr-issue-disposition.yml` runs the `PR Issue Disposition` check on every PR, and `claude-second-review.yml` the
second-pass review once the first pass's threads are resolved.
`live-demo-smoke.yml` runs `test:browser:live` nightly against `demo.honua.io`; `security.yml` runs the org's
reusable Trivy + Scorecard workflows.

All CI jobs plus the `PR Issue Disposition` check must be green. Open PRs non-draft with
`gh pr create`. PRs squash-merge, so the title becomes the commit subject: use a Conventional
Commits title with a scope (`feat(tool-bridge): ...`, `docs(readme): ...`).

## Issue disposition footer

End the body with the issue disposition — `Closes #N` when every acceptance criterion is met, `Refs #N (what remains)` when it genuinely is not. The `PR Issue Disposition` check (`.github/workflows/pr-issue-disposition.yml` → `scripts/check-pr-issue-disposition.mjs`) enforces the grammar and **fails the PR** on any deviation, so get the footer right when you open the PR rather than after a red check. The block must be the final nonblank lines, one disposition per issue, at most 20, no issue twice; a `Refs` explanation is 1–160 trimmed characters with no parentheses and must carry a progress marker (`S<number>`, `slice`, `partial`, `remain`/`remains`/`remaining`, `follow-up`, `blocked`, `handoff`). No `Refs #N` and no closing keyword tied to an issue (`close`/`fix`/`resolve` + `#N`) may appear above the block — write "this PR is not sufficient on its own", never "this does not close #123". The check also resolves every declared issue against `honua-io/honua-studio`, so a syntactically perfect footer still fails when it names a closed issue, a pull request, or an issue in another repository.
Syntax-check a body before pushing instead of guessing at the grammar (this covers the footer
grammar only; the API-resolution rules above are checked in CI):

```bash
node --input-type=module -e '
import { parsePullRequestDisposition } from "./scripts/lib/pr-issue-disposition.mjs";
import { readFileSync } from "node:fs";
console.log(parsePullRequestDisposition(readFileSync("body.md", "utf8")));'
```

In the body, say what changed, what you tested and which acceptance criteria are met. State
honestly what you could not run locally (`npm run test:browser` needs browser system deps this
box may lack) and leave it to CI.

## Review passes

Every PR gets **two review passes, in order**. Codex reviews on open. Completion must identify the current commit; resolved older threads remain review context and do not prove a new revision was reviewed. Fix each finding or refute it with evidence (a test, cited code, an argument that holds against the code as it stands) — never resolve a thread to silence the bot. Once every first-pass thread is resolved, `claude-second-review.yml` runs the second pass over the updated diff *plus* the resolved threads, looking for what the first pass missed, regressions the fixes introduced, and refutations that were not evidence-based. The reviewer reads an isolated pinned snapshot and returns a structured result using read-only tools and a read-only GitHub credential. The reviewed diff uses immutable base/head commit snapshots; the recorded original PR base is retained for post-merge audits. A separate trusted publisher rechecks the head/target-branch/lifecycle, posts the comment tagged `<!-- claude-second-review: <head sha> -->`, and verifies it exists for the same target branch. Ordinary target-tip advances do not invalidate that immutable review; retargeting does. The required check is owned by that publisher in a PR-associated workflow; comment/manual admission reruns that exact-head PR workflow rather than reporting an ineligible event's job check. Action success alone is not a review receipt. Pushing new commits re-arms it. Post-merge audits are explicitly labeled and cannot establish historical pre-merge clearance. Nothing dispatches on thread resolution, so if the second pass has not appeared, re-evaluate the gate with `gh workflow run claude-second-review.yml -f pull_request_number=<N>`.

The retrospective post-merge audit is described in [`sequential-review.md`](sequential-review.md).
