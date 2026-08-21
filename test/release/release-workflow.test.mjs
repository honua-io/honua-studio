import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workflow = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");

describe("release workflow integrity contract", () => {
  it("binds the checked-out tag commit and immutable SDK package before publication", () => {
    expect(workflow).toContain('tag_sha=$(git rev-list -n 1 "refs/tags/$tag")');
    expect(workflow).toContain('[[ "$source_sha" != "$tag_sha" ]]');
    expect(workflow).toContain("npm run release:verify-sdk");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("needs: governance");
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("can_admins_bypass == false");
    expect(workflow).toContain(".total_count == 1");
    expect(workflow).toContain('.branch_policies[0].type == "tag"');
    expect(workflow).toContain('.branch_policies[0].name == "v*"');
  });

  it("does not publish a moving release tag or clobber assets", () => {
    expect(workflow).not.toContain(":2026.1");
    expect(workflow).not.toContain("--clobber");
    expect(workflow).toContain("Occupied container coordinate");
    expect(workflow).toContain("Occupied release asset");
    expect(workflow).toContain("sha256sum honua-studio-static.tgz");
    expect(workflow).toContain('existing_fingerprint" != "$expected_fingerprint');
    expect(workflow).toContain("honua-studio-release.json.sha256");
    expect(workflow).toContain('missing_assets+=("$asset")');
  });
});
