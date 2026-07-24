/**
 * Console round-trip fixture suite (honua-studio#9 REQ-003, honest per spec
 * AD-3). For each fixture in `src/lifecycle/fixtures/index.ts` (map, query,
 * dashboard — AD-3's "lifecycle-native from day one" families), drives the
 * REAL sequence Studio's UI drives: open (create a draft from the
 * console-authored envelope) -> edit -> save-as-version -> reopen, and
 * asserts the envelope body survives losslessly at every step, against the
 * REAL `mock-server.mjs` REST lifecycle store (not a re-implementation).
 *
 * This is round-trip BY MIGRATION (AD-3): nothing here re-derives or
 * reconstructs the envelope from some other in-memory shape — every
 * assertion reads back exactly the server's own envelope.
 *
 * `form` and `analysis` are deliberately absent — see
 * `src/lifecycle/fixtures/index.ts`'s module doc: those two round-trip only
 * after honua-server's persistence unification (server issue #3004).
 */
import { afterEach, describe, expect, it } from "vitest";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import {
  LIFECYCLE_NATIVE_ROUND_TRIP_FAMILIES,
  STUDIO_ROUND_TRIP_FIXTURES,
} from "../../src/lifecycle/fixtures/index.js";
import { StudioLifecycleClient } from "../../src/lifecycle/lifecycle-client.js";

let server: Awaited<ReturnType<typeof startMockServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function client(): StudioLifecycleClient {
  const token = mintFixtureAccessToken();
  return new StudioLifecycleClient({ baseUrl: server?.url, auth: { getAccessToken: async () => token } });
}

describe("lifecycle/fixtures round-trip: open -> edit -> save-version -> reopen (honua-studio#9 REQ-003)", () => {
  it("ships exactly the lifecycle-native families AD-3 claims (map, query, dashboard) — not form/analysis", () => {
    expect(LIFECYCLE_NATIVE_ROUND_TRIP_FAMILIES).toEqual(["map", "query", "dashboard"]);
    expect(STUDIO_ROUND_TRIP_FIXTURES.map((f) => f.family).sort()).toEqual(["dashboard", "map", "query"]);
  });

  for (const fixture of STUDIO_ROUND_TRIP_FIXTURES) {
    it(`${fixture.name} (${fixture.family}): open -> save-version -> reopen preserves the body losslessly`, async () => {
      server = await startMockServer();
      const c = client();

      // "Open": a console-authored package handed to Studio as a fresh draft.
      const opened = await c.createDraft({ packageKey: fixture.packageKey, envelope: fixture.envelope });
      expect(opened.envelope.body).toEqual(fixture.envelope.body);
      expect(opened.envelope.bindings).toEqual(fixture.envelope.bindings);
      expect(opened.envelope.dependencies).toEqual(fixture.envelope.dependencies);
      expect(opened.envelope.provenance).toEqual(fixture.envelope.provenance);

      // "Save as version": captures the untouched envelope as v1.
      const v1 = await c.saveAsVersion(opened.draftId);
      expect(v1.envelope.body).toEqual(fixture.envelope.body);
      expect(v1.dependencies).toEqual(fixture.envelope.dependencies ?? []);
      expect(v1.provenance).toEqual(fixture.envelope.provenance ?? []);

      // "Reopen": the immutable version becomes a fresh mutable draft with
      // the EXACT SAME body the fixture originally supplied — no
      // client-side re-derivation anywhere in this path.
      const reopened = await c.reopenVersion(opened.itemId, v1.versionId);
      expect(reopened.envelope.body).toEqual(fixture.envelope.body);
      expect(reopened.baseVersionId).toBe(v1.versionId);
      expect(reopened.generation).toBe(1);
    });

    it(`${fixture.name} (${fixture.family}): a real edit survives a second save-version -> reopen round trip`, async () => {
      server = await startMockServer();
      const c = client();

      const opened = await c.createDraft({ packageKey: fixture.packageKey, envelope: fixture.envelope });
      const v1 = await c.saveAsVersion(opened.draftId);

      // "Edit": mutate the body (append a marker so the change is
      // unambiguous regardless of family-specific body shape).
      const draftAfterV1 = await c.getDraft(opened.draftId);
      const editedBody = { ...(draftAfterV1.envelope.body as Record<string, unknown>), __roundTripEdit: true };
      const edited = await c.replaceDraft(opened.draftId, {
        packageKey: fixture.packageKey,
        envelope: { ...draftAfterV1.envelope, body: editedBody },
        generation: draftAfterV1.generation,
      });
      expect(edited.envelope.body).toEqual(editedBody);

      const v2 = await c.saveAsVersion(opened.draftId);
      expect(v2.versionId).not.toBe(v1.versionId);
      expect(v2.contentHash).not.toBe(v1.contentHash);
      expect(v2.envelope.body).toEqual(editedBody);

      const reopenedV2 = await c.reopenVersion(opened.itemId, v2.versionId);
      expect(reopenedV2.envelope.body).toEqual(editedBody);

      // v1 remains untouched — immutability of prior versions.
      const stillV1 = await c.getVersion(opened.itemId, v1.versionId);
      expect(stillV1.envelope.body).toEqual(fixture.envelope.body);
    });
  }
});
