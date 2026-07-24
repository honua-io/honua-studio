/**
 * The full conversational-GP-authoring journey (honua-studio#10) in a real
 * browser against the real `mock-server.mjs`: an agent-authored `gp`
 * package (seeded via REST here, the same way `lifecycle-journey.spec.mjs`
 * seeds its draft — draft AUTHORING itself is proven end to end by
 * `test/gp/human-gate.test.ts` and `test/gp/fixture-conversation.test.ts`'s
 * real MCP-client path) is validated, previewed, executed behind THE HUMAN
 * GATE's typed confirmation, monitored to completion, and its output is
 * added to the composition — then a page reload proves reload-resume by job
 * id. A second, shorter run proves mid-job cancel.
 */
import { expect, test } from "@playwright/test";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { startPreviewServer } from "./helpers.mjs";

const GP_BODY = {
  title: "Buffer flood zones and intersect with parcels",
  description: "Buffers the statewide flood zone dataset by 500m and intersects the result with parcels, statewide.",
  inputs: [
    { id: "flood-zones", title: "Flood zones", datasetRef: "hi-flood-zones" },
    { id: "parcels", title: "Parcels", datasetRef: "hi-parcels" },
  ],
  parameters: [{ id: "buffer-distance-m", title: "Buffer distance", type: "number", value: 500, unit: "meters" }],
  outputs: [{ id: "affected-parcels", title: "Parcels within 500m of a flood zone" }],
  steps: [],
};

