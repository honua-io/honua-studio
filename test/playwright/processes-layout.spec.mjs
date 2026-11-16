import { test as base, expect } from "@playwright/test";
import { startMockServer } from "../../mock-server.mjs";
import { startPreviewServer, waitForStudioApp } from "./helpers.mjs";

const test = base.extend({
  processes: async ({ page }, use) => {
    const mock = await startMockServer();
    const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
    try {
      await page.goto(preview.url);
      await waitForStudioApp(page);
      await page.evaluate(() => {
        const element = document.createElement("honua-studio-processes");
        document.body.replaceChildren(element);
        document.body.style.margin = "0";
      });
      await use(page.locator("honua-studio-processes"));
    } finally {
      await preview.close();
      await mock.close();
    }
  },
});

test.use({ viewport: { width: 1280, height: 900 } });

for (const { width, fontSize, columns } of [
  { width: 1100, fontSize: 16, columns: 3 },
  { width: 640, fontSize: 16, columns: 1 },
  { width: 900, fontSize: 32, columns: 1 },
  { width: 390, fontSize: 32, columns: 1 },
]) {
  test(`Processes fits a ${width}px host with ${fontSize}px root text`, async ({ processes }) => {
    await processes.evaluate(
      (element, { width, fontSize }) => {
        document.documentElement.style.fontSize = `${fontSize}px`;
        element.style.width = `${width}px`;
      },
      { width, fontSize },
    );
    const layout = await processes.evaluate((element) => {
      const host = element.getBoundingClientRect();
      const workspace = element.shadowRoot.querySelector(".workspace");
      const panels = [...workspace.children].map((panel) => {
        const box = panel.getBoundingClientRect();
        return { top: box.top, left: box.left, right: box.right, overflow: panel.scrollWidth - panel.clientWidth };
      });
      return {
        host: { left: host.left, right: host.right },
        panels,
        overflow: element.scrollWidth - element.clientWidth,
      };
    });
    expect(layout.overflow).toBeLessThanOrEqual(1);
    for (const panel of layout.panels) {
      expect(panel.left).toBeGreaterThanOrEqual(layout.host.left);
      expect(panel.right).toBeLessThanOrEqual(layout.host.right + 1);
      expect(panel.overflow).toBeLessThanOrEqual(1);
    }
    expect(new Set(layout.panels.map(({ top }) => Math.round(top))).size).toBe(columns === 3 ? 1 : 3);
    await expect(processes.getByRole("button", { name: "Load registry", exact: true })).toBeVisible();
    await expect(processes.getByRole("region", { name: "Node configuration" })).toBeVisible();
  });
}
