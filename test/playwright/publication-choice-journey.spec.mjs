/**
 * Publishing a saved version that has no publication intent: the person
 * publishing chooses the route and visibility in the confirm dialog, and the
 * publish request carries exactly that choice. Runs against mock-server.mjs.
 */
import { expect, test } from "@playwright/test";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { applyTheme, expectNoSeriousAxeViolations, startPreviewServer } from "./helpers.mjs";

const contentKey = "chosen-intent-map";

async function seedDraftWithoutIntent(mockUrl, token) {
  const response = await fetch(`${mockUrl}/v1/studio/package-drafts`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      packageKey: contentKey,
      envelope: {
        family: "map",
        schemaVersion: "1.0",
        format: "honua_map_package.v1",
        body: { layers: [{ id: "parcels", sourceId: "parcels" }], view: { zoom: 10 }, widgets: [] },
      },
    }),
  });
  expect(response.status).toBeLessThan(300);
}

async function openPublishConfirm(page, previewUrl, token) {
  await page.addInitScript((fixtureToken) => {
    window.__honuaStudioFixtureToken = fixtureToken;
  }, token);
  await page.goto(previewUrl);
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await page.evaluate((fixtureToken) => {
    window.__honuaStudioApp.session = { getToken: async () => fixtureToken, onExpired: () => () => {} };
  }, token);
  await page.getByTestId("nav-content").click();
  await page.getByTestId("draft-row").filter({ hasText: contentKey }).getByTestId("draft-open").click();
  await page.getByTestId("lifecycle-panel-save-version").click();
  await page.getByTestId("lifecycle-version-row").first().getByTestId("lifecycle-version-publish").click();
  await expect(page.getByTestId("lifecycle-confirm-dialog")).toBeVisible();
}

for (const themeSet of ["standalone", "console"]) {
  for (const mode of ["light", "dark"]) {
    test(`publishes a version without intent with the chosen route and visibility: ${themeSet} ${mode}`, async ({
      page,
    }, testInfo) => {
      const mock = await startMockServer();
      const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
      try {
        const token = mintFixtureAccessToken();
        await seedDraftWithoutIntent(mock.url, token);
        await applyTheme(page, themeSet, mode);
        await openPublishConfirm(page, preview.url, token);

        const submit = page.getByTestId("lifecycle-confirm-submit");
        await expect(page.getByTestId("lifecycle-publication-route")).toHaveValue(`/${contentKey}`);
        await page.getByTestId("lifecycle-confirm-input").fill(contentKey);
        await expect(submit).toBeDisabled();
        await page.getByTestId("lifecycle-publication-visibility").selectOption("organization");
        await expect(submit).toBeEnabled();
        await expectNoSeriousAxeViolations(page, testInfo, `publication-choice-${themeSet}-${mode}`);

        const publishRequest = page.waitForRequest(
          (request) => request.method() === "POST" && request.url().endsWith("/publish-requests"),
        );
        await submit.click();
        expect((await publishRequest).postDataJSON().intent).toEqual({
          route: `/${contentKey}`,
          visibility: "organization",
        });
        await expect(page.getByTestId("lifecycle-panel-message")).toContainText("Published");
      } finally {
        await preview.close();
        await mock.close();
      }
    });
  }
}
