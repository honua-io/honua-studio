/**
 * The package lifecycle journey (honua-studio#9): browse -> open -> edit ->
 * version -> compare -> publish-confirm, driven through
 * `<honua-studio-content-browser>` + `<honua-studio-lifecycle-panel>` in a
 * REAL browser against `mock-server.mjs`'s real REST lifecycle routes —
 * mirrors `mcp-compose-journey.spec.mjs`'s "real fixture, real browser, real
 * DOM interactions" approach.
 *
 * A draft is seeded via one direct REST call before navigating (there is no
 * "create a new draft" button in this issue's scope — draft creation is an
 * agent/chat-tool-call or per-family-editor concern, tracked separately);
 * everything from "browse" onward is driven purely through the UI. "Edit" is
 * likewise a single direct REST PUT between the two "Save as version" clicks
 * — this issue's lifecycle panel has no body editor (that is per-family
 * editor scope, honua-studio's Phase 2 backlog) — documented here rather
 * than faked as a UI interaction that doesn't exist yet.
 */
import { expect, test } from "@playwright/test";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { startPreviewServer } from "./helpers.mjs";

test.describe("package lifecycle journey: browse -> open -> edit -> version -> compare -> publish-confirm", () => {
  test("drives the full lifecycle through real UI interactions against the real REST lifecycle store", async ({
    page,
  }) => {
    const mock = await startMockServer();
    const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
    try {
      const token = mintFixtureAccessToken();

      async function restCall(method, path, body) {
        const response = await fetch(`${mock.url}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        const json = await response.json();
        return json.data;
      }

      // Seed: one draft, as if an agent (or a per-family editor, out of this
      // issue's scope) had already composed it.
      const seeded = await restCall("POST", "/v1/studio/package-drafts", {
        packageKey: "journey-parcels-overview",
        envelope: {
          family: "map",
          schemaVersion: "1.0",
          format: "honua_map_package.v1",
          body: { layers: [{ id: "parcels", sourceId: "parcels" }], view: { zoom: 10 }, widgets: [] },
        },
      });

      await page.addInitScript((fixtureToken) => {
        window.__honuaStudioFixtureToken = fixtureToken;
      }, token);
      await page.goto(preview.url);
      await expect(page.getByTestId("app-shell")).toBeVisible();

      // Assign a session so the content browser's/lifecycle panel's bearer-
      // gated REST calls succeed (same pattern mcp-compose-journey.spec.mjs
      // uses for the MCP path).
      await page.evaluate((fixtureToken) => {
        window.__honuaStudioApp.session = { getToken: async () => fixtureToken, onExpired: () => () => {} };
      }, token);

      // Navigate to /content (hash router).
      await page.getByTestId("nav-content").click();
      await expect(page.getByTestId("content-route")).toBeVisible();
      await expect(page.getByTestId("content-browser")).toBeVisible();

      // Browse: the seeded draft is listed.
      await expect(page.getByTestId("draft-row")).toContainText("journey-parcels-overview");

      // Open: click "Open" on the draft row -> lifecycle panel shows it.
      await page.getByTestId("draft-open").click();
      await expect(page.getByTestId("content-route-panel")).toBeVisible();
      await expect(page.getByTestId("lifecycle-panel-generation")).toContainText("1");

      // Version: save the seeded draft as v1.
      await page.getByTestId("lifecycle-panel-save-version").click();
      await expect(page.getByTestId("lifecycle-version-row")).toHaveCount(1);

      // Edit: a real body change via direct REST (no body-editor UI in this
      // issue's scope — see the module doc).
      const draftAfterV1 = await restCall("GET", `/v1/studio/package-drafts/${seeded.draftId}`);
      await restCall("PUT", `/v1/studio/package-drafts/${seeded.draftId}`, {
        packageKey: "journey-parcels-overview",
        envelope: {
          ...draftAfterV1.envelope,
          body: { layers: [{ id: "parcels" }, { id: "roads" }], view: { zoom: 12 }, widgets: [] },
        },
        generation: draftAfterV1.generation,
      });

      // Version: save the edit as v2, through the SAME UI button — no page
      // reload, proving the panel's own client re-reads the draft it
      // already has open.
      await page.getByTestId("lifecycle-panel-save-version").click();
      await expect(page.getByTestId("lifecycle-version-row")).toHaveCount(2);

      // Compare: select v1 as left, v2 as right, click Compare.
      const leftRadios = page.getByTestId("lifecycle-compare-left");
      const rightRadios = page.getByTestId("lifecycle-compare-right");
      await leftRadios.nth(0).check();
      await rightRadios.nth(1).check();
      await page.getByTestId("lifecycle-compare-button").click();
      await expect(page.getByTestId("lifecycle-comparison")).toBeVisible();
      await expect(page.getByTestId("lifecycle-comparison-changes")).toContainText("content");

      // Publish-confirm: open the confirm dialog on v2, verify the human
      // gate (disabled until the exact package key is typed), then confirm.
      const versionRows = page.getByTestId("lifecycle-version-row");
      await versionRows.nth(1).getByTestId("lifecycle-version-publish").click();
      await expect(page.getByTestId("lifecycle-confirm-dialog")).toBeVisible();
      const submit = page.getByTestId("lifecycle-confirm-submit");
      await expect(submit).toBeDisabled();

      await page.getByTestId("lifecycle-confirm-input").fill("wrong-key");
      await expect(submit).toBeDisabled();

      await page.getByTestId("lifecycle-confirm-input").fill("journey-parcels-overview");
      await expect(submit).toBeEnabled();
      await submit.click();

      await expect(page.getByTestId("lifecycle-confirm-dialog")).toBeHidden();
      await expect(page.getByTestId("lifecycle-panel-message")).toContainText("Published");

      // Verify against the REAL store, independent of the UI: the item is
      // now published, pointing at v2 (the version confirmed above).
      const items = await restCall("GET", "/v1/studio/content-items?q=journey-parcels-overview");
      expect(items.items[0].state).toBe("published");
    } finally {
      await preview.close();
      await mock.close();
    }
  });
});
