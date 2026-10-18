import { describe, expect, it, vi } from "vitest";
import {
  type ProcessGraph,
  ServerProcessWorkspace,
  snapshotProcessGraph,
  validateProcessGraph,
} from "../../src/gp/process-workspace.js";
const registry = {
  registryVersion: "v1",
  nodes: [
    {
      nodeTypeId: "process:geometry.buffer",
      providerId: "geoprocessing.process-catalog",
      title: "Buffer",
      parameterSchemas: [],
    },
  ],
};
const graph: ProcessGraph = {
  schemaVersion: "workflow-package.v1",
  nodes: [
    {
      nodeId: "source-a",
      nodeTypeId: "process:geometry.buffer",
      parameters: { distance: "10" },
      metadata: { sourceId: "catalog-layer-1" },
    },
    { nodeId: "sink-b", nodeTypeId: "process:geometry.buffer", parameters: {} },
  ],
  edges: [
    { sourceNodeId: "source-a", targetNodeId: "sink-b", kind: "Data", sourcePort: "FeatureLayer", targetPort: "input" },
  ],
};
describe("Processes server adapter", () => {
  it("retains identity in an immutable snapshot independently of later editing", () => {
    const editable = structuredClone(graph);
    const snapshot = snapshotProcessGraph(editable);
    (editable.nodes[0]!.parameters as Record<string, string>).distance = "99";
    expect(snapshot.nodes[0]!.parameters.distance).toBe("10");
    expect(snapshot.nodes[0]!.metadata!.sourceId).toBe("catalog-layer-1");
    expect(Object.isFrozen(snapshot.nodes[0]!.parameters)).toBe(true);
  });
  it("refuses custom, dangling, duplicate and cyclic graph structures before execution", () => {
    expect(validateProcessGraph(graph, registry)).toEqual([]);
    expect(
      validateProcessGraph(
        { ...graph, nodes: [{ nodeId: "python", nodeTypeId: "custom:python", parameters: {} }] },
        registry,
      ).map((item) => item.code),
    ).toContain("BUILTIN_ONLY");
    expect(
      validateProcessGraph(
        { ...graph, edges: [...graph.edges, { sourceNodeId: "sink-b", targetNodeId: "source-a", kind: "Control" }] },
        registry,
      ).map((item) => item.code),
    ).toContain("CYCLE");
  });
  it("retains command identity before sending and reconciles after client restart", async () => {
    const entries = new Map<string, string>();
    const storage = {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
    };
    const first = new ServerProcessWorkspace({ environmentId: "env", csrfToken: "csrf", commandStorage: storage });
    const command = first.reserveCommand("pkg", 1);
    expect(command.reconcileOnly).toBe(false);
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ success: true, data: { items: [] } })),
    ) as unknown as typeof fetch;
    const reopened = new ServerProcessWorkspace({
      environmentId: "env",
      csrfToken: "csrf",
      commandStorage: storage,
      fetchImpl,
    });
    expect(reopened.reserveCommand("pkg", 1)).toEqual({ ...command, reconcileOnly: true });
    await expect(reopened.run("pkg", 1, command.commandId, true)).rejects.toThrow("acceptance is unknown");
    expect(vi.mocked(fetchImpl).mock.calls.map(([, init]) => init?.method)).toEqual(["GET"]);
  });
  it("delegates snapshots, compilation, run and cancellation to actual server routes", async () => {
    const bodies: unknown[] = [];
    const responses = [
      registry,
      { packageId: "pkg" },
      { version: 2 },
      { isValid: true },
      { publicationId: "pub" },
      { workflowRunId: "wf-1", packageId: "pkg", packageVersion: 2, publicationId: "pub" },
      { status: "Cancelled" },
    ];
    const fetchImpl = vi.fn(async (_url, init) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
      return new Response(JSON.stringify({ success: true, data: responses.shift() }));
    }) as unknown as typeof fetch;
    const client = new ServerProcessWorkspace({ environmentId: "env-a", csrfToken: "csrf", fetchImpl });
    const prepared = await client.prepare("Buffer graph", graph);
    expect(prepared.version).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(bodies[1]).toEqual({ name: "Buffer graph", graph });
    const run = await client.run(prepared.packageId, prepared.version, "command-1");
    await client.cancel(run);
    expect(vi.mocked(fetchImpl).mock.calls.map(([path]) => path)).toEqual([
      "/api/processes/console/workflow-node-registry",
      "/api/processes/console/workflow-packages",
      "/api/processes/console/workflow-packages/pkg/versions",
      "/api/processes/console/workflow-packages/pkg/versions/2/validate",
      "/api/processes/console/workflow-packages/pkg/versions/2/publish",
      "/api/processes/console/workflow-publications/wfp-command-1/runs",
      "/api/processes/admin/operations/wf-1/cancel",
    ]);
    expect(bodies[5]).toEqual({ idempotencyKey: "command-1", reconcileOnly: false });
  });
});
