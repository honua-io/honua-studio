import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  SELF_HOSTED_PREVIEW_RECEIPT_SCHEMA,
  buildSelfHostedPreviewReceipt,
} from "../../scripts/lib/self-hosted-preview-receipt.mjs";

const journey = {
  draftId: "draft-1",
  savedVersionId: "version-1",
  contentHash: "abc",
  reopenedDraftId: "draft-2",
  proposalId: "proposal-1",
  approvedUrl: "http://127.0.0.1/published/proposal-1",
  proposerSubject: "studio-dev-user",
  approverSubject: "studio-approver",
  toolNames: [
    "honua_studio_add_layer",
    "honua_studio_set_view",
    "honua_studio_save_version",
    "honua_studio_reopen_version",
    "honua_studio_propose_publication",
  ],
};

const input = {
  posture: "preview" as const,
  ga: false as const,
  sourceSha: "abc123",
  sdk: { name: "@honua/sdk-js", version: "0.1.9-beta.0" },
  image: { repository: "ghcr.io/honua-io/honua-studio", published: false as const, localImageId: "sha256:local" },
  runtimeConfig: { schemaVersion: "honua.studio.runtime-config.v1" as const, modelMode: "server-proxy" as const },
  model: { provider: "byom-preview" as const, hosted: false as const, credentialRequired: false as const },
  journey,
};

describe("self-hosted preview receipt", () => {
  it("records a Preview journey and refuses a GA or published-image claim", () => {
    const receipt = buildSelfHostedPreviewReceipt(input);
    expect(receipt.schemaVersion).toBe(SELF_HOSTED_PREVIEW_RECEIPT_SCHEMA);
    expect(receipt.posture).toBe("preview");
    expect(receipt.ga).toBe(false);
    expect(receipt.image.published).toBe(false);
    expect(receipt.image).not.toHaveProperty("digest");
    expect(() => buildSelfHostedPreviewReceipt({ ...input, posture: "ga", ga: true })).toThrow(/Preview, not GA/);
    expect(() =>
      buildSelfHostedPreviewReceipt({
        ...input,
        image: { ...input.image, published: true, digest: "sha256:invented" },
      }),
    ).toThrow(/registry digest/);
    expect(() =>
      buildSelfHostedPreviewReceipt({
        ...input,
        journey: { ...journey, approverSubject: journey.proposerSubject },
      }),
    ).toThrow(/separate principal/);
  });

  it("keeps the tag workflow as the publisher of the static bundle and image", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(workflow).toContain("honua-studio-${VERSION}.tar.gz");
    expect(workflow).toContain("honua-studio-${VERSION}.tar.gz.sha256");
    expect(workflow).toContain("honua-studio-${VERSION}.receipt.json");
    expect(workflow).toContain("gh release upload");
    expect(workflow).not.toMatch(/\bGA\b/);
  });
});
