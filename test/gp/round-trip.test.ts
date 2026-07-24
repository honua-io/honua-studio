/**
 * Versioned, re-runnable GP packages (honua-studio#10 REQ-005): a saved `gp`
 * version reopens as a draft and re-executes with new parameters — the
 * SAME open -> save-version -> reopen round trip
 * `test/lifecycle/round-trip.test.ts` proves for map/query/dashboard,
 * extended here with the execution half (submit with the original
 * parameters, reopen, submit again with different parameters).
 */
import { afterEach, describe, expect, it } from "vitest";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import {
  BUFFER_INTERSECT_DESCRIPTION,
  BUFFER_INTERSECT_INPUTS,
  BUFFER_INTERSECT_OUTPUTS,
  BUFFER_INTERSECT_PACKAGE_KEY,
  BUFFER_INTERSECT_PARAMETERS,
  BUFFER_INTERSECT_RERUN_PARAMETERS,
  BUFFER_INTERSECT_TITLE,
} from "../../src/gp/fixtures/index.js";
import type { GpPackageBody } from "../../src/gp/gp-types.js";
import { StudioGpJobClient } from "../../src/gp/job-client.js";
import { StudioLifecycleClient } from "../../src/lifecycle/lifecycle-client.js";

let server: Awaited<ReturnType<typeof startMockServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function clients(): { lifecycle: StudioLifecycleClient; jobs: StudioGpJobClient } {
  const token = mintFixtureAccessToken();
  const auth = { getAccessToken: async () => token };
  return {
    lifecycle: new StudioLifecycleClient({ baseUrl: server?.url, auth }),
    jobs: new StudioGpJobClient({ baseUrl: server?.url, auth }),
  };
}

const FIXTURE_BODY: GpPackageBody = {
  title: BUFFER_INTERSECT_TITLE,
  description: BUFFER_INTERSECT_DESCRIPTION,
  inputs: BUFFER_INTERSECT_INPUTS,
  parameters: BUFFER_INTERSECT_PARAMETERS,
  outputs: BUFFER_INTERSECT_OUTPUTS,
  steps: [],
};

describe("gp round trip: open -> validate -> preview -> submit -> save-version -> reopen -> submit with new parameters (REQ-005)", () => {
  it("preserves the envelope body losslessly, and both submissions succeed with distinct jobs and their own parameters", async () => {
    server = await startMockServer();
    const { lifecycle, jobs } = clients();

    // "Open": a console/agent-authored gp package handed to Studio as a fresh draft.
    const opened = await lifecycle.createDraft({
      packageKey: BUFFER_INTERSECT_PACKAGE_KEY,
      envelope: { family: "gp", schemaVersion: "1.0", body: FIXTURE_BODY },
    });
    expect(opened.envelope.body).toEqual(FIXTURE_BODY);

    // Preview-plan is mandatory before first execution (REQ-002) — this is
    // also this mock's own proxy for "validated" (see job-client.test.ts).
    const preview = await lifecycle.previewPlan(opened.draftId);
    expect(preview.requiresJob).toBe(true);

    // First execution — the package's own authored parameter values.
    const firstJob = await jobs.submit({ draftId: opened.draftId });
    expect(firstJob.status).toBe("accepted");

    // "Save as version": captures the envelope as v1.
    const v1 = await lifecycle.saveAsVersion(opened.draftId);
    expect(v1.envelope.body).toEqual(FIXTURE_BODY);

    // "Reopen": the immutable version becomes a fresh mutable draft with the
    // EXACT SAME body — no client-side re-derivation.
    const reopened = await lifecycle.reopenVersion(opened.itemId, v1.versionId);
    expect(reopened.envelope.body).toEqual(FIXTURE_BODY);
    expect(reopened.baseVersionId).toBe(v1.versionId);
    expect(reopened.generation).toBe(1);
    expect(reopened.draftId).not.toBe(opened.draftId);

    // The reopened draft is a FRESH draft server-side — not-validated again
    // — so it must be preview-planned again before it can be submitted
    // (REQ-002's "mandatory before FIRST execution of a new or edited
    // package" applies to the reopened draft too).
    const reopenedPreview = await lifecycle.previewPlan(reopened.draftId);
    expect(reopenedPreview.requiresJob).toBe(true);

    // REQ-005: re-executes with NEW parameters, no re-authoring.
    const secondJob = await jobs.submit({ draftId: reopened.draftId, parameters: BUFFER_INTERSECT_RERUN_PARAMETERS });
    expect(secondJob.status).toBe("accepted");
    expect(secondJob.parameters).toEqual(BUFFER_INTERSECT_RERUN_PARAMETERS);
    expect(secondJob.jobId).not.toBe(firstJob.jobId);

    // Both jobs independently progress to completion with their own
    // parameter overrides intact.
    await jobs.status(firstJob.jobId); // running
    const firstResult = await jobs.status(firstJob.jobId); // successful
    expect(firstResult.status).toBe("successful");
    expect(firstResult.parameters).toBeUndefined(); // no override on the first run

    await jobs.status(secondJob.jobId); // running
    const secondResult = await jobs.status(secondJob.jobId); // successful
    expect(secondResult.status).toBe("successful");
    expect(secondResult.parameters).toEqual(BUFFER_INTERSECT_RERUN_PARAMETERS);
  });
});
