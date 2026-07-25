/**
 * Blazor Web App test host spec (honua-studio#5; harness/blazor-host,
 * harness/blazor-host/README.md § Findings). Drives the four hazards the
 * issue's P1-4 adversarial finding calls out — a bare static harness can't
 * reproduce any of these:
 *
 *  1. Navigation must not silently destroy the mounted element without
 *     recovery — empirically it DOES get wiped (see the README's Findings
 *     section for the full story), so what this actually proves is clean,
 *     bounded, session-preserving SELF-HEALING: exactly one remount per
 *     navigation, the old instance's disconnectedCallback ran (no leaked
 *     canvas/observer), the new instance's session is re-injected.
 *  2. Render-mode re-instantiation must not leak or double-register.
 *  3. Router URL ownership: the element requests, Blazor's router decides.
 *  4. Focus must not be stolen by an unrelated interactive DOM patch.
 *
 * Requires the Studio client bundle + the .NET project already built:
 *   npm run build:blazor-assets
 *   dotnet build harness/blazor-host/StudioHost/StudioHost.csproj
 * (see harness/blazor-host/README.md — `npm run test:browser:blazor` does both).
 */
import { expect, test } from "@playwright/test";

import { startBlazorHost } from "./helpers.mjs";

test.describe("Blazor Web App test host (harness/blazor-host) @blazor", () => {
  /** @type {Awaited<ReturnType<typeof startBlazorHost>>} */
  let host;

  test.beforeAll(async () => {
    host = await startBlazorHost();
  });

  test.afterAll(async () => {
    await host.close();
  });

  test("mounts honua-studio-app in the persistent layout region with a fixture session", async ({ page }) => {
    await page.goto(`${host.url}/studio`);
    await expect(page.getByTestId("studio-host")).toBeVisible();
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByTestId("studio-chat-session-status")).toHaveText("Signed in");
    const mountCount = await page.evaluate(() => window.__honuaStudioMountCount);
    expect(mountCount).toBe(1);
  });

  test("hazard 1 — navigation between two Blazor pages self-heals in exactly one clean remount, never a leak", async ({
    page,
  }) => {
    await page.goto(`${host.url}/studio`);
    await expect(page.getByTestId("app-shell")).toBeVisible();

    const mountToken = await page.locator("honua-studio-app").getAttribute("data-mount-token");
    expect(mountToken).toBeTruthy();
    const canvasCountBefore = await page.evaluate(() => window.HonuaStudioCanvasElement.instanceCount);

    await page.getByTestId("blazor-nav-second").click();
    await expect(page).toHaveURL(/\/studio\/about$/);
    await expect(page.getByTestId("second-page-heading")).toBeVisible();

    // README § Findings: Blazor Web App's interactive-circuit navigation
    // wipes the mounted element regardless of where it lives in the DOM —
    // harness/blazor-host-src/mount.ts's MutationObserver watchdog detects
    // that and remounts. This asserts the remount is clean and bounded, not
    // a leak: a NEW element (different mount token) exists, exactly one
    // remount happened (not a retry storm), and the canvas placeholder's
    // live instance count is back to exactly what it was — proving the OLD
    // instance's disconnectedCallback fully ran before/alongside the new
    // one's connectedCallback, with nothing left dangling in between.
    await expect(page.locator("honua-studio-app")).toBeVisible();
    await expect.poll(() => page.locator("honua-studio-app").getAttribute("data-mount-token")).not.toBe(mountToken);
    const mountCountAfterNav = await page.evaluate(() => window.__honuaStudioMountCount);
    expect(mountCountAfterNav).toBe(2);
    await expect.poll(() => page.evaluate(() => window.HonuaStudioCanvasElement.instanceCount)).toBe(canvasCountBefore);

    // The new instance is fully configured, not a bare shell: session
    // re-injected, current route re-derived from the URL Blazor settled on.
    await expect(page.getByTestId("studio-chat-session-status")).toHaveText("Signed in");
  });

  test("hazard 2 — render-mode re-instantiation (conditional interactive-server rendering) never leaks or double-registers", async ({
    page,
  }) => {
    await page.goto(`${host.url}/studio`);
    await expect(page.getByTestId("render-mode-lab")).toBeVisible();
    // The lab's markup (toggle included) is statically prerendered before
    // the interactive-server circuit attaches, and a click in that window
    // is silently dropped — the CI-observed flake where the "Add canvas"
    // click no-opped and the canvas slot never appeared. Wait for the
    // component's own "my event handlers are live" signal (set from
    // OnAfterRender, which never runs during prerender) before toggling.
    await expect(page.getByTestId("render-mode-lab")).toHaveAttribute("data-interactive", "true");

    const baseline = await page.evaluate(() => window.HonuaStudioCanvasElement.instanceCount);
    const toggle = page.getByTestId("toggle-canvas");

    for (let cycle = 0; cycle < 3; cycle += 1) {
      await toggle.click(); // add
      await expect(page.getByTestId("render-mode-canvas-slot")).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.HonuaStudioCanvasElement.instanceCount)).toBe(baseline + 1);

      await toggle.click(); // remove
      await expect(page.getByTestId("render-mode-canvas-slot")).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => window.HonuaStudioCanvasElement.instanceCount)).toBe(baseline);
    }
  });

  test("hazard 3 — URL ownership handoff: the element requests, Blazor's router decides and reflects back", async ({
    page,
  }) => {
    await page.goto(`${host.url}/studio`);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    await expect(page.getByTestId("about-section")).toHaveCount(0);

    // Clicking the element's OWN internal nav (routing-mode="host") must
    // never touch window.location directly — it only dispatches
    // honua-studio-navigate; harness/blazor-host-src/mount.ts's listener is
    // what actually calls Blazor.navigateTo().
    await page.getByTestId("nav-about").click();

    // Blazor's router made the call: the URL actually changed to its own
    // real "/studio/about" route (not honua-studio-app's internal "/about" —
    // base-path re-prefixing is exactly what proves the handoff happened).
    await expect(page).toHaveURL(/\/studio\/about$/);
    await expect(page.getByTestId("second-page-heading")).toBeVisible(); // Blazor's own page rendered

    // Round trip closed: Blazor's enhanced-nav "enhancedload" event told the
    // element its new current path, which it stripped back down to its own
    // "/about" and rendered.
    await expect(page.getByTestId("about-section")).toBeVisible();
  });

  test("hazard 4 — focus is not stolen by an unrelated interactive-server DOM patch", async ({ page }) => {
    await page.goto(`${host.url}/studio`);
    await expect(page.getByTestId("render-mode-lab")).toBeVisible();

    const chatInput = page.getByTestId("studio-chat-input");
    await chatInput.click();
    await expect(chatInput).toBeFocused();

    const clock = page.getByTestId("clock");
    const readingBefore = await clock.textContent();
    // Wait through two live-clock re-renders (StateHasChanged() on an
    // unrelated part of the page, driven by the interactive-server circuit)
    // — a real analogue of the SSR-patch hazard, just via the interactive
    // pathway instead of enhanced navigation (see hazard 1 for that one).
    await expect.poll(() => clock.textContent()).not.toBe(readingBefore);
    const readingAfterFirstTick = await clock.textContent();
    await expect.poll(() => clock.textContent()).not.toBe(readingAfterFirstTick);

    await expect(chatInput).toBeFocused();
  });
});
