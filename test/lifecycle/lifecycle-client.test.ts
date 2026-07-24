/**
 * `StudioLifecycleClient` against the REAL `mock-server.mjs` REST lifecycle
 * routes (honua-studio#9) — mirrors `test/mcp/mock-mcp-server.test.ts`'s
 * "exercise the actual fixture, not a re-implementation of it" approach.
 * Covers the full endpoint table (`docs/internal/admin-api/studio-package-lifecycle.md`):
 * capability discovery, draft CRUD + validate/preview-plan, save-as-version,
 * version list/get/compare, reopen, publish-requests, rollback-requests, and
 * the enumeration endpoints' cursor pagination + filters. A handful of
 * fetch-mocked unit tests cover the 409/401/problem-detail mapping paths a
 * real server round trip can't easily force on demand.
 */
import { afterEach, describe, expect, it } from "vitest";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { StudioLifecycleClient } from "../../src/lifecycle/lifecycle-client.js";
import {
  StudioLifecycleConflictError,
  StudioLifecycleError,
  StudioLifecycleSessionExpiredError,
  isStudioLifecycleGenerationConflict,
  isStudioLifecycleNotFound,
} from "../../src/lifecycle/lifecycle-errors.js";

let server: Awaited<ReturnType<typeof startMockServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function client(): StudioLifecycleClient {
  const token = mintFixtureAccessToken();
  return new StudioLifecycleClient({
    baseUrl: server?.url,
    auth: { getAccessToken: async () => token },
  });
}

