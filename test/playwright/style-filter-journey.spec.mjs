import { expect, test } from "@playwright/test";
import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { startPreviewServer, waitForSignedInMap } from "./helpers.mjs";
import { runStyleFilterJourney } from "./style-filter-journey.mjs";

test("direct layer styling and temporary filters agree on the painted map, the grid and the saved draft", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const mock = await startMockServer();
  const preview = await startPreviewServer({ HONUA_BASE_URL: mock.url });
  const headers = { authorization: `Bearer ${mintFixtureAccessToken()}` };
  const readDraft = async (key) => {
    const listed = await (await fetch(`${mock.url}/v1/studio/package-drafts?q=${key}`, { headers })).json();
    expect(listed.data.items).toHaveLength(1);
    const response = await fetch(`${mock.url}/v1/studio/package-drafts/${listed.data.items[0].draftId}`, { headers });
    return (await response.json()).data;
  };
  try {
    await page.goto(preview.url);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await waitForSignedInMap(page);
    await runStyleFilterJourney(page, info, { key: "style-filter-journey", readDraft });
  } finally {
    await preview.close();
    await mock.close();
  }
});
