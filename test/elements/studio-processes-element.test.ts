// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioProcessesElement } from "../../src/elements/studio-processes-element.js";
import type { ProcessGraph, ServerProcessWorkspace } from "../../src/gp/process-workspace.js";
registerAllStudioElements();
afterEach(() => {
  document.body.innerHTML = "";
});
it("preserves dirty graph text across registry/status rerenders and refuses stale task projection", async () => {
  const element = document.createElement("honua-studio-processes") as HonuaStudioProcessesElement;
  const readVersion = vi.fn();
  element.client = {
    registry: async () => ({ registryVersion: "real", nodes: [] }),
    readVersion,
  } as unknown as ServerProcessWorkspace;
  document.body.appendChild(element);
  const editor = element.shadowRoot!.querySelector("textarea")!;
  editor.value = "{ still editing invalid JSON";
  editor.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  element.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="registry"]')!.click();
  await vi.waitFor(() => expect(element.shadowRoot!.querySelector("pre")!.textContent).toContain("real"));
  expect(element.shadowRoot!.querySelector("textarea")!.value).toBe("{ still editing invalid JSON");
  await expect(element.prepareWorkspaceTask()).rejects.toThrow("Save and validate");
  expect(await element.attachWorkspaceTask({ packageId: "pkg", version: 1, contentHash: "a".repeat(64) })).toBe(false);
  expect(readVersion).not.toHaveBeenCalled();
});

it("authors nodes and data ports visually, validates the same graph and preserves immutable task pins", async () => {
  const registry = {
    registryVersion: "v1",
    nodes: [
      {
        nodeTypeId: "process:source",
        providerId: "geoprocessing.process-catalog",
        title: "Read features",
        parameterSchemas: [
          {
            name: "layerId",
            displayName: "Source layer",
            required: true,
            schema: { type: "WholeNumber", format: "layer-id" },
          },
          { name: "where", displayName: "Filter", required: false },
        ],
        inputSchemas: [],
        outputSchemas: [{ name: "features", title: "Features", schema: { type: "Structured" } }],
      },
      {
        nodeTypeId: "process:buffer",
        providerId: "geoprocessing.process-catalog",
        title: "Buffer",
        parameterSchemas: [],
        inputSchemas: [{ name: "features", title: "Features", required: true, schema: { type: "Structured" } }],
        outputSchemas: [],
      },
      { nodeTypeId: "process:custom.python", providerId: "custom", title: "Not a built-in", parameterSchemas: [] },
    ],
  };
  const prepare = vi.fn(async (_name: string, graph: ProcessGraph) => ({
    packageId: "actual",
    version: 7,
    contentHash: "b".repeat(64),
    validation: { isValid: true },
    graph,
  }));
  const run = vi.fn(async () => ({
    workflowRunId: "run",
    publicationId: "pub",
    packageId: "actual",
    packageVersion: 7,
  }));
  const element = document.createElement("honua-studio-processes") as HonuaStudioProcessesElement;
  element.client = {
    registry: async () => registry,
    prepare,
    reserveCommand: () => ({ commandId: "durable", reconcileOnly: false }),
    run,
  } as unknown as ServerProcessWorkspace;
  document.body.appendChild(element);
  const button = (text: string) =>
    [...element.shadowRoot!.querySelectorAll("button")].find((item) => item.textContent === text)!;
  button("Load registry").click();
  await vi.waitFor(() => expect(button("Read features")).toBeDefined());
  expect(button("Not a built-in")).toBeUndefined();
  button("Read features").click();
  const sourceId = element.graph.nodes[0]!.nodeId;
  const fields = element.shadowRoot!.querySelectorAll<HTMLInputElement>(".inspector input");
  fields[0]!.value = "42";
  fields[0]!.dispatchEvent(new Event("input"));
  fields[1]!.value = "population > 0";
  fields[1]!.dispatchEvent(new Event("input"));
  expect(element.graph.nodes[0]!.parameters).toEqual({ layerId: "42", where: "population > 0" });
  button("Buffer").click();
  const targetId = element.graph.nodes[1]!.nodeId;
  button("Connect nodes").click();
  expect(element.graph.edges).toEqual([
    { sourceNodeId: sourceId, targetNodeId: targetId, kind: "Data", sourcePort: "features", targetPort: "features" },
  ]);
  button("Save and validate snapshot").click();
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  await expect(element.prepareWorkspaceTask()).resolves.toEqual({
    packageId: "actual",
    version: 7,
    contentHash: "b".repeat(64),
  });
  expect(prepare.mock.calls[0]![1]).toEqual(element.graph);
  button("Run validated snapshot").click();
  await vi.waitFor(() => expect(run).toHaveBeenCalledWith("actual", 7, "durable", false));
  await vi.waitFor(() => expect(button("Remove node").disabled).toBe(false));
  button("Remove node").click();
  expect(element.graph.nodes).toHaveLength(1);
  expect(element.graph.edges).toEqual([]);
  await expect(element.prepareWorkspaceTask()).rejects.toThrow("Save and validate");
});
