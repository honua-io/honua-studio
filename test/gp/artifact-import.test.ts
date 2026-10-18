import { describe, expect, it, vi } from "vitest";
import { ArtifactImportTracker } from "../../src/gp/artifact-import.js";
const source = {
  projectId: "a".repeat(32),
  snapshotDigest: "b".repeat(64),
  runId: "c".repeat(32),
  path: "output.geojson",
  sha256: "d".repeat(64),
  bytes: 471,
  tableName: "requested",
};
function memory() {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}
function tracker(
  fetch: (path: string, init?: RequestInit) => Promise<Response>,
  storage = memory(),
  scope = () => "owner/environment/workspace",
) {
  return new ArtifactImportTracker({ fetch, storage, scope });
}
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
describe("durable artifact import jobs", () => {
  it("resumes a saved job after reopening and attaches only its committed physical identity", async () => {
    const storage = memory();
    tracker(vi.fn(), storage).start("job-1", source);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({ jobId: "job-1", status: "Processing", physicalTableName: "premature", schema: "wrong" }),
      )
      .mockResolvedValueOnce(
        response({
          jobId: "job-1",
          status: "Completed",
          tableName: "canonical",
          physicalTableName: "physical_42",
          schema: "honua_data",
        }),
      );
    const reopened = tracker(fetch, storage);
    expect(await reopened.resume()).toEqual({ status: "pending", jobId: "job-1", message: "Import processing." });
    expect(await reopened.resume()).toMatchObject({
      status: "completed",
      dataset: { tableName: "canonical", physicalTableName: "physical_42", schema: "honua_data" },
    });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(["admin/import/jobs/job-1", "admin/import/jobs/job-1"]);
  });
  it.each(["Failed", "Cancelled", "Completed"])(
    "does not fabricate a dataset for %s without committed result fields",
    async (status) => {
      const instance = tracker(vi.fn().mockResolvedValue(response({ jobId: "job-1", status, tableName: "requested" })));
      instance.start("job-1", source);
      const observed = await instance.resume();
      expect(observed?.status).toBe(status.toLowerCase());
      expect(observed?.dataset).toBeUndefined();
    },
  );
  it("keeps cancellation pending until the server reports the actual terminal state", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ jobId: "job-1", message: "Cancellation requested" }))
      .mockResolvedValueOnce(response({ jobId: "job-1", status: "Processing" }))
      .mockResolvedValueOnce(response({ jobId: "job-1", status: "Cancelled" }));
    const instance = tracker(fetch);
    instance.start("job-1", source);
    expect(await instance.cancel()).toMatchObject({ status: "pending", cancellationRequested: true });
    expect(fetch.mock.calls[0]?.[0]).toBe("admin/import/jobs/job-1/cancel");
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(await instance.resume()).toMatchObject({ status: "cancelled" });
  });
  it("partitions saved jobs by current authority and rejects workspace changes during polling", async () => {
    const storage = memory();
    let scope = "first";
    let complete!: (value: Response) => void;
    const fetch = vi.fn(
      (_path: string, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const instance = tracker(fetch, storage, () => scope);
    instance.start("job-1", source);
    const pending = instance.resume();
    scope = "second";
    complete(
      response({
        jobId: "job-1",
        status: "Completed",
        tableName: "canonical",
        physicalTableName: "private",
        schema: "honua_data",
      }),
    );
    await expect(pending).rejects.toThrow("workspace changed");
    expect(await instance.resume()).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects a substituted job and retains its original durable reference", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          jobId: "foreign",
          status: "Completed",
          tableName: "foreign",
          physicalTableName: "foreign",
          schema: "private",
        }),
      )
      .mockResolvedValueOnce(response({ jobId: "job-1", status: "Queued" }));
    const instance = tracker(fetch);
    instance.start("job-1", source);
    await expect(instance.resume()).rejects.toThrow("different job identity");
    expect(await instance.resume()).toMatchObject({ jobId: "job-1", status: "pending" });
  });
  it("reconciles a pending import instead of submitting the same artifact again", async () => {
    const fetch = vi.fn(async () => response({ jobId: "job-1", status: "Queued" }));
    const instance = tracker(fetch);
    instance.start("job-1", source);
    expect(await instance.reconcile(source)).toMatchObject({ jobId: "job-1", status: "pending" });
    await expect(instance.reconcile({ ...source, sha256: "e".repeat(64) })).rejects.toThrow("Finish or cancel");
  });
});
it("pins the retained job while a delayed status response is in flight", async () => {
  const storage = memory();
  let release!: (value: Response) => void;
  const fetch = vi.fn(
    (_path: string, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  const first = tracker(fetch, storage);
  first.start("first", source);
  const pending = first.resume();
  tracker(vi.fn(), storage).start("second", { ...source, runId: "e".repeat(32) });
  release(
    response({ jobId: "first", status: "Completed", tableName: "old", physicalTableName: "old", schema: "honua_data" }),
  );
  await expect(pending).rejects.toThrow("saved import job changed");
});
it("never changes cancellation reconciliation to a newer job stored by another tab", async () => {
  const storage = memory();
  let release!: (value: Response) => void;
  const fetch = vi.fn(
    (_path: string, _init?: RequestInit) =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  const first = tracker(fetch, storage);
  first.start("first", source);
  const pending = first.cancel();
  tracker(vi.fn(), storage).start("second", { ...source, runId: "e".repeat(32) });
  release(response({ jobId: "first", message: "Cancellation requested" }));
  await expect(pending).rejects.toThrow("saved import job changed");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]?.[0]).toBe("admin/import/jobs/first/cancel");
});
it("retains an unknown upload acceptance and never treats it as permission to submit again", async () => {
  const storage = memory();
  const fetch = vi.fn();
  const first = tracker(fetch, storage);
  const authority = first.capture();
  first.reserve(source, authority);
  const reopened = tracker(fetch, storage);
  expect(await reopened.reconcile(source)).toMatchObject({ status: "unknown", uploadId: expect.any(String) });
  expect(await reopened.reconcile({ ...source, runId: "other" })).toMatchObject({ status: "unknown" });
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects a reserved upload intent when its original workspace changed", () => {
  const storage = memory();
  let scope = "original";
  const instance = tracker(vi.fn(), storage, () => scope);
  const authority = instance.capture();
  const pending = instance.reserve(source, authority);
  scope = "other";
  expect(() => instance.start("accepted", source, pending)).toThrow("workspace changed");
  expect(storage.getItem("honua.processes.artifact-import:other")).toBeNull();
});
