import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workflow = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
const ciWorkflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");

describe("release workflow integrity contract", () => {
  it("binds the checked-out tag commit and immutable SDK package before publication", () => {
    expect(workflow).toContain('tag_sha=$(git rev-list -n 1 "refs/tags/$tag")');
    expect(workflow).toContain('[[ "$source_sha" != "$tag_sha" ]]');
    expect(workflow).toContain('[[ "$GITHUB_EVENT_NAME" == "push" && "$source_sha" != "$GITHUB_SHA" ]]');
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

  it("carries the commit epoch through BuildKit and proves a clean occupied-coordinate retry", () => {
    expect(workflow).toContain("SOURCE_DATE_EPOCH: ${{ steps.release.outputs.source_epoch }}");
    expect(workflow).toContain('--build-arg "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH"');
    expect(workflow).toContain("--provenance=false");
    expect(workflow).toContain('for built_image in "$candidate_image" "$retry_image"');
    expect(workflow).toContain("Clean release retry changed the occupied-coordinate fingerprint");
    expect(dockerfile).toMatch(/^ARG SOURCE_DATE_EPOCH/m);
    expect(dockerfile).toContain('RUN SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" npm run build');
    expect(dockerfile).toContain("RUN --mount=from=build,source=/app/dist,target=/tmp/studio-dist,ro");
    expect(dockerfile).toContain("find /tmp/studio-dist -type f -print | LC_ALL=C sort");
    expect(dockerfile).toContain("/etc /etc/nginx/conf.d /etc/nginx/conf.d/default.conf \\");
    expect(ciWorkflow.match(/docker build --no-cache --provenance=false/g) ?? []).toHaveLength(1);
    expect(ciWorkflow).toContain("for image in honua-studio-ci honua-studio-ci-retry");
    expect(ciWorkflow).toContain("Clean container rebuild changed the occupied-coordinate fingerprint");
    expect(ciWorkflow).toContain("{{json .RootFS.Layers}} {{json .Config}}");
  });
});
