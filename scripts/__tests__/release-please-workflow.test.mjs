import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// App-authored release PRs must trigger their own required CI.

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/release-please.yml"), "utf8");

function step(name) {
  const chunk = workflow.split(`- name: ${name}`)[1];
  assert.ok(chunk, `missing step ${name}`);
  return chunk.split("\n      - name:")[0];
}

test("release PRs require a repository-scoped App token", () => {
  const mint = step("Mint release automation token");
  assert.match(mint, /id:\s*app-token/u);
  assert.doesNotMatch(mint, /continue-on-error:|\n\s+if:|\n\s+owner:|\n\s+repositories:/u);
  assert.match(mint, /app-id: \$\{\{ secrets\.BOT_APP_ID \}\}/u);
  assert.match(mint, /private-key: \$\{\{ secrets\.BOT_APP_PRIVATE_KEY \}\}/u);
  for (const permission of ["contents", "issues", "pull-requests"]) {
    assert.match(mint, new RegExp(`permission-${permission}: write`, "u"));
  }
  const open = step("Open or update the release pull request");
  assert.match(open, /token: \$\{\{ steps\.app-token\.outputs\.token \}\}/u);
  assert.doesNotMatch(open, /GITHUB_TOKEN/u);
  assert.match(open, /skip-github-release: true/u);
});

test("release publishing retains its single explicit dispatch", () => {
  const cut = step("Cut the release of a merged release pull request");
  assert.match(cut, /token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/u);
  assert.match(cut, /skip-github-pull-request: true/u);
  const publish = step("Package the release from its tag");
  assert.match(publish, /if: steps\.release\.outputs\.release_created == 'true'/u);
  assert.match(publish, /gh workflow run release\.yml/u);
});

test("unit tests run the release workflow pin", () => {
  const ci = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /node --test scripts\/__tests__\/release-please-workflow\.test\.mjs/u);
});
