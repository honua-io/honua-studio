import { expect, it, vi } from "vitest";
import { createWorkspaceLifecycleReader } from "../../src/lifecycle/workspace-reader.js";

it("projects actual lifecycle GET readback through the host's captured transport without exposing writes", async () => {
  const draft = { draftId: "draft", itemId: "map", packageKey: "parcels", generation: 7, envelope: { family: "map" } };
  const version = { itemId: "map", versionId: "version", contentHash: "a".repeat(64), envelope: { family: "map" } };
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: draft })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: version }))) as typeof fetch;
  const reader = createWorkspaceLifecycleReader({ fetchImpl });
  expect(await reader.getDraft("draft")).toEqual(draft);
  expect(await reader.getVersion("map", "version")).toEqual(version);
  expect(vi.mocked(fetchImpl).mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
    ["/api/studio/v1/studio/package-drafts/draft", "GET"],
    ["/api/studio/v1/studio/content-items/map/versions/version", "GET"],
  ]);
  expect(Object.isFrozen(reader)).toBe(true);
  expect(Object.keys(reader).sort()).toEqual(["getDraft", "getVersion"]);
});
