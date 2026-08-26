/**
 * LIVE-server journeys (@live): the same shell + element kit every mock
 * journey drives, pointed at a REAL deployed honua-server (e.g.
 * https://demo.honua.io) instead of `mock-server.mjs`. Gated behind env
 * vars so CI without credentials skips the whole file — the same
 * "explicitly enabled, otherwise a no-op" posture honua-sdk-js uses for its
 * network-gated suites:
 *
 *   HONUA_LIVE_BASE_URL   the server's REST /api root, e.g. https://demo.honua.io/api
 *   HONUA_LIVE_API_KEY    admin API key; injected server-side by the vite
 *                         preview proxy as `X-API-Key` (see vite.config.ts —
 *                         the key never reaches client code or the bundle)
 *
 * Run:
 *   HONUA_LIVE_BASE_URL=https://demo.honua.io/api \
 *   HONUA_LIVE_API_KEY=<admin key> \
 *   npm run test:browser:live
 *
 * What runs live here (and why the rest doesn't):
 *  - boot: `--mode live` against the real server, plus an in-browser probe
 *    of the AI proxy's capabilities route through the /api proxy path.
 *  - package lifecycle: the full browse -> open -> version -> compare ->
 *    publish-confirm journey of lifecycle-journey.spec.mjs against the real
 *    lifecycle store (real validator — the seeded body is a schema-valid
 *    honua_map_package.v1, since the real server REJECTS publishing invalid
 *    bodies, unlike the permissive mock fixture).
 *  - chat: one REAL model turn through `<honua-studio-chat>`'s default
 *    SseChatTransport against POST /v1/studio/ai/chat (Bedrock behind the
 *    deployed proxy) — asserts streamed text renders, not what the model says
 *    beyond the pinned one-word instruction.
 *  - MCP compose: the compose-districts-map fixture conversation (chat side
 *    deliberately stays scripted, exactly as mcp-compose-journey.spec.mjs
 *    documents) flowing through the REAL /mcp endpoint's honua_studio_*
 *    tools at the server origin. Additionally gated behind
 *    HONUA_LIVE_MCP_ENABLED=true — see the in-test note on the demo
 *    deployment's MCP session-affinity bug.
 *  - NOT live: catalog/packages boot assertions (GET /v1/studio/catalog and
 *    /v1/studio/packages are not part of the deployed server surface — the
 *    mock fixture models a future enumeration shape) and the GP job routes
 *    (/v1/studio/gp-jobs is fixture-only today).
 *
 * Residue note: the deployed lifecycle store has no content-item delete
 * route, so each run leaves one `studio-e2e-live-*` content item + versions
 * behind on the target environment (drafts ARE deleted). Keys are
 * timestamped and greppable.
 */
import { expect, test } from "@playwright/test";

import { startPreviewServer } from "./helpers.mjs";

const LIVE_BASE_URL = process.env.HONUA_LIVE_BASE_URL?.replace(/\/$/, "");
const LIVE_API_KEY = process.env.HONUA_LIVE_API_KEY;

