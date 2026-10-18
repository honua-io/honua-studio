import { describe, expect, it, vi } from "vitest";
import { LocalProcessWorkspace, type LocalRunReceipt } from "../../src/gp/custom-process-workspace.js";
const options = { csrfToken: "csrf", environmentId: "env-a", principalId: "partition-a", workspaceId: () => "ws-1" };
const identity = {
  projectId: "a".repeat(32),
  revision: 1,
  sourceDigest: "b".repeat(64),
  image: `sha256:${"c".repeat(64)}`,
  binding: { ownerActorId: "owner", tenantId: null, environmentId: "target", workspaceId: "ws-1" },
};
const runIdentity = { projectId: identity.projectId, snapshotId: "d".repeat(32), image: identity.image };
describe("custom-code workspace adapter", () => {
  it("uses optimistic file hashes and separate immutable run endpoints", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...identity, files: [] })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            path: "process/tool.py",
            sha256: "f".repeat(64),
            projectId: identity.projectId,
            revision: 2,
            sourceDigest: "e".repeat(64),
          }),
        ),
      ) as typeof fetch;
    const client = new LocalProcessWorkspace({ ...options, fetchImpl });
    await client.project();
    await client.save({ path: "process/tool.py", sha256: "before", content: "broken" }, "corrected");
    const [url, init] = vi.mocked(fetchImpl).mock.calls[1]!;
    expect(url).toBe("/api/processes/local/sources/process/tool.py");
    expect(new Headers(init?.headers).get("If-Match")).toBe("before");
    expect(new Headers(init?.headers).get("X-Honua-Environment")).toBe("env-a");
    expect(new Headers(init?.headers).get("X-Honua-Workspace")).toBe("ws-1");
    for (const [, request] of vi.mocked(fetchImpl).mock.calls) {
      expect(new Headers(request?.headers).get("X-Honua-Session-Partition")).toBe("partition-a");
    }
    expect(init?.credentials).toBe("same-origin");
    expect(init?.body).toBe(
      JSON.stringify({ projectId: identity.projectId, expectedRevision: 1, content: "corrected" }),
    );
  });
  it("reconciles an uncertain submission by durable command before any retry execution", async () => {
    const entries = new Map<string, string>();
    const storage = {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
    };
    const snapshot = { ...runIdentity, snapshotDigest: identity.sourceDigest, revision: 1 };
    const receipt = { ...runIdentity, snapshotDigest: identity.sourceDigest, runId: "e".repeat(32), status: "queued" };
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/project")) return new Response(JSON.stringify({ ...identity, files: [] }));
      if (String(url).endsWith("/snapshots")) return new Response(JSON.stringify(snapshot));
      if (String(url).includes("/commands/")) return new Response(JSON.stringify(receipt));
      if (init?.method === "POST" && String(url).endsWith("/runs")) throw new Error("lost response");
      throw new Error("Unexpected route");
    }) as typeof fetch;
    const first = new LocalProcessWorkspace({ ...options, fetchImpl, commandStorage: storage });
    await first.project();
    await expect(first.run()).rejects.toThrow("lost response");
    const second = new LocalProcessWorkspace({ ...options, fetchImpl, commandStorage: storage });
    await second.project();
    expect((await second.run()).runId).toBe(receipt.runId);
    expect(vi.mocked(fetchImpl).mock.calls.filter(([url]) => String(url).endsWith("/runs"))).toHaveLength(1);
    expect(vi.mocked(fetchImpl).mock.calls.at(-1)?.[0]).toContain("/commands/");
  });
  it("does not advertise failed-run files as imported datasets", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new LocalProcessWorkspace({ ...options, fetchImpl });
    await expect(
      client.importArtifact(
        { ...runIdentity, runId: "run", snapshotDigest: "hash", status: "failed" },
        "points.geojson",
        "points",
      ),
    ).rejects.toThrow("successful");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("verifies file bytes, imports a dataset and publishes returned physical identity", async () => {
    const bytes = new TextEncoder().encode('{"type":"FeatureCollection","features":[]}');
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const receipt: LocalRunReceipt = {
      ...runIdentity,
      runId: "run",
      snapshotDigest: "immutable",
      status: "succeeded",
      artifacts: [{ path: "runs/artifacts/points.geojson", bytes: bytes.length, sha256: digest }],
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(bytes))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            tableName: "points",
            physicalTableName: "imported_points_123",
            schema: "honua_data",
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: { layerId: 47, serviceName: "analysis" } })),
      ) as unknown as typeof fetch;
    const entries = new Map<string, string>();
    const commandStorage = {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
    };
    const client = new LocalProcessWorkspace({ ...options, fetchImpl, commandStorage });
    const imported = await client.importArtifact(receipt, receipt.artifacts![0]!.path, "points");
    expect(imported.status).toBe("completed");
    const dataset = imported.dataset!;
    expect(dataset.physicalTableName).toBe("imported_points_123");
    const layer = await client.publishDataset(dataset, "managed", "analysis", "Output points");
    expect(layer.layerId).toBe(47);
    const calls = vi.mocked(fetchImpl).mock.calls;
    expect(calls[1]![0]).toBe("/api/processes/admin/import/upload");
    expect(calls[1]![1]!.body).toBeInstanceOf(FormData);
    expect(JSON.parse(String(calls[2]![1]!.body))).toMatchObject({
      schema: "honua_data",
      table: "imported_points_123",
    });
  });
});

