import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// A missing repository installation must not fail the trunk workflow.
// The bot token is preferred; GITHUB_TOKEN is the existing degraded path.

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const workflow = readFileSync(resolve(repoRoot, ".github/workflows/release-please.yml"), "utf8");

function step(name) {
  const chunk = workflow.split(`- name: ${name}`)[1];
  assert.ok(chunk, `missing step ${name}`);
  return chunk.split("\n      - name:")[0];
}

test("a failed bot token mint still opens the release pull request", () => {
  const mint = step("Mint the release pull request token");
  assert.match(mint, /continue-on-error:\s*true/u);
  assert.match(mint, /id:\s*app-token/u);

  const warning = step("Warn when the bot app cannot open the pull request");
  assert.match(warning, /steps\.app-token\.outcome == 'failure'/u);
  assert.match(warning, /GITHUB_TOKEN opens the release pull request/u);

  const open = step("Open or update the release pull request");
  assert.match(open, /token:\s*\$\{\{\s*steps\.app-token\.outputs\.token \|\| secrets\.GITHUB_TOKEN\s*\}\}/u);
});
