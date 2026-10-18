import { describe, expect, it, vi } from "vitest";
import { LocalProcessWorkspace, type LocalRunReceipt } from "../../src/gp/custom-process-workspace.js";
const options = { csrfToken: "csrf", environmentId: "env-a" };
describe("custom-code workspace adapter", () => {
  it("uses optimistic file hashes and separate immutable run endpoints", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ path: "process/tool.py", sha256: "next" })),
    ) as unknown as typeof fetch;
    const client = new LocalProcessWorkspace({ ...options, fetchImpl });
    await client.save({ path: "process/tool.py", sha256: "before", content: "broken" }, "corrected");
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe("/api/processes/local/sources/process/tool.py");
    expect(new Headers(init?.headers).get("If-Match")).toBe("before");
    expect(new Headers(init?.headers).get("X-Honua-Environment")).toBe("env-a");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.body).toBe(JSON.stringify({ content: "corrected" }));
  });
  it("does not advertise failed-run files as imported datasets", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = new LocalProcessWorkspace({ ...options, fetchImpl });
    await expect(
      client.importArtifact({ runId: "run", snapshotDigest: "hash", status: "failed" }, "points.geojson", "points"),
    ).rejects.toThrow("successful");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("verifies file bytes, imports a dataset and publishes returned physical identity", async () => {
    const bytes = new TextEncoder().encode('{"type":"FeatureCollection","features":[]}');
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const receipt: LocalRunReceipt = {
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
    const client = new LocalProcessWorkspace({ ...options, fetchImpl });
    const dataset = await client.importArtifact(receipt, receipt.artifacts![0]!.path, "points");
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
