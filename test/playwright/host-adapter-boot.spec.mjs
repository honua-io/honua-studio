/**
 * Embed host-adapter boot (honua-studio#4 REQ-003, docs/embed-session.md).
 * Injects `window.__HONUA_STUDIO_HOST_SESSION__` before any Studio code
 * runs — via `page.addInitScript`, a plain inline object, deliberately
 * *not* the TypeScript fixture in src/auth/, to prove the contract really
 * is structural (any object with the right shape works, not just ours).
 * Asserts the load-bearing REQ-003 guarantee: Studio never initiates its
 * own auth flow in this mode — no navigation to an authorize endpoint, no
 * sign-in/sign-out controls rendered at all.
 */
import { expect, test } from "@playwright/test";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { startPreviewServer } from "./helpers.mjs";

test("host-adapter mode loads the catalog with the host's token and never renders its own auth controls", async ({
  page,
}) => {
  const mock = await startMockServer();
  const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
  const hostToken = mintFixtureAccessToken();
  const navigations = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest()) navigations.push(request.url());
  });

  try {
    await page.addInitScript((token) => {
      window.__HONUA_STUDIO_HOST_SESSION__ = {
        async getToken() {
          return token;
        },
        onExpired(_listener) {
          return () => {};
        },
      };
    }, hostToken);

    await page.goto(preview.url);

    await expect(page.getByTestId("app-shell")).toBeVisible();
    // No interactive auth controls at all in host-adapter mode — only a status label.
    await expect(page.getByTestId("auth-signin")).toHaveCount(0);
    await expect(page.getByTestId("auth-signout")).toHaveCount(0);
    await expect(page.getByTestId("auth-status")).toHaveText("Signed in");

    await expect(page.getByTestId("catalog-error")).toHaveCount(0);
    await expect(page.getByTestId("catalog-list")).toContainText("Hawai'i statewide parcels");
    await expect(page.getByTestId("packages-list")).toContainText("Statewide roads condition dashboard");

    // The one navigation is the initial page load — never a redirect to an
    // OIDC authorize endpoint (which would show up as a second navigation).
    expect(navigations).toHaveLength(1);
  } finally {
    await preview.close();
    await mock.close();
  }
});

test("host-adapter mode surfaces expiry via the host's onExpired callback, still without redirecting", async ({
  page,
}) => {
  const mock = await startMockServer();
  const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
  const hostToken = mintFixtureAccessToken();

  try {
    await page.addInitScript((token) => {
      window.__HONUA_STUDIO_HOST_SESSION__ = {
        async getToken() {
          return token;
        },
        onExpired(listener) {
          window.__triggerHostExpired = listener;
          return () => {};
        },
      };
    }, hostToken);

    await page.goto(preview.url);
    await expect(page.getByTestId("catalog-list")).toContainText("Hawai'i statewide parcels");

    await page.evaluate(() => window.__triggerHostExpired?.());

    await expect(page.getByTestId("auth-status")).toHaveText("Session expired");
    await expect(page.getByTestId("auth-signin")).toHaveCount(0);
    // Still on the app's own origin — an expiry event never redirects anywhere.
    expect(new URL(page.url()).origin).toBe(new URL(preview.url).origin);
    expect(new URL(page.url()).search).toBe("");
  } finally {
    await preview.close();
    await mock.close();
  }
});
