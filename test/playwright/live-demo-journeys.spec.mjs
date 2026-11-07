/** Live deployment checks leave timestamped content items; drafts are deleted after each test. */
import { expect, test } from "@playwright/test";

import { startPreviewServer } from "./helpers.mjs";
import { approveLivePublication, selectLiveModel } from "./live-journey-contract.mjs";

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

  async function routeApprovedModel(page, requiredCapabilities) {
    const capabilities = await restCall("GET", "/v1/studio/ai/capabilities");
    const provider = selectLiveModel(capabilities, requiredCapabilities);
    await page.route("**/v1/studio/ai/chat", (route) =>
      route.continue({
        postData: JSON.stringify({
          ...route.request().postDataJSON(),
          provider: provider.provider,
          model: provider.model,
        }),
      }),
    );
    return provider;
  }

  async function verifyHumanPublication(page, publishResponse, { packageKey, versionId }) {
    const response = await publishResponse;
    expect(response.status()).toBe(202);
    const payload = await response.json();
    expect(payload.success).toBe(true);
    const pending = payload.data;
    expect(pending.status).toBe(4);
    expect(pending.proposalId).toBeTruthy();
    expect(pending.resourceIds.versionId).toBe(versionId);
    await expect(page.getByTestId("lifecycle-panel-message")).toContainText("awaiting separate human approval");
    const before = await restCall("GET", `/v1/studio/content-items?q=${encodeURIComponent(packageKey)}`);
    expect(before.items).toHaveLength(1);
    expect(before.items[0].state).not.toBe("published");
    expect(before.items[0].publishedVersionId).toBeFalsy();
    const approved = await approveLivePublication(
      LIVE_BASE_URL,
      pending.proposalId,
      process.env.HONUA_LIVE_HUMAN_TOKEN,
    );
    expect(approved.proposalId).toBe(pending.proposalId);
    expect(approved.status).toBe("Succeeded");
    const { itemId, requestId } = pending.resourceIds;
    expect(itemId).toBe(before.items[0].itemId);
    expect(requestId).toBeTruthy();
    const receipt = await restCall(
      "GET",
      `/v1/studio/content-items/${itemId}/versions/${versionId}/publish-requests/${requestId}`,
    );
    expect(receipt.status).toBe("accepted");
    expect(receipt.versionId).toBe(versionId);
    const after = await restCall("GET", `/v1/studio/content-items?q=${encodeURIComponent(packageKey)}`);
    expect(after.items).toHaveLength(1);
    expect(after.items[0]).toMatchObject({ state: "published", publishedVersionId: versionId });
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
      const version = page.getByTestId("lifecycle-version-row").nth(1);
      const versionId = await version.getAttribute("data-version-id");
      expect(versionId).toBeTruthy();
      await version.getByTestId("lifecycle-version-publish").click();
      await expect(page.getByTestId("lifecycle-confirm-dialog")).toBeVisible();
      const submit = page.getByTestId("lifecycle-confirm-submit");
      await expect(submit).toBeDisabled();
      await page.getByTestId("lifecycle-confirm-input").fill("wrong-key");
      await expect(submit).toBeDisabled();
      await page.getByTestId("lifecycle-confirm-input").fill(packageKey);
      await expect(submit).toBeEnabled();
      const publishResponse = page.waitForResponse(
        (response) => response.request().method() === "POST" && response.url().endsWith("/publish-requests"),
      );
      await submit.click();

      await expect(page.getByTestId("lifecycle-confirm-dialog")).toBeHidden();
      await verifyHumanPublication(page, publishResponse, { packageKey, versionId });
    } finally {
      if (draftId) {
        // The live store has no content-item or immutable-version delete route.
        await restCall("DELETE", `/v1/studio/package-drafts/${draftId}`).catch(() => {});
      }
      await preview.close();
    }
  });

  test("chat: one real model turn streams through the shell's default SSE transport and renders", async ({ page }) => {
    test.setTimeout(180_000);
    const preview = await startLivePreview();
    try {
      await routeApprovedModel(page);
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
    test.setTimeout(180_000);
    const packageKey = `studio-e2e-live-agent-${Date.now()}`;
    const preview = await startLivePreview();
    let draftId;
    try {
      await routeApprovedModel(page, ["streaming", "toolSupport"]);
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
