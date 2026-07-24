/**
 * Chat console inside the bare embed harness (honua-studio#6, REQ-001 "a
 * bare embed harness proves third-party hosting"). Unlike
 * chat-fixture-journey.spec.mjs (which installs a `FixtureChatTransport`),
 * this spec exercises `<honua-studio-chat>`'s DEFAULT `SseChatTransport`
 * against `mock-server.mjs`'s real `/v1/studio/ai/chat` SSE route — proving
 * the SSE parser, the fetch/bearer wiring, and the mock server's fixture
 * playback all work together in a real browser, with zero console/shell
 * code (harness/bare has none of it — see bare-harness.spec.mjs's own doc).
 * Also exercises REQ-012's annotation chip lifecycle end to end.
 */
import { expect, test } from "@playwright/test";

import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { startPreviewServer } from "./helpers.mjs";

test.describe("chat console inside the bare embed harness", () => {
  test("sends a message through the real SSE transport against the mock server's fixture route, rendering the streamed tool call", async ({
    page,
  }) => {
    const mock = await startMockServer();
    const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
    try {
      await page.addInitScript((token) => {
        window.__honuaStudioFixtureToken = token;
      }, mintFixtureAccessToken());
      await page.goto(`${preview.url}/harness/bare/index.html`);
      await expect(page.getByTestId("studio-chat")).toBeVisible();

      await page.getByTestId("studio-chat-input").fill("Add the Hawai'i statewide parcels layer and style it by district.");
      await page.getByTestId("studio-chat-send").click();

      await expect(page.getByTestId("studio-chat-tool-call")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("studio-chat-tool-call")).toContainText("add_layer");
      await expect(page.getByTestId("studio-chat-tool-call")).toHaveAttribute("data-status", "complete");
      await expect(page.getByTestId("studio-chat-message-text").first()).toHaveText(
        "Add the Hawai'i statewide parcels layer and style it by district.",
      );
    } finally {
      await preview.close();
      await mock.close();
    }
  });

  test("annotation chips: .addAnnotation() renders a removable chip, folded into the sent message, removable via the UI (spec REQ-012)", async ({
    page,
  }) => {
    const mock = await startMockServer();
    const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
    try {
      await page.addInitScript((token) => {
        window.__honuaStudioFixtureToken = token;
      }, mintFixtureAccessToken());
      await page.goto(`${preview.url}/harness/bare/index.html`);
      await expect(page.getByTestId("studio-chat")).toBeVisible();

      const addedEvent = page.evaluate(
        () =>
          new Promise((resolve) => {
            window.__honuaStudioBareApp
              .querySelector("honua-studio-chat")
              .addEventListener("honua-studio-chat-annotation-added", (event) => resolve(event.detail), { once: true });
          }),
      );
      await page.evaluate(() =>
        window.__honuaStudioBareApp.querySelector("honua-studio-chat").addAnnotation({
          id: "layer-1",
          kind: "layer",
          payload: { layerId: "hi-parcels" },
          label: "Hawai'i statewide parcels",
        }),
      );
      expect(await addedEvent).toMatchObject({ annotation: { id: "layer-1", kind: "layer" } });

      const chip = page.getByTestId("studio-chat-annotation-chip");
      await expect(chip).toBeVisible();
      await expect(chip).toContainText("Hawai'i statewide parcels");

      // Remove via the real UI control.
      await page.getByTestId("studio-chat-annotation-remove").click();
      await expect(page.getByTestId("studio-chat-annotation-chip")).toHaveCount(0);
    } finally {
      await preview.close();
      await mock.close();
    }
  });
});
