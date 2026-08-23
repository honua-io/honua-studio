/**
 * The compose fixture journey (honua-studio#6's `compose-districts-map`
 * scripted conversation), now flowing through the REAL MCP client
 * (`src/mcp/client.ts`, via `<honua-studio-app>`'s `.enableLiveComposition()`
 * — honua-studio#7) against `mock-server.mjs`'s real `/mcp` endpoint,
 * end to end in a real browser: chat tool-call event -> tool-bridge ->
 * `McpClient.initialize()` + `tools/call` (`honua_studio_add_layer` /
 * `honua_studio_add_widget`) -> local composition state refreshed from the
 * server's returned draft -> `<honua-studio-canvas>` re-renders.
 *
 * The chat side stays on `FixtureChatTransport` (AD-4's no-model
 * fixture-conversation mode, same as `chat-fixture-journey.spec.mjs`) — this
 * spec's own subject is the MCP tool plane the tool-call intents flow
 * through, not the chat streaming path #6 already covers.
 */
import { expect, test } from "@playwright/test";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { startPreviewServer } from "./helpers.mjs";

test.describe("compose fixture journey through the real MCP client (standalone shell)", () => {
  test("add_layer/add_chart tool-call intents mutate a REAL server-side Studio draft via honua_studio_* MCP tools", async ({
    page,
  }) => {
    const mock = await startMockServer();
    const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
    try {
      const token = mintFixtureAccessToken();
      await page.addInitScript(
        ({ token, conversationId }) => {
          window.__honuaStudioFixtureToken = token;
          window.__honuaStudioChatFixtureConversationId = conversationId;
        },
        { token, conversationId: "compose-districts-map" },
      );
      await page.goto(preview.url);
      await expect(page.getByTestId("studio-chat")).toBeVisible();

      // Assign a session (`.mcp`'s tool calls are bearer-gated, same as
      // every other protected route on this fixture — `tools/call` requires
      // authentication even though `initialize`/`tools/list` are open) and
      // attach a live MCP session — the AD-8 authoritative path — pointed at
      // this same mock server's real /mcp endpoint (proxied through vite's
      // /api rewrite, same base the chat SSE fixture itself uses).
      await page.evaluate((token) => {
        window.__honuaStudioApp.session = { getToken: async () => token, onExpired: () => () => {} };
        window.__honuaStudioApp.enableLiveComposition({
          baseUrl: "/api",
          packageKey: "pkg-mcp-compose-journey",
          family: "map",
          schemaVersion: "1",
        });
      }, token);

      await page.evaluate(() =>
        window.__honuaStudioChat.sendMessage("Add the Hawai'i statewide parcels layer and style it by district."),
      );
      await expect(page.getByTestId("studio-chat-tool-call")).toContainText("add_layer");

      // The orchestrator's server round trip is async and fired from an
      // event listener (fire-and-forget from the chat element's point of
      // view) — poll for the composition state it produces.
      await expect
        .poll(() => page.evaluate(() => window.__honuaStudioApp.composition.state.layers.map((l) => l.id)))
        .toEqual(["hi-parcels"]);

      // The canvas applies the command optimistically before the MCP response
      // advances the authoritative concurrency token. Wait for that response,
      // too, so the check below proves the server mutation rather than racing
      // the optimistic paint.
      await expect
        .poll(() => page.evaluate(() => window.__honuaStudioApp.toolCallOrchestrator.generation))
        .toBeGreaterThan(1);

      // Proves a REAL server draft exists (not just local reducer state):
      // draftId/generation only exist once an actual honua_studio_create_draft
      // + honua_studio_add_layer round trip landed.
      const afterFirstCall = await page.evaluate(() => ({
        draftId: window.__honuaStudioApp.toolCallOrchestrator.draftId,
        generation: window.__honuaStudioApp.toolCallOrchestrator.generation,
      }));
      expect(afterFirstCall.draftId).toBeTruthy();
      expect(afterFirstCall.generation).toBeGreaterThan(1);

      await page.evaluate(() =>
        window.__honuaStudioChat.sendMessage("Now add a chart showing the count of parcels by zoning code."),
      );
      await expect(page.getByTestId("studio-chat-tool-call")).toHaveCount(2);

      await expect
        .poll(() => page.evaluate(() => window.__honuaStudioApp.composition.state.widgets.map((w) => w.id)))
        .toEqual(["chart-hi-parcels-zoning_code"]);

      const afterSecondCall = await page.evaluate(() => window.__honuaStudioApp.toolCallOrchestrator.generation);
      expect(afterSecondCall).toBeGreaterThan(afterFirstCall.generation);

      // The canvas readout (honua-studio#8) reflects the server-confirmed state.
      await expect(page.getByTestId("studio-canvas-layers")).toContainText("hi-parcels");
      await expect(page.getByTestId("studio-canvas-widgets")).toContainText("chart-hi-parcels-zoning_code");

      // Every tool call resolved and applied — nothing silently dropped.
      const rejectedEntries = await page.evaluate(() =>
        window.__honuaStudioChat.activityLog.entries().filter((entry) => entry.type === "composition_command_rejected"),
      );
      expect(rejectedEntries).toEqual([]);
    } finally {
      await preview.close();
      await mock.close();
    }
  });
});