test.describe("live demo-server journeys @live", () => {
  test.skip(
    !LIVE_BASE_URL || !LIVE_API_KEY,
    "Live journeys are gated: set HONUA_LIVE_BASE_URL and HONUA_LIVE_API_KEY to run against a real honua-server.",
  );

  // Real network + a real model turn — give every live test generous room.
  test.slow();

  /** Direct REST call to the live server (seeding/verification/cleanup), authenticated the way the deployment actually accepts: X-API-Key. */
  async function restCall(method, path, body) {
    const response = await fetch(`${LIVE_BASE_URL}${path}`, {
      method,
      headers: { "x-api-key": LIVE_API_KEY, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      throw new Error(`Live server responded ${response.status} for ${method} ${path}: ${await response.text()}`);
    }
    const json = await response.json();
    return json.data;
  }

  function startLivePreview() {
    return startPreviewServer({ HONUA_BASE_URL: LIVE_BASE_URL, HONUA_API_KEY: LIVE_API_KEY }, ["--mode", "live"]);
  }

  /** A body the REAL server's honua_map_package.v1 validator accepts (the mock's permissive `{layers,view,widgets}` shape is invalid there, and the real server refuses to publish invalid bodies). */
  function validMapBody(packageKey, extra = {}) {
    return {
      mapPackageId: packageKey,
      format: "honua_map_package.v1",
      status: "draft",
      createdAt: new Date().toISOString(),
      initialView: { bbox: [-160.6, 18.7, -154.5, 22.5], crs: "EPSG:4326" },
      ...extra,
    };
  }

  async function injectHostSession(page) {
    // Host-adapter session injected BEFORE any Studio code runs (the
    // docs/embed-session.md `window.__HONUA_STUDIO_HOST_SESSION__` path,
    // exactly as host-adapter-boot.spec.mjs drives it) — a post-load
    // `app.session = …` assignment would be too late for the chat console,
    // which resolves its auth at connect time and would otherwise fall back
    // to the standalone OIDC flow no real deployment serves at /oidc. The
    // bearer this yields is a placeholder — the deployed server
    // authenticates off the proxy-injected X-API-Key (vite.config.ts) and
    // ignores the bearer.
    await page.addInitScript(() => {
      window.__HONUA_STUDIO_HOST_SESSION__ = {
        async getToken() {
          return "live-proxy-placeholder";
        },
        onExpired(_listener) {
          return () => {};
        },
      };
    });
  }

  test("boot: app boots in --mode live against the real server; the AI proxy capabilities route answers through the /api proxy path", async ({
    page,
  }) => {
    const preview = await startLivePreview();
    try {
      await page.goto(preview.url);

      await expect(page.getByTestId("app-shell")).toBeVisible();
      // REQ-001 posture holds against a real server too: signed out, no
      // anonymous catalog access attempted.
      await expect(page.getByTestId("catalog-signed-out")).toBeVisible();

      // End-to-end proof of the live wiring itself: browser -> relative
      // /api path -> vite proxy (key injected server-side) -> deployed
      // Studio AI proxy.
      const capabilities = await page.evaluate(async () => {
        const response = await fetch("/api/v1/studio/ai/capabilities", { headers: { accept: "application/json" } });
        return { status: response.status, body: await response.json() };
      });
      expect(capabilities.status).toBe(200);
      expect(capabilities.body.success).toBe(true);
      expect(capabilities.body.data.enabled).toBe(true);
      expect(capabilities.body.data.providers.length).toBeGreaterThan(0);
      expect(capabilities.body.data.defaultProvider).toBeTruthy();
    } finally {
      await preview.close();
    }
  });

  test("package lifecycle: browse -> open -> version -> compare -> publish-confirm against the REAL lifecycle store", async ({
    page,
  }) => {
    const packageKey = `studio-e2e-live-${Date.now()}`;
    const preview = await startLivePreview();
    let draftId;
    try {
      // Seed a schema-valid draft, as lifecycle-journey.spec.mjs seeds its
      // mock one (draft creation is agent/editor scope, not this panel's).
      const seeded = await restCall("POST", "/v1/studio/package-drafts", {
        packageKey,
        envelope: {
          family: "map",
          schemaVersion: "1.0",
          format: "honua_map_package.v1",
          body: validMapBody(packageKey),
        },
      });
      draftId = seeded.draftId;

      await injectHostSession(page);
      await page.goto(preview.url);
      await expect(page.getByTestId("app-shell")).toBeVisible();

      await page.getByTestId("nav-content").click();
      await expect(page.getByTestId("content-route")).toBeVisible();
      await expect(page.getByTestId("content-browser")).toBeVisible();

      // The live store is persistent and shared — filter down to this run's
      // unique key instead of assuming a single-row store like the mock's.
      await page.getByTestId("content-browser-search").fill(packageKey);
      await expect(page.getByTestId("draft-row")).toHaveCount(1);
      await expect(page.getByTestId("draft-row")).toContainText(packageKey);

      await page.getByTestId("draft-open").click();
      await expect(page.getByTestId("content-route-panel")).toBeVisible();
      await expect(page.getByTestId("lifecycle-panel-generation")).toContainText("1");
      // The REAL validator accepted the seeded body — publish depends on it.
      await expect(page.getByTestId("lifecycle-panel-validation-status")).toContainText("valid");

      // Version: v1 from the seeded body.
      await page.getByTestId("lifecycle-panel-save-version").click();
      await expect(page.getByTestId("lifecycle-version-row")).toHaveCount(1);

      // Edit via direct REST (no body-editor UI in the panel's scope; the
      // save-version above advanced the draft generation, so re-read first).
      const draftAfterV1 = await restCall("GET", `/v1/studio/package-drafts/${draftId}`);
      await restCall("PUT", `/v1/studio/package-drafts/${draftId}`, {
        packageKey,
        envelope: {
          ...draftAfterV1.envelope,
          body: validMapBody(packageKey, { themeId: "live-journey-dark" }),
        },
        generation: draftAfterV1.generation,
      });

      // Version: v2 through the SAME open panel, no reload.
      await page.getByTestId("lifecycle-panel-save-version").click();
      await expect(page.getByTestId("lifecycle-version-row")).toHaveCount(2);

      // Compare v1 vs v2 — the real comparison endpoint flags the content change.
      await page.getByTestId("lifecycle-compare-left").nth(0).check();
      await page.getByTestId("lifecycle-compare-right").nth(1).check();
      await page.getByTestId("lifecycle-compare-button").click();
      await expect(page.getByTestId("lifecycle-comparison")).toBeVisible();
      await expect(page.getByTestId("lifecycle-comparison-changes")).toContainText("content");

      // Publish-confirm: the human gate, then a REAL publish.
      await page.getByTestId("lifecycle-version-row").nth(1).getByTestId("lifecycle-version-publish").click();
      await expect(page.getByTestId("lifecycle-confirm-dialog")).toBeVisible();
      const submit = page.getByTestId("lifecycle-confirm-submit");
      await expect(submit).toBeDisabled();
      await page.getByTestId("lifecycle-confirm-input").fill("wrong-key");
      await expect(submit).toBeDisabled();
      await page.getByTestId("lifecycle-confirm-input").fill(packageKey);
      await expect(submit).toBeEnabled();
      await submit.click();

      await expect(page.getByTestId("lifecycle-confirm-dialog")).toBeHidden();
      await expect(page.getByTestId("lifecycle-panel-message")).toContainText("Published");

      // Independent of the UI: the REAL store now shows the item published.
      const items = await restCall("GET", `/v1/studio/content-items?q=${encodeURIComponent(packageKey)}`);
      expect(items.items).toHaveLength(1);
      expect(items.items[0].state).toBe("published");
    } finally {
      if (draftId) {
        // Drafts are deletable; the published item/versions are not (see the
        // module doc's residue note).
        await restCall("DELETE", `/v1/studio/package-drafts/${draftId}`).catch(() => {});
      }
      await preview.close();
    }
  });

  test("chat: one real model turn streams through the shell's default SSE transport and renders", async ({ page }) => {
    // A real LLM round trip — bound it well above the proxy's observed
    // latency but below anything pathological.
    test.setTimeout(180_000);
    const preview = await startLivePreview();
    try {
      await injectHostSession(page);
      await page.goto(preview.url);
      await expect(page.getByTestId("studio-chat")).toBeVisible();

      await page.evaluate(() =>
        window.__honuaStudioChat.sendMessage('Reply with exactly the single lowercase word "aloha" and nothing else.'),
      );

      const assistantMessage = page.locator('[data-testid="studio-chat-message"][data-role="assistant"]');
      await expect(assistantMessage).toHaveCount(1);
      // The stream completed (message_stop arrived) …
      await expect(assistantMessage).toHaveAttribute("data-status", "complete", { timeout: 120_000 });
      // … streamed text rendered …
      await expect(assistantMessage.getByTestId("studio-chat-message-text")).toContainText("aloha");
      // … and the composer is usable again.
      await expect(page.getByTestId("studio-chat-input")).toBeEnabled();
      expect(await page.evaluate(() => window.__honuaStudioChat.streaming)).toBe(false);
    } finally {
      await preview.close();
    }
  });

  test("real model turn: declared server tools mutate the authoritative draft and canvas", async ({ page }) => {
    test.skip(
      process.env.HONUA_LIVE_MCP_ENABLED !== "true",
      "Requires the live deployment's MCP session affinity; set HONUA_LIVE_MCP_ENABLED=true once available.",
    );
    test.setTimeout(180_000);
    const packageKey = `studio-e2e-live-agent-${Date.now()}`;
    const preview = await startLivePreview();
    let draftId;
    try {
      await injectHostSession(page);
      await page.goto(preview.url);
      await expect(page.getByTestId("studio-chat")).toBeVisible();

      await page.evaluate((key) => {
        // The deployed demo does not yet expose Studio's catalog-list route;
        // seed the same known live dataset descriptor the eventual discovery
        // response supplies so the system prompt remains grounded.
        window.__honuaStudioApp.sourceCatalog = [
          { id: "hi-parcels", title: "Hawaii parcels", protocol: "ogc-features", geometryType: "Polygon" },
        ];
        window.__honuaStudioApp.enableLiveComposition({
          baseUrl: "",
          packageKey: key,
          family: "map",
          schemaVersion: "1.0",
        });
      }, packageKey);
      await expect.poll(() => page.evaluate(() => Boolean(window.__honuaStudioChat.agentSession))).toBe(true);

      const before = await page.evaluate(() => window.__honuaStudioApp.toolCallOrchestrator.generation);
      await page.evaluate(() =>
        window.__honuaStudioChat.sendMessage("Add the hi-parcels layer and set the map view to zoom 8."),
      );

      await expect
        .poll(() => page.evaluate(() => window.__honuaStudioApp.composition.state.layers.map((layer) => layer.id)), {
          timeout: 120_000,
        })
        .toContain("hi-parcels");
      await expect(page.getByTestId("studio-canvas-layers")).toContainText("hi-parcels");
      const after = await page.evaluate(() => ({
        draftId: window.__honuaStudioApp.toolCallOrchestrator.draftId,
        generation: window.__honuaStudioApp.toolCallOrchestrator.generation,
        messages: window.__honuaStudioChat.agentSession.messages,
      }));
      draftId = after.draftId;
      expect(after.generation).toBeGreaterThan(before);
      expect(after.messages.some((message) => message.role === "tool")).toBe(true);

      const stored = await restCall("GET", `/v1/studio/package-drafts/${draftId}`);
      expect(stored.generation).toBe(after.generation);
      expect(stored.envelope.body.layers.map((layer) => layer.id)).toContain("hi-parcels");
    } finally {
      if (draftId) await restCall("DELETE", `/v1/studio/package-drafts/${draftId}`).catch(() => {});
      await preview.close();
    }
  });

  test("MCP compose: fixture-scripted tool-call intents mutate a REAL server-side draft via the deployed honua_studio_* tools", async ({
    page,
  }) => {
    // KNOWN SERVER BUG (demo deployment, 2026-07-25): honua-server's MCP
    // Streamable HTTP session store is in-memory per instance, and the demo
    // environment runs multiple Lambda containers with no sticky routing or
    // shared store — a session minted by `initialize` on one container 404s
    // on `tools/call` when the follow-up request lands on another.
    // Reproduced outside the browser entirely: initialize -> capture
    // Mcp-Session-Id -> serial reuse works (200), but after a burst of 4
    // concurrent requests (spinning up more containers) the SAME session id
    // 404s on the next call. Session-LESS tools/call works fine (that's how
    // the deployed honua_studio_* tools were verified). The journey itself
    // is correct — opt in explicitly once the deployment gets sticky
    // sessions or a shared session store.
    test.skip(
      process.env.HONUA_LIVE_MCP_ENABLED !== "true",
      "Blocked on a demo-server bug: MCP sessions are per-container in-memory and 404 across Lambda instances. Set HONUA_LIVE_MCP_ENABLED=true to run anyway.",
    );
    const packageKey = `studio-e2e-live-mcp-${Date.now()}`;
    const preview = await startLivePreview();
    let draftId;
    try {
      await page.addInitScript(() => {
        window.__honuaStudioChatFixtureConversationId = "compose-districts-map";
      });
      await injectHostSession(page);
      await page.goto(preview.url);
      await expect(page.getByTestId("studio-chat")).toBeVisible();

      // baseUrl "" -> the MCP client posts to the page-relative /mcp, which
      // vite.config.ts proxies to the SERVER ORIGIN's /mcp (the deployed
      // endpoint lives at the root, outside the REST /api prefix).
      await page.evaluate((key) => {
        window.__honuaStudioApp.enableLiveComposition({
          baseUrl: "",
          packageKey: key,
          family: "map",
          schemaVersion: "1.0",
        });
      }, packageKey);

      await page.evaluate(() =>
        window.__honuaStudioChat.sendMessage("Add the Hawai'i statewide parcels layer and style it by district."),
      );
      await expect(page.getByTestId("studio-chat-tool-call")).toContainText("add_layer");
      await expect
        .poll(() => page.evaluate(() => window.__honuaStudioApp.composition.state.layers.map((l) => l.id)), {
          timeout: 30_000,
        })
        .toEqual(["hi-parcels"]);

      const afterFirstCall = await page.evaluate(() => ({
        draftId: window.__honuaStudioApp.toolCallOrchestrator.draftId,
        generation: window.__honuaStudioApp.toolCallOrchestrator.generation,
      }));
      expect(afterFirstCall.draftId).toBeTruthy();
      expect(afterFirstCall.generation).toBeGreaterThan(1);
      draftId = afterFirstCall.draftId;

      await page.evaluate(() =>
        window.__honuaStudioChat.sendMessage("Now add a chart showing the count of parcels by zoning code."),
      );
      await expect(page.getByTestId("studio-chat-tool-call")).toHaveCount(2);
      await expect
        .poll(() => page.evaluate(() => window.__honuaStudioApp.composition.state.widgets.map((w) => w.id)), {
          timeout: 30_000,
        })
        .toEqual(["chart-hi-parcels-zoning_code"]);

      // The canvas readout reflects the server-confirmed state.
      await expect(page.getByTestId("studio-canvas-layers")).toContainText("hi-parcels");
      await expect(page.getByTestId("studio-canvas-widgets")).toContainText("chart-hi-parcels-zoning_code");

      // Nothing silently dropped.
      const rejectedEntries = await page.evaluate(() =>
        window.__honuaStudioChat.activityLog.entries().filter((entry) => entry.type === "composition_command_rejected"),
      );
      expect(rejectedEntries).toEqual([]);

      // Independent of the UI: the REAL deployed store holds the composed draft.
      const draft = await restCall("GET", `/v1/studio/package-drafts/${draftId}`);
      expect(draft.envelope.body.layers.map((l) => l.id)).toEqual(["hi-parcels"]);
      expect(draft.envelope.body.widgets.map((w) => w.id)).toEqual(["chart-hi-parcels-zoning_code"]);
    } finally {
      if (draftId) {
        await restCall("DELETE", `/v1/studio/package-drafts/${draftId}`).catch(() => {});
      }
      await preview.close();
    }
  });
});
