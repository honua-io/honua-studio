/** Non-coder authoring against an installed verification cohort. No model call. */
import { readFileSync } from "node:fs";

import { chromium, expect, request as playwrightRequest, test } from "@playwright/test";

import { ensureCohortAuthorLayer } from "../../scripts/cohort-author-layer.mjs";
import { approvePasswordPublication } from "./console-publication-approval.mjs";
import { startPreviewServer } from "./helpers.mjs";

const enabled = process.env.HONUA_COHORT_AUTHOR === "1";
const liveBaseUrl = process.env.HONUA_LIVE_BASE_URL?.replace(/\/$/, "");
const consoleUrl = process.env.HONUA_LIVE_CONSOLE_URL?.replace(/\/$/, "");
const passwordFile = process.env.HONUA_COHORT_PASSWORD_FILE;

test.describe("cohort author journey @cohort", () => {
  test.skip(
    !enabled || !liveBaseUrl || !consoleUrl || !passwordFile,
    "Cohort authoring runs only with HONUA_COHORT_AUTHOR=1, HONUA_LIVE_BASE_URL, HONUA_LIVE_CONSOLE_URL and HONUA_COHORT_PASSWORD_FILE.",
  );

  test("a non-coder builds a map and app on a published layer and a password session publishes the exact version", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const apiKey = readFileSync(passwordFile, "utf8").trim();
    const password = apiKey;
    const layer = await ensureCohortAuthorLayer({ baseUrl: liveBaseUrl, apiKey });
    expect(layer.count).toBeGreaterThan(0);

    const packageKey = `cohort-zones-${Date.now()}`;
    const preview = await startPreviewServer({ HONUA_BASE_URL: liveBaseUrl, HONUA_API_KEY: apiKey }, [
      "--mode",
      "live",
    ]);
    let draftId;
    try {
      await page.addInitScript(() => {
        window.__HONUA_STUDIO_HOST_SESSION__ = {
          async getToken() {
            return "cohort-proxy-placeholder";
          },
          onExpired() {
            return () => {};
          },
        };
      });
      await page.goto(preview.url);
      await expect(page.getByTestId("app-shell")).toBeVisible();
      await page.getByRole("button", { name: "Start from a recipe", exact: true }).click();
      await page.getByRole("textbox", { name: "Content key", exact: true }).fill(packageKey);
      const source = page.getByTestId("recipe-source");
      await expect(source.locator("option")).not.toHaveCount(1);
      const sourceValue = await source.evaluate((element) => {
        const option = [...element.options].find((item) => item.textContent?.includes("studio-journey-212"));
        return option?.value ?? "";
      });
      expect(sourceValue).toBeTruthy();
      await source.selectOption(sourceValue);
      await expect(page.getByTestId("recipe-status")).toContainText("Verified");
      await page.getByTestId("recipe-category").selectOption("zoning_code");
      const column = page.getByRole("checkbox", { name: "zoning_code", exact: true });
      await column.check();
      await expect(column).toBeChecked();
      await page.getByTestId("recipe-create").click();
      await expect(page.getByTestId("recipe-status")).toContainText("Created draft", { timeout: 60_000 });
      // Submit renames Cancel to Close; the draft is already accepted.
      await page.getByTestId("recipe-close").click();
      await expect(page.getByTestId("recipe-panel")).toBeHidden();
      await expect(page.getByTestId("studio-widget-grid-row")).toHaveCount(layer.count, { timeout: 60_000 });

      await page.getByTestId("nav-content").click();
      await expect(page.getByTestId("content-browser")).toBeVisible();
      await page.getByTestId("content-browser-search").fill(packageKey);
      const draft = page.getByTestId("draft-row").filter({ hasText: packageKey });
      await expect(draft).toHaveCount(1);
      draftId = await draft.getAttribute("data-draft-id");
      await draft.getByTestId("draft-open").click();
      await expect(page.getByTestId("lifecycle-panel-validation-status")).toContainText("valid");
      await page.getByTestId("lifecycle-panel-save-version").click();
      await expect(page.getByTestId("lifecycle-version-row")).toHaveCount(1);

      const version = page.getByTestId("lifecycle-version-row").first();
      const versionId = await version.getAttribute("data-version-id");
      expect(versionId).toBeTruthy();
      await version.getByTestId("lifecycle-version-publish").click();
      await expect(page.getByTestId("lifecycle-confirm-dialog")).toBeVisible();
      const confirm = page.getByTestId("lifecycle-confirm-input");
      const submit = page.getByTestId("lifecycle-confirm-submit");
      await expect(submit).toBeDisabled();
      await confirm.fill(packageKey);
      await expect(submit).toBeEnabled();
      const publishResponse = page.waitForResponse(
        (response) => response.request().method() === "POST" && response.url().endsWith("/publish-requests"),
      );
      await submit.click();
      const response = await publishResponse;
      expect(response.status()).toBe(202);
      const pending = (await response.json()).data;
      expect(pending.status).toBe(4);
      expect(pending.proposalId).toBeTruthy();
      expect(pending.resourceIds.versionId).toBe(versionId);
      const { itemId, requestId } = pending.resourceIds;
      expect(itemId).toBeTruthy();
      expect(requestId).toBeTruthy();
      await expect(page.getByTestId("lifecycle-panel-message")).toContainText("awaiting separate human approval");

      const route = `/${packageKey}`;
      // The cohort Console returns its HTML shell for unknown /console routes. The publication
      // pointer is the server route, which stays absent until a person approves.
      expect(await publishedStatus(route)).toBe(404);
      const browser = await chromium.launch();
      try {
        const context = await browser.newContext();
        const approvalPage = await context.newPage();
        await approvePasswordPublication(approvalPage, { consoleUrl, proposalId: pending.proposalId, password });
      } finally {
        await browser.close();
      }
      const receiptResponse = await fetch(
        `${liveBaseUrl}/v1/studio/content-items/${itemId}/versions/${versionId}/publish-requests/${requestId}`,
        { headers: { "x-api-key": apiKey } },
      );
      expect(receiptResponse.status).toBe(200);
      const receipt = (await receiptResponse.json()).data;
      expect(receipt).toMatchObject({ status: "accepted", versionId });
      const published = await publishedDocument(route);
      expect(published.status).toBe(200);
      expect(published.body.success).toBe(true);
      expect(published.body.data).toMatchObject({ itemId, versionId, publicationId: requestId, visibility: "public" });
      expect(published.body.data.family).toBe("map");
      expect(published.body.data.envelope.body.layers).not.toHaveLength(0);
    } finally {
      if (draftId) {
        await fetch(`${liveBaseUrl}/v1/studio/package-drafts/${draftId}`, {
          method: "DELETE",
          headers: { "x-api-key": apiKey },
        }).catch(() => {});
      }
      await preview.close();
    }
  });
});

async function publishedStatus(route) {
  return (await publishedDocument(route)).status;
}

async function publishedDocument(route) {
  const api = await playwrightRequest.newContext();
  try {
    const response = await api.get(`${liveBaseUrl}/v1/studio/published${route}`, { maxRedirects: 0 });
    const contentType = response.headers()["content-type"] ?? "";
    const body = contentType.includes("json") ? await response.json() : null;
    return { status: response.status(), body };
  } finally {
    await api.dispose();
  }
}
