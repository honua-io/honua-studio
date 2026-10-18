import { expect, it, vi } from "vitest";
import type { WorkspaceLifecycleReader } from "../../src/lifecycle/workspace-reader.js";
import { readSharedStyleMapConsumer } from "../../src/styles/shared-style-consumer.js";
const hash = "a".repeat(64);
const draft = {
  draftId: "draft",
  itemId: "map",
  packageKey: "parcels",
  family: "map",
  generation: 7,
  envelope: { family: "map", body: { layers: [] } },
};
const version = {
  itemId: "map",
  packageKey: "parcels",
  versionId: "version",
  contentHash: hash,
  envelope: draft.envelope,
};
function fixture(changes: Record<string, unknown> = {}) {
  return {
    getDraft: vi.fn(async () => ({ ...draft, ...changes })),
    getVersion: vi.fn(async () => ({ ...version, ...changes })),
  } as unknown as WorkspaceLifecycleReader;
}
it("pins an authorized draft by canonical identity and generation without inventing its SQL hash", async () => {
  const reader = fixture();
  const result = await readSharedStyleMapConsumer(reader, {
    itemId: "map",
    packageKey: "parcels",
    draftId: "draft",
    generation: 7,
    versionId: null,
    contentHash: "SQL hash not exposed by draft DTO",
    publicationState: "draft",
  });
  expect(result.identity).toEqual({
    kind: "draft",
    itemId: "map",
    packageKey: "parcels",
    draftId: "draft",
    generation: 7,
  });
  expect(result.envelope).toEqual(draft.envelope);
  expect(result.envelope).not.toBe(draft.envelope);
  expect(reader.getVersion).not.toHaveBeenCalled();
});
it("uses the actual immutable version hash for a selected saved/published consumer", async () => {
  const result = await readSharedStyleMapConsumer(fixture(), {
    itemId: "map",
    packageKey: "parcels",
    versionId: "version",
    draftId: null,
    generation: null,
    contentHash: hash,
    publicationState: "published",
  });
  expect(result.identity).toEqual({
    kind: "version",
    itemId: "map",
    packageKey: "parcels",
    versionId: "version",
    contentHash: hash,
  });
});
it.each([{ generation: 8 }, { itemId: "other" }, { packageKey: "other" }, { envelope: { family: "app" } }])(
  "refuses a changed map draft readback %j",
  async (changes) => {
    await expect(
      readSharedStyleMapConsumer(fixture(changes), {
        itemId: "map",
        packageKey: "parcels",
        draftId: "draft",
        generation: 7,
        contentHash: hash,
        publicationState: "draft",
      }),
    ).rejects.toThrow("no longer matches");
  },
);
it("refuses an immutable version whose actual hash changed", async () => {
  await expect(
    readSharedStyleMapConsumer(fixture({ contentHash: "b".repeat(64) }), {
      itemId: "map",
      packageKey: "parcels",
      versionId: "version",
      contentHash: hash,
      publicationState: "saved",
    }),
  ).rejects.toThrow("immutable identity");
});