test.describe("GP journey: validate -> preview -> confirm -> execute -> monitor -> add-output-layer -> reload-resume", () => {
  test("drives the full journey through real UI interactions against the real mock server", async ({ page }) => {
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

      // Seed: an agent-authored gp package, as if runGpFixtureAuthoring had
      // just run against the real /mcp endpoint (that path is proven
      // separately — see this file's module doc).
      const seeded = await restCall("POST", "/v1/studio/package-drafts", {
        packageKey: "playwright-gp-buffer-intersect",
        envelope: { family: "gp", schemaVersion: "1.0", body: GP_BODY },
      });

      await page.addInitScript((fixtureToken) => {
        window.__honuaStudioFixtureToken = fixtureToken;
      }, token);
      await page.goto(preview.url);
      await expect(page.getByTestId("app-shell")).toBeVisible();

      await page.evaluate((fixtureToken) => {
        window.__honuaStudioApp.session = { getToken: async () => fixtureToken, onExpired: () => () => {} };
        window.__honuaStudioApp.enableLiveComposition({
          baseUrl: "/api",
          packageKey: "gp-journey-map",
          family: "map",
          schemaVersion: "1",
        });
      }, token);

      // Mount <honua-studio-gp-panel> directly (no dedicated route in this
      // app's shell yet — same "no privileged internal API" boundary every
      // other placeholder element already documents; this element is
      // globally registered by main.ts's registerAllStudioElements() call).
      await page.evaluate((fixtureToken) => {
        const el = document.createElement("honua-studio-gp-panel");
        el.setAttribute("data-testid-host", "gp-panel-host");
        el.auth = { getAccessToken: async () => fixtureToken };
        el.slot = "chat"; // rendered via the shell's existing named slot (app-shell has no default/unnamed slot)
        window.__honuaStudioApp.appendChild(el);
        window.__honuaStudioGpPanel = el;
      }, token);

      await page.evaluate((draftId) => {
        window.__honuaStudioGpPanel.draftId = draftId;
      }, seeded.draftId);

      await expect(page.getByTestId("gp-panel-generation")).toBeVisible();
      await expect(page.getByTestId("gp-inputs")).toContainText("Flood zones");
      await expect(page.getByTestId("gp-parameters")).toContainText("Buffer distance");
      await expect(page.getByTestId("gp-outputs")).toContainText("Parcels within 500m");
      // The honest caveat is always visible, not gated behind any action.
      await expect(page.getByTestId("gp-validation-caveat")).toContainText(/envelope-only/i);

      // Validate.
      await page.getByTestId("gp-panel-validate").click();
      await expect(page.getByTestId("gp-panel-validation-status")).toContainText("valid");

      // Preview plan (REQ-002: mandatory before Execute appears at all).
      await expect(page.getByTestId("gp-execute-open")).toHaveCount(0);
      await page.getByTestId("gp-panel-preview").click();
      await expect(page.getByTestId("gp-preview-requires-job")).toContainText("requires a batch job");
      await expect(page.getByTestId("gp-execute-open")).toBeVisible();

      // THE HUMAN GATE: open confirm, prove it's gated on the exact typed package key.
      await page.getByTestId("gp-execute-open").click();
      await expect(page.getByTestId("gp-confirm-dialog")).toBeVisible();
      const submit = page.getByTestId("gp-confirm-submit");
      await expect(submit).toBeDisabled();

      await page.getByTestId("gp-confirm-input").fill("wrong-key");
      await expect(submit).toBeDisabled();

      await page.getByTestId("gp-confirm-input").fill("playwright-gp-buffer-intersect");
      await expect(submit).toBeEnabled();
      await submit.click();

      await expect(page.getByTestId("gp-confirm-dialog")).toBeHidden();
      await expect(page.getByTestId("gp-job-status")).toContainText("accepted");

      // Monitor: two caller-driven "Check status" clicks, no timer.
      await page.getByTestId("gp-job-check-status").click();
      await expect(page.getByTestId("gp-job-status")).toContainText("running");
      await page.getByTestId("gp-job-check-status").click();
      await expect(page.getByTestId("gp-job-status")).toContainText("successful");
      await expect(page.getByTestId("gp-job-outputs")).toContainText("Parcels within 500m");

      // REQ-004: add the completed output to the composition via the SAME
      // addLayer path a chat tool-call intent uses.
      await page.getByTestId("gp-add-output").click();
      await expect
        .poll(() => page.evaluate(() => window.__honuaStudioApp.composition.state.layers.map((l) => l.id)))
        .toEqual(expect.arrayContaining([expect.stringContaining("gp-output-")]));

      // Reload-resume by job id (REQ-003): a fresh page load, a fresh panel
      // instance, the SAME draftId — sessionStorage (same browser context)
      // resumes monitoring with no further clicks, and shows the completed job.
      await page.reload();
      await expect(page.getByTestId("app-shell")).toBeVisible();
      await page.evaluate((fixtureToken) => {
        window.__honuaStudioApp.session = { getToken: async () => fixtureToken, onExpired: () => () => {} };
      }, token);
      await page.evaluate((fixtureToken) => {
        const el = document.createElement("honua-studio-gp-panel");
        el.auth = { getAccessToken: async () => fixtureToken };
        el.slot = "chat"; // rendered via the shell's existing named slot (app-shell has no default/unnamed slot)
        window.__honuaStudioApp.appendChild(el);
        window.__honuaStudioGpPanel = el;
      }, token);
      await page.evaluate((draftId) => {
        window.__honuaStudioGpPanel.draftId = draftId;
      }, seeded.draftId);
      await expect(page.getByTestId("gp-job-status")).toContainText("successful");
    } finally {
      await preview.close();
      await mock.close();
    }
  });

  test("cancel mid-job renders dismissed and is idempotent", async ({ page }) => {
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

      const seeded = await restCall("POST", "/v1/studio/package-drafts", {
        packageKey: "playwright-gp-cancel",
        envelope: { family: "gp", schemaVersion: "1.0", body: GP_BODY },
      });

      await page.addInitScript((fixtureToken) => {
        window.__honuaStudioFixtureToken = fixtureToken;
      }, token);
      await page.goto(preview.url);
      await expect(page.getByTestId("app-shell")).toBeVisible();
      await page.evaluate((fixtureToken) => {
        window.__honuaStudioApp.session = { getToken: async () => fixtureToken, onExpired: () => () => {} };
      }, token);

      await page.evaluate((fixtureToken) => {
        const el = document.createElement("honua-studio-gp-panel");
        el.auth = { getAccessToken: async () => fixtureToken };
        el.slot = "chat"; // rendered via the shell's existing named slot (app-shell has no default/unnamed slot)
        window.__honuaStudioApp.appendChild(el);
        window.__honuaStudioGpPanel = el;
      }, token);
      await page.evaluate((draftId) => {
        window.__honuaStudioGpPanel.draftId = draftId;
      }, seeded.draftId);

      await page.getByTestId("gp-panel-preview").click();
      await expect(page.getByTestId("gp-execute-open")).toBeVisible();
      await page.getByTestId("gp-execute-open").click();
      await page.getByTestId("gp-confirm-input").fill("playwright-gp-cancel");
      await page.getByTestId("gp-confirm-submit").click();
      await expect(page.getByTestId("gp-job-status")).toContainText("accepted");

      await page.getByTestId("gp-job-cancel").click();
      await expect(page.getByTestId("gp-job-status")).toContainText("dismissed");
      // Idempotent: the cancel/check-status buttons are gone once terminal —
      // nothing left to click that could un-cancel it.
      await expect(page.getByTestId("gp-job-cancel")).toHaveCount(0);
      await expect(page.getByTestId("gp-job-check-status")).toHaveCount(0);
    } finally {
      await preview.close();
      await mock.close();
    }
  });
});
