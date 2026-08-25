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

  test("a TOC visibility toggle round-trips through honua_studio_set_layer_visibility and survives a draft sync", async ({
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

      await page.evaluate((token) => {
        window.__honuaStudioApp.session = { getToken: async () => token, onExpired: () => () => {} };
        window.__honuaStudioApp.enableLiveComposition({
          baseUrl: "/api",
          packageKey: "pkg-mcp-visibility-journey",
          family: "map",
          schemaVersion: "1",
        });
      }, token);

      await page.evaluate(() =>
        window.__honuaStudioChat.sendMessage("Add the Hawai'i statewide parcels layer and style it by district."),
      );
      await expect
        .poll(() => page.evaluate(() => window.__honuaStudioApp.composition.state.layers.map((l) => l.id)))
        .toEqual(["hi-parcels"]);

      // A TOC, then the real checkbox — no test-only command path.
      await page.evaluate(() =>
        window.__honuaStudioApp.toolCallOrchestrator.handleToolCall({
          toolName: "addWidget",
          arguments: { widget: { id: "layers", kind: "toc", title: "Layers" } },
        }),
      );
      await expect(page.getByTestId("studio-widget-toc-row")).toHaveCount(1);

      const beforeToggle = await page.evaluate(() => window.__honuaStudioApp.toolCallOrchestrator.generation);
      await page.getByTestId("studio-widget-toc-toggle").first().uncheck();

      // The toggle is a server round trip now: the draft's generation moves,
      // which a client-local mutation could never do.
      await expect
        .poll(() => page.evaluate(() => window.__honuaStudioApp.toolCallOrchestrator.generation), { timeout: 20_000 })
        .toBeGreaterThan(beforeToggle);
      await expect
        .poll(() => page.evaluate(() => window.__honuaStudioApp.composition.state.layers[0]?.visible))
        .toBe(false);

      // An unrelated composition mutation syncs the draft — the exact
      // sequence that used to bring a hidden layer back (honua-studio#31).
      await page.evaluate(() =>
        window.__honuaStudioApp.toolCallOrchestrator.handleToolCall({
          toolName: "setView",
          arguments: { view: { zoom: 9 } },
        }),
      );
      await expect.poll(() => page.evaluate(() => window.__honuaStudioApp.composition.state.view.zoom)).toBe(9);
      expect(await page.evaluate(() => window.__honuaStudioApp.composition.state.layers[0]?.visible)).toBe(false);

      // …and the SERVER is what says so. Read the draft straight off the
      // fixture's REST surface — the same store `/mcp` writes through.
      const draftId = await page.evaluate(() => window.__honuaStudioApp.toolCallOrchestrator.draftId);
      const response = await fetch(`${mock.url}/v1/studio/package-drafts/${draftId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const stored = await response.json();
      expect(stored.data.envelope.body.layers).toEqual([expect.objectContaining({ id: "hi-parcels", visible: false })]);

      // Re-showing it round-trips too, and the map follows.
      await page.getByTestId("studio-widget-toc-toggle").first().check();
      await expect
        .poll(() => page.evaluate(() => window.__honuaStudioApp.composition.state.layers[0]?.visible), {
          timeout: 20_000,
        })
        .toBe(true);

      const rejected = await page.evaluate(() =>
        window.__honuaStudioChat.activityLog.entries().filter((entry) => entry.type === "composition_command_rejected"),
      );
      expect(rejected).toEqual([]);
    } finally {
      await preview.close();
      await mock.close();
    }
  });
});
