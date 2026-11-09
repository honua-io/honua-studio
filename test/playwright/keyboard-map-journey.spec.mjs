import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { startPreviewServer, waitForSignedInMap } from "./helpers.mjs";

const KEYBOARD_ACTION_BUDGET = 100;

for (const themeSet of ["standalone", "console"]) {
  for (const mode of ["light", "dark"]) {
    test(`keyboard recipe map creation, version and publication: ${themeSet} ${mode}`, async ({ page }, info) => {
      const mock = await startMockServer();
      const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
      const actions = [];
      const key = "keyboard-parcels-map";

      async function press(value) {
        actions.push(value);
        expect(actions.length, "keyboard action budget includes traversal and activation").toBeLessThanOrEqual(
          KEYBOARD_ACTION_BUDGET,
        );
        await page.keyboard.press(value);
      }

      async function reach(control, traversal = "Tab") {
        await expect(control).toHaveCount(1);
        await expect(control).toBeVisible();
        await expect(control).toBeEnabled();
        while (!(await control.evaluate((element) => element.matches(":focus")))) await press(traversal);
      }

      async function activate(control, traversal = "Tab") {
        await reach(control, traversal);
        await press("Enter");
      }

      async function text(control, value) {
        await reach(control);
        actions.push("text entry");
        await page.keyboard.type(value);
        await expect(control).toHaveValue(value);
      }

      async function accessibility(stage) {
        const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
        await info.attach(`axe-keyboard-${stage}.json`, {
          contentType: "application/json",
          body: Buffer.from(JSON.stringify(result)),
        });
        expect(result.violations.filter((violation) => ["serious", "critical"].includes(violation.impact))).toEqual([]);
      }

      try {
        await page.addInitScript(
          ({ themeSet, mode }) => {
            localStorage.setItem("honua-studio:theme-set", themeSet);
            localStorage.setItem("honua-studio:theme-mode", mode);
          },
          { themeSet, mode },
        );
        await page.goto(preview.url);
        await activate(page.getByRole("button", { name: "Sign in", exact: true }));
        await expect(page.getByTestId("auth-status")).toHaveText("Signed in");
        await waitForSignedInMap(page);
        await activate(page.getByRole("button", { name: "Start from a recipe", exact: true }));
        await text(page.getByRole("textbox", { name: "Package key", exact: true }), key);
        await reach(page.getByRole("combobox", { name: "Authorized dataset", exact: true }));
        await press("Home");
        await press("ArrowDown");
        await press("Tab");
        await expect(page.getByTestId("recipe-source")).toHaveValue("hi-parcels/0");
        await expect(page.getByTestId("recipe-status")).toContainText("Verified");
        await reach(page.getByRole("combobox", { name: "Category field", exact: true }));
        await press("z");
        await press("Tab");
        await expect(page.getByTestId("recipe-category")).toHaveValue("zoning_code");
        const column = page.getByRole("checkbox", { name: "zoning_code", exact: true });
        await reach(column);
        await press("Space");
        await expect(column).toBeChecked();
        await accessibility("recipe");
        await activate(page.getByRole("button", { name: "Create editable draft", exact: true }));
        await expect(page.getByTestId("recipe-status")).toContainText("Created draft");
        await activate(page.getByRole("button", { name: "Close", exact: true }));
        await expect(page.getByTestId("recipe-panel")).toBeHidden();
        await expect(page.getByTestId("studio-widget-grid-row")).toHaveCount(25);
        await accessibility("map");
        await activate(page.getByRole("link", { name: "Content", exact: true }), "Shift+Tab");
        const draft = page.getByTestId("draft-row").filter({ hasText: key });
        await expect(draft).toHaveCount(1);
        await activate(draft.getByRole("button", { name: "Open", exact: true }));
        await activate(page.getByRole("button", { name: "Save as version", exact: true }));
        await expect(page.getByTestId("lifecycle-version-row")).toHaveCount(1);
        await activate(page.getByRole("button", { name: "Publish…", exact: true }));
        await expect(page.getByRole("button", { name: "Confirm publish", exact: true })).toBeDisabled();
        await accessibility("publish-confirmation");
        await text(page.getByRole("textbox", { name: "Confirm package key", exact: true }), key);
        await activate(page.getByRole("button", { name: "Confirm publish", exact: true }));
        await expect(page.getByTestId("lifecycle-panel-message")).toContainText("Published");
        const response = await fetch(`${mock.url}/v1/studio/content-items?q=${key}`, {
          headers: { authorization: `Bearer ${mintFixtureAccessToken()}` },
        });
        expect(response.status).toBe(200);
        const items = (await response.json()).data.items;
        expect(items).toHaveLength(1);
        expect(items[0].state).toBe("published");
        expect(actions.length).toBeLessThanOrEqual(KEYBOARD_ACTION_BUDGET);
        console.log(
          JSON.stringify({ keyboardActions: actions.length, budget: KEYBOARD_ACTION_BUDGET, themeSet, mode }),
        );
      } finally {
        await info.attach("keyboard-actions.json", {
          contentType: "application/json",
          body: Buffer.from(JSON.stringify({ budget: KEYBOARD_ACTION_BUDGET, count: actions.length, actions })),
        });
        await preview.close();
        await mock.close();
      }
    });
  }
}