describe("lifecycle/lifecycle-client StudioLifecycleClient against the real mock-server REST routes", () => {
  it("getPackageFamilies returns all 10 families with the documented shape", async () => {
    server = await startMockServer();
    const capabilities = await client().getPackageFamilies();
    expect(capabilities.persistenceMode).toBe("in-memory");
    expect(capabilities.durable).toBe(false);
    expect(capabilities.families.map((f) => f.family)).toEqual([
      "query",
      "analysis",
      "map",
      "dashboard",
      "report",
      "form",
      "app",
      "workflow",
      "gp",
      "etl",
    ]);
    const mapFamily = capabilities.families.find((f) => f.family === "map");
    expect(mapFamily?.supportLevel).toBe("supported");
    const queryFamily = capabilities.families.find((f) => f.family === "query");
    expect(queryFamily?.supportLevel).toBe("limited");
  });

  it("draft create/get/replace round-trips, and generation increments by exactly 1 per replace", async () => {
    server = await startMockServer();
    const c = client();
    const created = await c.createDraft({
      packageKey: "lc-parcels",
      envelope: { family: "map", schemaVersion: "1.0", body: { layers: [], view: {}, widgets: [] } },
    });
    expect(created.generation).toBe(1);
    expect(created.packageKey).toBe("lc-parcels");
    expect(created.family).toBe("map");

    const fetched = await c.getDraft(created.draftId);
    expect(fetched).toEqual(created);

    const replaced = await c.replaceDraft(created.draftId, {
      packageKey: "lc-parcels",
      envelope: { ...created.envelope, body: { layers: [{ id: "roads" }], view: {}, widgets: [] } },
      generation: created.generation,
    });
    expect(replaced.generation).toBe(2);
  });

  it("replaceDraft with a stale generation throws StudioLifecycleConflictError (409)", async () => {
    server = await startMockServer();
    const c = client();
    const created = await c.createDraft({
      packageKey: "lc-stale",
      envelope: { family: "query", schemaVersion: "1.0", body: { where: "1=1" } },
    });
    await c.replaceDraft(created.draftId, { packageKey: "lc-stale", envelope: created.envelope, generation: 1 });

    await expect(
      c.replaceDraft(created.draftId, { packageKey: "lc-stale", envelope: created.envelope, generation: 1 }),
    ).rejects.toSatisfy((error: unknown) => isStudioLifecycleGenerationConflict(error));
  });

  it("getDraft for a missing id throws a not-found StudioLifecycleError (404)", async () => {
    server = await startMockServer();
    await expect(client().getDraft("does-not-exist")).rejects.toSatisfy((error: unknown) =>
      isStudioLifecycleNotFound(error),
    );
  });

  it("deleteDraft removes the draft", async () => {
    server = await startMockServer();
    const c = client();
    const created = await c.createDraft({
      packageKey: "lc-delete",
      envelope: { family: "query", schemaVersion: "1.0", body: { where: "1=1" } },
    });
    await c.deleteDraft(created.draftId);
    await expect(c.getDraft(created.draftId)).rejects.toSatisfy((error: unknown) => isStudioLifecycleNotFound(error));
  });

  it("validateDraft and previewPlan return summaries and persist onto the draft (generation advances)", async () => {
    server = await startMockServer();
    const c = client();
    const created = await c.createDraft({
      packageKey: "lc-validate",
      envelope: { family: "map", schemaVersion: "1.0", body: { layers: [], view: {}, widgets: [] } },
    });
    const validation = await c.validateDraft(created.draftId);
    expect(validation.status).toBe("valid");

    const afterValidate = await c.getDraft(created.draftId);
    expect(afterValidate.generation).toBe(2);

    const plan = await c.previewPlan(created.draftId);
    expect(plan.requiresJob).toBe(false);
    expect(plan.synchronous).toBe(true);
    expect(plan.steps).toEqual(["validate-envelope", "prepare-inline-preview"]);
  });

  it("gp/etl/workflow families advertise a job-backed preview plan", async () => {
    server = await startMockServer();
    const c = client();
    const created = await c.createDraft({
      packageKey: "lc-gp",
      envelope: { family: "gp", schemaVersion: "1.0", body: {} },
    });
    const plan = await c.previewPlan(created.draftId);
    expect(plan.requiresJob).toBe(true);
    expect(plan.synchronous).toBe(false);
    expect(plan.steps).toEqual(["validate-envelope", "plan-background-preview-job"]);
  });

  it("save-as-version, list/get versions, and compareVersions reflect real content-hash differences", async () => {
    server = await startMockServer();
    const c = client();
    const created = await c.createDraft({
      packageKey: "lc-versions",
      envelope: { family: "map", schemaVersion: "1.0", body: { layers: [], view: {}, widgets: [] } },
    });
    const v1 = await c.saveAsVersion(created.draftId, "first save");
    expect(v1.versionNumber).toBe(1);
    expect(v1.changeNote).toBe("first save");

    const draftAfterSave = await c.getDraft(created.draftId);
    await c.replaceDraft(created.draftId, {
      packageKey: "lc-versions",
      envelope: { ...draftAfterSave.envelope, body: { layers: [{ id: "roads" }], view: {}, widgets: [] } },
      generation: draftAfterSave.generation,
    });
    const v2 = await c.saveAsVersion(created.draftId);
    expect(v2.versionNumber).toBe(2);
    expect(v2.contentHash).not.toBe(v1.contentHash);

    const list = await c.listVersions(created.itemId);
    expect(list.itemId).toBe(created.itemId);
    expect(list.versions.map((v) => v.versionId)).toEqual([v1.versionId, v2.versionId]);

    const fetchedV1 = await c.getVersion(created.itemId, v1.versionId);
    expect(fetchedV1).toEqual(v1);

    const comparison = await c.compareVersions(created.itemId, {
      leftVersionId: v1.versionId,
      rightVersionId: v2.versionId,
    });
    expect(comparison.contentEqual).toBe(false);
    expect(comparison.changes).toContain("content");
  });

  it("listVersions for an item with no versions returns an empty array (200), matching the doc", async () => {
    server = await startMockServer();
    const c = client();
    const created = await c.createDraft({
      packageKey: "lc-noversions",
      envelope: { family: "query", schemaVersion: "1.0", body: { where: "1=1" } },
    });
    const list = await c.listVersions(created.itemId);
    expect(list).toEqual({ itemId: created.itemId, versions: [] });
  });

  it("getVersion for a cross-item version id is not found (ownership boundary)", async () => {
    server = await startMockServer();
    const c = client();
    const a = await c.createDraft({ packageKey: "lc-a", envelope: { family: "query", schemaVersion: "1.0" } });
    const versionA = await c.saveAsVersion(a.draftId);
    const b = await c.createDraft({ packageKey: "lc-b", envelope: { family: "query", schemaVersion: "1.0" } });

    await expect(c.getVersion(b.itemId, versionA.versionId)).rejects.toSatisfy((error: unknown) =>
      isStudioLifecycleNotFound(error),
    );
  });

  it("reopenVersion copies an immutable version into a fresh mutable draft with baseVersionId set", async () => {
    server = await startMockServer();
    const c = client();
    const created = await c.createDraft({
      packageKey: "lc-reopen",
      envelope: { family: "map", schemaVersion: "1.0", body: { layers: [{ id: "roads" }], view: {}, widgets: [] } },
    });
    const version = await c.saveAsVersion(created.draftId);

    const reopened = await c.reopenVersion(created.itemId, version.versionId);
    expect(reopened.baseVersionId).toBe(version.versionId);
    expect(reopened.generation).toBe(1);
    expect(reopened.envelope.body).toEqual(created.envelope.body);
    expect(reopened.draftId).not.toBe(created.draftId);
  });

  it("requestPublish accepts a valid version and moves the published pointer", async () => {
    server = await startMockServer();
    const c = client();
    const created = await c.createDraft({
      packageKey: "lc-publish",
      envelope: {
        family: "map",
        schemaVersion: "1.0",
        publicationIntent: { route: "/studio/lc-publish", visibility: "organization" },
        body: { layers: [], view: {}, widgets: [] },
      },
    });
    const version = await c.saveAsVersion(created.draftId);

    const request = await c.requestPublish(created.itemId, version.versionId, {});
    expect(request.status).toBe("accepted");
    expect(request.intent).toEqual({ route: "/studio/lc-publish", visibility: "organization" });

    const items = await c.listContentItems({ q: "lc-publish" });
    expect(items.items[0]?.state).toBe("published");
    expect(items.items[0]?.publishedVersionId).toBe(version.versionId);
    expect(items.items[0]?.publication?.lifecycle).toBe("active");
  });

  it("requestRollback moves current/published/both pointers to the target version", async () => {
    server = await startMockServer();
    const c = client();
    const created = await c.createDraft({
      packageKey: "lc-rollback",
      envelope: { family: "map", schemaVersion: "1.0", body: { layers: [], view: {}, widgets: [] } },
    });
    const v1 = await c.saveAsVersion(created.draftId);
    const draftAfter = await c.getDraft(created.draftId);
    await c.replaceDraft(created.draftId, {
      packageKey: "lc-rollback",
      envelope: { ...draftAfter.envelope, body: { layers: [{ id: "x" }], view: {}, widgets: [] } },
      generation: draftAfter.generation,
    });
    const v2 = await c.saveAsVersion(created.draftId);
    await c.requestPublish(created.itemId, v2.versionId, {});

    const rollback = await c.requestRollback(created.itemId, {
      targetVersionId: v1.versionId,
      pointer: "both",
      reason: "bad deploy",
    });
    expect(rollback.pointers).toEqual({
      itemId: created.itemId,
      currentVersionId: v1.versionId,
      publishedVersionId: v1.versionId,
    });

    const items = await c.listContentItems({ q: "lc-rollback" });
    expect(items.items[0]?.currentVersionId).toBe(v1.versionId);
    expect(items.items[0]?.publishedVersionId).toBe(v1.versionId);
    void v2;
  });

  it("listContentItems and listPackageDrafts filter by family/q and page via nextCursor (stable ordering)", async () => {
    server = await startMockServer();
    const c = client();
    for (let i = 0; i < 5; i += 1) {
      await c.createDraft({
        packageKey: `lc-page-${i}`,
        envelope: { family: i % 2 === 0 ? "map" : "query", schemaVersion: "1.0" },
      });
    }

    const mapOnly = await c.listPackageDrafts({ families: ["map"] });
    expect(mapOnly.items.every((d) => d.family === "map")).toBe(true);
    expect(mapOnly.total).toBe(3);

    const searched = await c.listPackageDrafts({ q: "lc-page-2" });
    expect(searched.items.map((d) => d.packageKey)).toEqual(["lc-page-2"]);

    const page1 = await c.listPackageDrafts({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    expect(page1.total).toBe(5);

    const seen = new Set(page1.items.map((d) => d.draftId));
    let cursor = page1.nextCursor ?? undefined;
    while (cursor) {
      const next = await c.listPackageDrafts({ limit: 2, cursor });
      for (const draft of next.items) {
        expect(seen.has(draft.draftId)).toBe(false); // no duplicate rows across pages
        seen.add(draft.draftId);
      }
      cursor = next.nextCursor ?? undefined;
    }
    expect(seen.size).toBe(5); // every draft visited exactly once across all pages
  });

  it("listContentItems filters by derived state (draft/current/published)", async () => {
    server = await startMockServer();
    const c = client();
    const draftOnly = await c.createDraft({
      packageKey: "lc-state-draft",
      envelope: { family: "query", schemaVersion: "1.0" },
    });
    const current = await c.createDraft({
      packageKey: "lc-state-current",
      envelope: { family: "query", schemaVersion: "1.0" },
    });
    await c.saveAsVersion(current.draftId);
    void draftOnly;

    const draftStateItems = await c.listContentItems({ states: ["draft"], q: "lc-state" });
    expect(draftStateItems.items.map((i) => i.packageKey)).toEqual(["lc-state-draft"]);

    const currentStateItems = await c.listContentItems({ states: ["current"], q: "lc-state" });
    expect(currentStateItems.items.map((i) => i.packageKey)).toEqual(["lc-state-current"]);
  });

  it("an unknown family in the enumeration filter is a validation error (400)", async () => {
    server = await startMockServer();
    await expect(client().listContentItems({ families: ["not-a-family" as never] })).rejects.toMatchObject({
      code: "validation",
    });
  });
});

describe("lifecycle/lifecycle-client error mapping (fetch-mocked)", () => {
  function jsonResponse(status: number, body: unknown, contentType = "application/json"): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } });
  }

  it("maps a 401 with no auth configured straight to StudioLifecycleSessionExpiredError", async () => {
    const fetchImpl = (async () => jsonResponse(401, {})) as unknown as typeof fetch;
    const c = new StudioLifecycleClient({ baseUrl: "/api", fetchImpl });
    await expect(c.getPackageFamilies()).rejects.toBeInstanceOf(StudioLifecycleSessionExpiredError);
  });

  it("a 401 WITH auth retries once with forceRefresh, then succeeds", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return jsonResponse(401, {});
      return jsonResponse(200, { success: true, data: { persistenceMode: "in-memory", durable: false, families: [] } });
    }) as unknown as typeof fetch;
    const forceRefreshCalls: (boolean | undefined)[] = [];
    const auth = {
      getAccessToken: async (options?: { forceRefresh?: boolean }) => {
        forceRefreshCalls.push(options?.forceRefresh);
        return "token";
      },
    };
    const c = new StudioLifecycleClient({ baseUrl: "/api", auth, fetchImpl });
    const result = await c.getPackageFamilies();
    expect(result.persistenceMode).toBe("in-memory");
    expect(forceRefreshCalls).toEqual([false, true]);
    expect(call).toBe(2);
  });

  it("parses an RFC 7807 problem body's detail/title into the thrown error's message", async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        400,
        {
          type: "https://honua.io/problems/studio",
          title: "Invalid request",
          status: 400,
          detail: "'packageKey' is required.",
        },
        "application/problem+json",
      )) as unknown as typeof fetch;
    const c = new StudioLifecycleClient({ baseUrl: "/api", fetchImpl });
    await expect(c.getPackageFamilies()).rejects.toMatchObject({
      message: "'packageKey' is required.",
      code: "validation",
      status: 400,
    });
  });

  it("a 500 with no parseable body still throws a StudioLifecycleError with code 'internal'", async () => {
    const fetchImpl = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const c = new StudioLifecycleClient({ baseUrl: "/api", fetchImpl });
    await expect(c.getPackageFamilies()).rejects.toBeInstanceOf(StudioLifecycleError);
    await expect(c.getPackageFamilies()).rejects.toMatchObject({ code: "internal", status: 500 });
  });

  it("a transport failure (fetch throws) surfaces as StudioLifecycleTransportError, not an unhandled rejection", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    const c = new StudioLifecycleClient({ baseUrl: "/api", fetchImpl });
    await expect(c.getPackageFamilies()).rejects.toThrow(/Could not reach the Studio lifecycle API/);
  });

  it("a 409 without a StudioLifecycleConflictError-typed problem still maps to the conflict discriminant", async () => {
    const fetchImpl = (async () => jsonResponse(409, {})) as unknown as typeof fetch;
    const c = new StudioLifecycleClient({ baseUrl: "/api", fetchImpl });
    const error = await c.getPackageFamilies().catch((e) => e);
    expect(isStudioLifecycleGenerationConflict(error)).toBe(true);
    expect(error).toBeInstanceOf(StudioLifecycleConflictError);
  });
});