describe("artifact import acceptance boundaries", () => {
  function storage() {
    const entries = new Map<string, string>();
    return {
      entries,
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
    };
  }
  async function artifact() {
    const bytes = new TextEncoder().encode('{"type":"FeatureCollection","features":[]}');
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return {
      bytes,
      receipt: {
        ...runIdentity,
        runId: "e".repeat(32),
        snapshotDigest: identity.sourceDigest,
        status: "succeeded",
        artifacts: [{ path: "points.geojson", bytes: bytes.length, sha256: hash }],
      } as LocalRunReceipt,
    };
  }
  it("rejects invalid dataset names before downloading or reserving an upload", async () => {
    const saved = storage();
    const { receipt } = await artifact();
    const fetchImpl = vi.fn();
    const client = new LocalProcessWorkspace({ ...options, commandStorage: saved, fetchImpl });
    await expect(client.importArtifact(receipt, "points.geojson", "")).rejects.toThrow("dataset table name");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(saved.entries.size).toBe(0);
  });
  it("never silently retries an upload whose accepted response was lost", async () => {
    const saved = storage();
    const { bytes, receipt } = await artifact();
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("upload response lost");
      return new Response(bytes);
    });
    const first = new LocalProcessWorkspace({ ...options, commandStorage: saved, fetchImpl });
    expect(await first.importArtifact(receipt, "points.geojson", "points")).toMatchObject({
      status: "unknown",
      uploadId: expect.any(String),
    });
    const reopened = new LocalProcessWorkspace({ ...options, commandStorage: saved, fetchImpl });
    expect(await reopened.importArtifact(receipt, "points.geojson", "points")).toMatchObject({
      status: "unknown",
      uploadId: expect.any(String),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const form = fetchImpl.mock.calls[1]?.[1]?.body as FormData;
    expect(form.get("UploadId")).toMatch(/^[a-f0-9-]{36}$/);
    expect([...saved.entries.values()].join("")).not.toContain("csrf");
  });
  it("does not submit after the workspace changes while artifact bytes are downloading", async () => {
    const saved = storage();
    const { bytes, receipt } = await artifact();
    let workspace = "original";
    let release!: (response: Response) => void;
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const client = new LocalProcessWorkspace({
      ...options,
      workspaceId: () => workspace,
      commandStorage: saved,
      fetchImpl,
    });
    const pending = client.importArtifact(receipt, "points.geojson", "points");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    workspace = "other";
    release(new Response(bytes));
    await expect(pending).rejects.toThrow("workspace changed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(saved.entries.size).toBe(0);
  });
  it("does not persist an old workspace upload's job under a newly selected workspace", async () => {
    const saved = storage();
    const { bytes, receipt } = await artifact();
    let workspace = "original";
    let release!: (response: Response) => void;
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(new Response(bytes)),
    );
    const client = new LocalProcessWorkspace({
      ...options,
      workspaceId: () => workspace,
      commandStorage: saved,
      fetchImpl,
    });
    const pending = client.importArtifact(receipt, "points.geojson", "points");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    workspace = "other";
    release(new Response(JSON.stringify({ jobId: "accepted-original" })));
    await expect(pending).rejects.toThrow("workspace changed");
    expect([...saved.entries.keys()].some((key) => key.includes('"other"'))).toBe(false);
    expect([...saved.entries.values()].every((value) => !value.includes("accepted-original"))).toBe(true);
  });
});
