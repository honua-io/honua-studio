/**
 * Chat console fixture-conversation journey (honua-studio#6, AD-4's
 * no-model fixture-conversation mode / NFR-001 "deterministic CI"). Drives
 * the real, built standalone shell's auto-composed `<honua-studio-chat>`
 * through the full `compose-districts-map` scripted conversation via
 * `FixtureChatTransport` (installed by `src/main.ts`'s test-only fixture
 * hook — see that file's `window.__honuaStudioChatFixtureConversationId`
 * doc), and proves the rendered transcript is byte-identical across two
 * independent page loads — no model, no wall clock, no flakiness.
 */
import { expect, test } from "@playwright/test";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { startPreviewServer } from "./helpers.mjs";

async function runFixtureJourney(page, previewUrl, token) {
  await page.addInitScript(
    ({ token, conversationId }) => {
      window.__honuaStudioFixtureToken = token;
      window.__honuaStudioChatFixtureConversationId = conversationId;
    },
    { token, conversationId: "compose-districts-map" },
  );
  await page.goto(previewUrl);
  await expect(page.getByTestId("studio-chat")).toBeVisible();

  await page.evaluate(() => window.__honuaStudioChat.sendMessage("Add the Hawai'i statewide parcels layer and style it by district."));
  await expect(page.getByTestId("studio-chat-tool-call")).toContainText("add_layer");
  await expect(page.getByTestId("studio-chat-tool-call")).toHaveAttribute("data-status", "complete");

  await page.evaluate(() => window.__honuaStudioChat.sendMessage("Now add a chart showing the count of parcels by zoning code."));
  const toolCalls = page.getByTestId("studio-chat-tool-call");
  await expect(toolCalls).toHaveCount(2);
  await expect(toolCalls.nth(1)).toContainText("add_chart");

  return page.evaluate(() => document.querySelector("honua-studio-chat").shadowRoot.querySelector('[data-testid="studio-chat-log"]').innerHTML);
}

test.describe("chat console fixture-conversation journey (standalone shell)", () => {
  test("plays the scripted compose-districts-map conversation end to end, byte-stable across two independent page loads", async ({
    browser,
  }) => {
    const mock = await startMockServer();
    const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
    try {
      const token = mintFixtureAccessToken();
      // Two fully independent browser contexts/pages — nothing shared but
      // the (stateless, replayed-from-scratch-each-time) fixture script.
      const contextA = await browser.newContext();
      const contextB = await browser.newContext();
      try {
        const htmlA = await runFixtureJourney(await contextA.newPage(), preview.url, token);
        const htmlB = await runFixtureJourney(await contextB.newPage(), preview.url, token);
        expect(htmlA).toBe(htmlB);
        expect(htmlA).toContain("Adding the parcels layer and styling it by district now.");
      } finally {
        await contextA.close();
        await contextB.close();
      }
    } finally {
      await preview.close();
      await mock.close();
    }
  });

  test("cancel() mid-stream marks the turn cancelled and re-enables the composer", async ({ page }) => {
    const mock = await startMockServer();
    const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
    try {
      await page.addInitScript(
        ({ token, conversationId }) => {
          window.__honuaStudioFixtureToken = token;
          window.__honuaStudioChatFixtureConversationId = conversationId;
        },
        { token: mintFixtureAccessToken(), conversationId: "compose-districts-map" },
      );
      await page.goto(preview.url);
      await expect(page.getByTestId("studio-chat")).toBeVisible();

      await page.evaluate(() => {
        // Fire-and-forget so we can cancel while it's in flight.
        void window.__honuaStudioChat.sendMessage("Add the Hawai'i statewide parcels layer and style it by district.");
      });
      await page.evaluate(() => window.__honuaStudioChat.cancel());
      await expect
        .poll(() => page.evaluate(() => window.__honuaStudioChat.streaming))
        .toBe(false);
      await expect(page.getByTestId("studio-chat-input")).toBeEnabled();
    } finally {
      await preview.close();
      await mock.close();
    }
  });
});
