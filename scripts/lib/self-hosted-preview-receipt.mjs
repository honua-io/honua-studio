/**
 * Receipt for one self-hosted Studio 2026.1 preview journey.
 *
 * Posture is Preview, never GA. A local run must not invent a GHCR digest or
 * claim the image was published. The version tag workflow is what publishes
 * the static bundle and the registry image.
 */

export const SELF_HOSTED_PREVIEW_RECEIPT_SCHEMA = "honua.studio.self-hosted-preview-receipt.v1";

const JOURNEY_TOOLS = [
  "honua_studio_add_layer",
  "honua_studio_set_view",
  "honua_studio_save_version",
  "honua_studio_reopen_version",
  "honua_studio_propose_publication",
];

export function buildSelfHostedPreviewReceipt(input) {
  if (!input || typeof input !== "object") throw new Error("Preview receipt input is required.");
  if (input.posture !== "preview" || input.ga !== false) {
    throw new Error("Studio 2026.1 ships as Preview, not GA.");
  }
  if (input.model?.hosted !== false || input.model?.credentialRequired !== false) {
    throw new Error("The 2026.1 preview receipt must not require or claim a hosted model.");
  }
  if (input.model?.provider !== "byom-preview") {
    throw new Error('Preview receipt model.provider must be "byom-preview".');
  }
  if (input.image?.published !== false || typeof input.image?.digest === "string") {
    throw new Error("A local preview receipt must not invent a published registry digest.");
  }
  requireString(input.sourceSha, "sourceSha");
  requireString(input.sdk?.name, "sdk.name");
  requireString(input.sdk?.version, "sdk.version");
  requireString(input.image?.repository, "image.repository");
  requireString(input.image?.localImageId, "image.localImageId");
  if (input.runtimeConfig?.schemaVersion !== "honua.studio.runtime-config.v1") {
    throw new Error("Preview receipt runtime config schema is wrong.");
  }
  if (input.runtimeConfig?.modelMode !== "server-proxy") {
    throw new Error("Preview receipt model mode must be server-proxy.");
  }
  const journey = input.journey ?? {};
  requireString(journey.draftId, "journey.draftId");
  requireString(journey.savedVersionId, "journey.savedVersionId");
  requireString(journey.contentHash, "journey.contentHash");
  requireString(journey.reopenedDraftId, "journey.reopenedDraftId");
  requireString(journey.proposalId, "journey.proposalId");
  requireString(journey.approvedUrl, "journey.approvedUrl");
  requireString(journey.proposerSubject, "journey.proposerSubject");
  requireString(journey.approverSubject, "journey.approverSubject");
  if (journey.proposerSubject === journey.approverSubject) {
    throw new Error("The approver must be a separate principal from the proposer.");
  }
  if (!/^https?:\/\//.test(journey.approvedUrl)) {
    throw new Error("Approved URL must be absolute.");
  }
  if (!Array.isArray(journey.toolNames) || JOURNEY_TOOLS.some((name) => !journey.toolNames.includes(name))) {
    throw new Error(`Preview journey must execute ${JOURNEY_TOOLS.join(", ")}.`);
  }
  if (journey.reopenedDraftId === journey.draftId) {
    throw new Error("Reopen must create a distinct draft from the composed draft.");
  }

  return {
    schemaVersion: SELF_HOSTED_PREVIEW_RECEIPT_SCHEMA,
    posture: "preview",
    ga: false,
    sourceSha: input.sourceSha,
    sdk: { name: input.sdk.name, version: input.sdk.version },
    image: {
      repository: input.image.repository,
      published: false,
      localImageId: input.image.localImageId,
    },
    runtimeConfig: {
      schemaVersion: "honua.studio.runtime-config.v1",
      modelMode: "server-proxy",
    },
    model: {
      provider: "byom-preview",
      kind: "catalog-planner",
      hosted: false,
      credentialRequired: false,
    },
    journey: {
      draftId: journey.draftId,
      savedVersionId: journey.savedVersionId,
      contentHash: journey.contentHash,
      reopenedDraftId: journey.reopenedDraftId,
      proposalId: journey.proposalId,
      approvedUrl: journey.approvedUrl,
      proposerSubject: journey.proposerSubject,
      approverSubject: journey.approverSubject,
      toolNames: [...journey.toolNames],
    },
  };
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Preview receipt ${label} is required.`);
  }
}
