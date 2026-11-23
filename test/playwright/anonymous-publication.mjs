import { expect } from "@playwright/test";
import { publishedRouteLinks } from "../../scripts/lib/live-approval-config.mjs";

export async function verifyAnonymousPublication(browser, { consoleUrl, route, itemId, versionId, requestId }) {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const links = publishedRouteLinks(consoleUrl, route);
  try {
    const response = await context.request.get(links.definition, {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(200);
    const wire = await response.json();
    expect(wire.success).toBe(true);
    expect(wire.data).toMatchObject({ itemId, versionId, publicationId: requestId, visibility: "public" });
    expect(wire.data.family).toBe("map");
    expect(Array.isArray(wire.data.envelope?.body?.layers)).toBe(true);
    const page = await context.newPage();
    const url = links.map;
    expect((await page.goto(url)).status()).toBe(200);
    expect(page.url()).toBe(url);
    await expect(page.locator("[data-map-status]")).toHaveText("Map ready.", { timeout: 60_000 });
    await expect(page.locator("[data-map-canvas] canvas")).toBeVisible();
    await expect(page.locator("honua-studio-app,[data-agent-workspace]")).toHaveCount(0);
    expect((await context.cookies()).length).toBe(0);
  } finally {
    await context.close();
  }
}
