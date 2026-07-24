/**
 * `StudioGpJobClient` against the REAL `mock-server.mjs` GP job store
 * (honua-studio#10 REQ-003): submit -> status polling (accepted -> running
 * -> terminal) -> cancel, plus the honest failure path and the
 * validate-before-submit guard. Mirrors `test/lifecycle/lifecycle-client.test.ts`'s
 * "real fixture, not a re-implementation" approach.
 */
import { afterEach, describe, expect, it } from "vitest";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { GpJobClientError, StudioGpJobClient, isGpJobNotFound } from "../../src/gp/job-client.js";
import { StudioLifecycleClient } from "../../src/lifecycle/lifecycle-client.js";

let server: Awaited<ReturnType<typeof startMockServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function seedValidatedGpDraft(
  lifecycle: StudioLifecycleClient,
  outputs: readonly { id: string; title?: string }[] = [{ id: "result", title: "Result" }],
) {
  const draft = await lifecycle.createDraft({
    packageKey: "gp-job-client-test",
    envelope: {
      family: "gp",
      schemaVersion: "1.0",
      body: { title: "t", inputs: [], parameters: [], outputs, steps: [] },
    },
  });
  await lifecycle.validateDraft(draft.draftId);
  return draft;
}

function client(): { jobs: StudioGpJobClient; lifecycle: StudioLifecycleClient } {
  const token = mintFixtureAccessToken();
  const auth = { getAccessToken: async () => token };
  return {
    jobs: new StudioGpJobClient({ baseUrl: server?.url, auth }),
    lifecycle: new StudioLifecycleClient({ baseUrl: server?.url, auth }),
  };
}

describe("StudioGpJobClient: submit -> status polling -> results (REQ-003)", () => {
  it("progresses accepted -> running -> successful, and registers outputs into the catalog on completion (REQ-004)", async () => {
    server = await startMockServer();
    const { jobs, lifecycle } = client();
    const draft = await seedValidatedGpDraft(lifecycle);

    const accepted = await jobs.submit({ draftId: draft.draftId, parameters: { "buffer-distance-m": 500 } });
    expect(accepted.status).toBe("accepted");
    expect(accepted.jobId).toBeTruthy();
    expect(accepted.parameters).toEqual({ "buffer-distance-m": 500 });

    const running = await jobs.status(accepted.jobId);
    expect(running.status).toBe("running");

    const successful = await jobs.status(accepted.jobId);
    expect(successful.status).toBe("successful");
    expect(successful.result?.outputs).toHaveLength(1);
    const [output] = successful.result?.outputs ?? [];
    expect(output?.outputId).toBe("result");
    expect(output?.datasetId).toContain(accepted.jobId);

    // Idempotent on the successful transition: a third poll returns the SAME
    // registered output, not a duplicate.
    const stillSuccessful = await jobs.status(accepted.jobId);
    expect(stillSuccessful.result?.outputs).toEqual(successful.result?.outputs);

    const catalog = await fetchCatalog();
    expect(catalog.datasets.map((d: { id: string }) => d.id)).toContain(output?.datasetId);
  });

  it("submit rejects a draft that has never been validated or preview-planned", async () => {
    server = await startMockServer();
    const { jobs, lifecycle } = client();
    const draft = await lifecycle.createDraft({
      packageKey: "gp-unvalidated",
      envelope: {
        family: "gp",
        schemaVersion: "1.0",
        body: { title: "t", inputs: [], parameters: [], outputs: [], steps: [] },
      },
    });
    await expect(jobs.submit({ draftId: draft.draftId })).rejects.toThrow(GpJobClientError);
  });

  it("submit rejects a non-gp-family draft", async () => {
    server = await startMockServer();
    const { jobs, lifecycle } = client();
    const draft = await lifecycle.createDraft({
      packageKey: "gp-wrong-family",
      envelope: { family: "map", schemaVersion: "1.0", body: { layers: [], view: {}, widgets: [] } },
    });
    await lifecycle.validateDraft(draft.draftId);
    await expect(jobs.submit({ draftId: draft.draftId })).rejects.toThrow(GpJobClientError);
  });

  it("simulateFailure surfaces an honest, structured error at the second poll", async () => {
    server = await startMockServer();
    const { jobs, lifecycle } = client();
    const draft = await seedValidatedGpDraft(lifecycle);

    const accepted = await jobs.submit({ draftId: draft.draftId, simulateFailure: true });
    await jobs.status(accepted.jobId); // running
    const failed = await jobs.status(accepted.jobId);
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("ProcessExecutionFailed");
    expect(failed.error?.message).toBeTruthy();
    expect(failed.result).toBeUndefined();
  });

  it("status() 404s for an unknown job id", async () => {
    server = await startMockServer();
    const { jobs } = client();
    try {
      await jobs.status("no-such-job");
      throw new Error("expected rejection");
    } catch (error) {
      expect(isGpJobNotFound(error)).toBe(true);
    }
  });
});

describe("StudioGpJobClient: cancel (REQ-003)", () => {
  it("cancel while running transitions to dismissed", async () => {
    server = await startMockServer();
    const { jobs, lifecycle } = client();
    const draft = await seedValidatedGpDraft(lifecycle);
    const accepted = await jobs.submit({ draftId: draft.draftId });

    const cancelled = await jobs.cancel(accepted.jobId);
    expect(cancelled.status).toBe("dismissed");

    // Idempotent: cancelling again (or polling status) still reports dismissed.
    const cancelledAgain = await jobs.cancel(accepted.jobId);
    expect(cancelledAgain.status).toBe("dismissed");
  });

  it("cancel after a job already reached a terminal state is a race-tolerant no-op (REQ-003)", async () => {
    server = await startMockServer();
    const { jobs, lifecycle } = client();
    const draft = await seedValidatedGpDraft(lifecycle);
    const accepted = await jobs.submit({ draftId: draft.draftId });
    await jobs.status(accepted.jobId); // running
    const successful = await jobs.status(accepted.jobId); // successful
    expect(successful.status).toBe("successful");

    const cancelled = await jobs.cancel(accepted.jobId);
    expect(cancelled.status).toBe("successful"); // never overwritten to "dismissed"
    expect(cancelled.result).toEqual(successful.result);
  });
});

async function fetchCatalog(): Promise<{ datasets: readonly { id: string }[] }> {
  // Reads `/v1/studio/catalog` directly (no typed client for it in this app
  // yet) — the point is proving the REAL mock-server catalog store saw the
  // registration, not re-implementing a client for it.
  const response = await fetch(`${server?.url}/v1/studio/catalog`, {
    headers: { authorization: `Bearer ${mintFixtureAccessToken()}` },
  });
  return response.json();
}
