import { expect, test } from "@playwright/test";
import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { applyTheme, expectNoSeriousAxeViolations, startPreviewServer, waitForSignedInMap } from "./helpers.mjs";

test.use({ trace: "retain-on-failure" });

const KEYBOARD_ACTION_BUDGET = 100;

class KeyboardJourney {
  actions = [];
  constructor(page) {
    this.page = page;
  }
  recordAction(value) {
    this.actions.push(value);
    expect(
      this.actions.length,
      "keyboard action budget includes traversal, activation and text entry",
    ).toBeLessThanOrEqual(KEYBOARD_ACTION_BUDGET);
  }
  async press(value) {
    this.recordAction(value);
    await this.page.keyboard.press(value);
  }

  async focusByKeyboard(control, traversal = "Tab") {
    await expect(control).toHaveCount(1);
    await expect(control).toBeVisible();
    await expect(control).toBeEnabled();
    while (!(await control.evaluate((element) => element.matches(":focus")))) await this.press(traversal);
  }

  async activate(control, traversal = "Tab") {
    await this.focusByKeyboard(control, traversal);
    await this.press("Enter");
  }

  async enterText(control, value) {
    await this.focusByKeyboard(control);
    this.recordAction("text entry");
    await this.page.keyboard.type(value);
    await expect(control).toHaveValue(value);
  }
}

for (const themeSet of ["standalone", "console"]) {
  for (const mode of ["light", "dark"]) {
    test(`keyboard recipe map creation, version and publication: ${themeSet} ${mode}`, async ({ page }, info) => {
      const mock = await startMockServer();
      const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
      const keyboard = new KeyboardJourney(page);
      const { actions } = keyboard;
      const key = "keyboard-parcels-map";

      try {
        await applyTheme(page, themeSet, mode);
        await page.goto(preview.url);
        await keyboard.activate(page.getByRole("button", { name: "Sign in", exact: true }));
        await expect(page.getByTestId("auth-status")).toHaveText("Signed in");
        await waitForSignedInMap(page);
        await keyboard.activate(page.getByRole("button", { name: "Start from a recipe", exact: true }));
        await keyboard.enterText(page.getByRole("textbox", { name: "Content key", exact: true }), key);
        await expect(page.getByTestId("recipe-source").locator('option[value="hi-parcels/0"]')).toHaveCount(1);
        await keyboard.focusByKeyboard(page.getByRole("combobox", { name: "Authorized dataset", exact: true }));
        await keyboard.press("Home");
        await keyboard.press("ArrowDown");
        await keyboard.press("Tab");
        await expect(page.getByTestId("recipe-source")).toHaveValue("hi-parcels/0");
        await expect(page.getByTestId("recipe-status")).toContainText("Verified");
        await keyboard.focusByKeyboard(page.getByRole("combobox", { name: "Category field", exact: true }));
        await keyboard.press("z");
        await keyboard.press("Tab");
        await expect(page.getByTestId("recipe-category")).toHaveValue("zoning_code");
        const column = page.getByRole("checkbox", { name: "zoning_code", exact: true });
        await keyboard.focusByKeyboard(column);
        await keyboard.press("Space");
        await expect(column).toBeChecked();
        await expectNoSeriousAxeViolations(page, info, "recipe");
        await keyboard.activate(page.getByRole("button", { name: "Create editable draft", exact: true }));
        await expect(page.getByTestId("recipe-status")).toContainText("Created draft");
        await keyboard.activate(page.getByRole("button", { name: "Close", exact: true }));
        await expect(page.getByTestId("recipe-panel")).toBeHidden();
        await expect(page.getByTestId("studio-widget-grid-row")).toHaveCount(25);
        await expectNoSeriousAxeViolations(page, info, "map");
        await keyboard.activate(page.getByRole("link", { name: "Content", exact: true }), "Shift+Tab");
        const draft = page.getByTestId("draft-row").filter({ hasText: key });
        await expect(draft).toHaveCount(1);
        await keyboard.activate(draft.getByRole("button", { name: "Open", exact: true }));
        await keyboard.activate(page.getByRole("button", { name: "Edit map style", exact: true }));
        const labelField = page.getByRole("combobox", { name: "Labels", exact: true });
        await expect(labelField.locator("option")).not.toHaveCount(1);
        await keyboard.focusByKeyboard(labelField);
        await keyboard.press("z");
        await expect(labelField).toHaveValue("zoning_code");
        await keyboard.activate(page.getByRole("button", { name: "Save map style", exact: true }));
        await expect(
          page.getByRole("status").filter({ hasText: "Map style saved to the authorized draft." }),
        ).toBeVisible();
        await expectNoSeriousAxeViolations(page, info, "style");
        await keyboard.activate(page.getByRole("button", { name: "Close style editor", exact: true }));
        await expect(page.getByRole("region", { name: "Map style editor", exact: true })).toHaveCount(0);
        await keyboard.activate(page.getByRole("button", { name: "Save as version", exact: true }));
        await expect(page.getByTestId("lifecycle-version-row")).toHaveCount(1);
        await keyboard.activate(page.getByRole("button", { name: "Publish…", exact: true }));
        await expect(page.getByRole("button", { name: "Confirm publish", exact: true })).toBeDisabled();
        await expectNoSeriousAxeViolations(page, info, "publish-confirmation");
        await keyboard.enterText(page.getByRole("textbox", { name: "Confirm content key", exact: true }), key);
        await keyboard.activate(page.getByRole("button", { name: "Confirm publish", exact: true }));
        await expect(page.getByTestId("lifecycle-panel-message")).toContainText("Published");
        const response = await fetch(`${mock.url}/v1/studio/content-items?q=${key}`, {
          headers: { authorization: `Bearer ${mintFixtureAccessToken()}` },
        });
        expect(response.status).toBe(200);
        const items = (await response.json()).data.items;
        expect(items).toHaveLength(1);
        expect(items[0].state).toBe("published");
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
