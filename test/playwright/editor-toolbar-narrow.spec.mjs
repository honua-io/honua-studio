import { test as base, expect } from "@playwright/test";

import { startMockServer } from "../../mock-server.mjs";
import { startPreviewServer, waitForStudioApp } from "./helpers.mjs";

const TOOLBAR_CONTROLS = [
  ["history-undo", "Undo"],
  ["history-redo", "Redo"],
  ["design-inspector-toggle", "Inspect data and interactions"],
  ["recipe-toggle", "Start from a recipe"],
];

const test = base.extend({
  workspaceEditor: async ({ page }, use) => {
    const mock = await startMockServer();
    const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
    try {
      await openWorkspaceEditor(page, preview.url);
      await use(page);
    } finally {
      await preview.close();
      await mock.close();
    }
  },
});

async function openWorkspaceEditor(page, url) {
  await page.goto(url);
  await waitForStudioApp(page);
  await page.evaluate(() => {
    window.__honuaStudioApp.agentSessionAdapter = { submitTurn: async () => ({ content: "" }) };
  });
  await expect(page.locator("honua-studio-app")).toHaveAttribute("data-editor-host", "");
  await expect(page.getByTestId("studio-canvas")).toBeVisible();
}

function intersects(a, b) {
  return a.bottom > b.top + 1 && a.top < b.bottom - 1 && a.right > b.left + 1 && a.left < b.right - 1;
}

function readControlBox(element) {
  const box = element.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(element);
  const text = [...range.getClientRects()].map((rect) => rect.toJSON());
  return {
    top: box.top,
    box: box.toJSON(),
    text,
    textOverflowsControl: text.some(
      (rect) =>
        rect.bottom > box.bottom + 1 ||
        rect.top < box.top - 1 ||
        rect.right > box.right + 1 ||
        rect.left < box.left - 1,
    ),
  };
}

async function readToolbarLayout(page) {
  const canvas = await page
    .getByTestId("studio-canvas")
    .evaluate((element) => element.getBoundingClientRect().toJSON());
  const controls = [];
  for (const [id] of TOOLBAR_CONTROLS) {
    const control = await page.getByTestId(id).evaluate(readControlBox);
    controls.push({
      id,
      top: control.top,
      textOverflowsControl: control.textOverflowsControl,
      overlapsCanvas: intersects(control.box, canvas) || control.text.some((rect) => intersects(rect, canvas)),
    });
  }
  const pageOverflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  return { controls, pageOverflows };
}

async function expectToolbarClearOfCanvas(page) {
  const layout = await readToolbarLayout(page);
  expect(layout.controls.filter((control) => control.textOverflowsControl || control.overlapsCanvas)).toEqual([]);
  expect(layout.pageOverflows).toBe(false);
  return layout;
}

test.describe("workspace editor toolbar at phone width", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("keeps every label clear of the canvas", async ({ workspaceEditor: page }) => {
    for (const [testId, label] of TOOLBAR_CONTROLS) {
      await expect(page.getByTestId(testId)).toHaveText(label);
      await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
    await expectToolbarClearOfCanvas(page);
    await page.getByTestId("design-inspector-toggle").focus();
    await expect(page.getByTestId("design-inspector-toggle")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("recipe-toggle")).toBeFocused();
  });
});

test.describe("workspace editor toolbar at desktop width", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("keeps the same controls on one row", async ({ workspaceEditor: page }) => {
    const layout = await expectToolbarClearOfCanvas(page);
    const tops = layout.controls.map((control) => control.top);
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(4);
  });
});
