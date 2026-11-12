import { expect, test } from "@playwright/test";
import { expectNoSeriousAxeViolations } from "./helpers.mjs";

/** Rendered features of the composed layer, read from MapLibre after it painted, with each feature's evaluated paint. */
function renderedLayer(page, layerId, field) {
  return page.evaluate(
    ([id, categoryField]) => {
      const find = (root) => {
        for (const element of root.querySelectorAll("*")) {
          if (element.localName === "honua-studio-canvas") return element;
          const nested = element.shadowRoot && find(element.shadowRoot);
          if (nested) return nested;
        }
        return undefined;
      };
      const map = find(document)?.mapView?.map;
      if (!map?.isStyleLoaded()) return undefined;
      const renderLayers = map
        .getStyle()
        .layers.filter((layer) => layer.id === id || layer.metadata?.["honua:compositionLayerId"] === id)
        .filter((layer) => layer.type === "fill");
      const features = map.queryRenderedFeatures({ layers: renderLayers.map((layer) => layer.id) });
      const rgba = (color) =>
        color && typeof color === "object"
          ? `#${[color.r, color.g, color.b]
              .map((part) =>
                Math.round(part * 255)
                  .toString(16)
                  .padStart(2, "0"),
              )
              .join("")}`
          : String(color);
      return {
        count: features.length,
        categories: [...new Set(features.map((feature) => String(feature.properties[categoryField])))].sort(),
        colors: [...new Set(features.map((feature) => rgba(feature.layer.paint["fill-color"])))],
        opacity: [...new Set(features.map((feature) => feature.layer.paint["fill-opacity"]))],
      };
    },
    [layerId, field],
  );
}

/** Where the map looks and what its recipe source holds, for a journey that painted nothing. */
function mapDiagnostics(page) {
  return page.evaluate(() => {
    const app = window.__honuaStudioApp;
    const find = (root) => {
      for (const element of root.querySelectorAll("*")) {
        if (element.localName === "honua-studio-canvas") return element;
        const nested = element.shadowRoot && find(element.shadowRoot);
        if (nested) return nested;
      }
      return undefined;
    };
    const mapView = find(document)?.mapView;
    const map = mapView?.map;
    const layers =
      map
        ?.getStyle()
        ?.layers.filter(
          (layer) => layer.metadata?.["honua:compositionLayerId"] === "explore-layer" || layer.id === "explore-layer",
        ) ?? [];
    const sourceId = layers[0]?.source;
    return {
      authoredView: app?.composition?.state?.view,
      zoom: map?.getZoom(),
      center: map?.getCenter()?.toArray(),
      bounds: map?.getBounds()?.toArray(),
      styleLoaded: map?.isStyleLoaded(),
      status: mapView?.status,
      statusDetail: mapView?.statusDetail,
      renderLayers: layers.map((layer) => `${layer.id}:${layer.type}`),
      sourceFeatures: sourceId ? map.querySourceFeatures(sourceId).length : undefined,
    };
  });
}

function storedPaint(draft, layerId) {
  const layers = draft.envelope.body.mapSpec?.layers ?? draft.envelope.body.style?.layers ?? [];
  return layers.find((layer) => layer.id === layerId)?.paint;
}

/** Picks the first offered recipe dataset that `matches` an option; fixture and live catalogs name datasets differently. */
function recipeSourceOption(description, matches) {
  return async (page) => {
    await expect(page.getByTestId("recipe-status")).not.toHaveText("Loading sources…");
    const offered = await page
      .getByTestId("recipe-source")
      .locator("option")
      .evaluateAll((options) => options.map((option) => ({ value: option.value, label: option.textContent ?? "" })));
    const chosen = offered.find((option) => option.value && matches(option));
    if (!chosen) {
      const status = await page.getByTestId("recipe-status").textContent();
      throw new Error(
        `No ${description} in the recipe catalog. Status: ${status}. Offered: ${JSON.stringify(offered)}`,
      );
    }
    return chosen.value;
  };
}

const parcelsSourceOption = recipeSourceOption(
  "parcels dataset",
  (option) => option.value.startsWith("hi-parcels") || /parcel/i.test(option.label),
);

/** The demo's zoning layer: two feature pages, where its parcels need 26 and exhaust the demo key's rate limit. */
export const zoningSourceOption = recipeSourceOption("zoning dataset", (option) => /zoning/i.test(option.label));

async function createRecipeMap(page, key, sourceOption, firstPaintTimeout) {
  const browserErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text().slice(0, 500));
  });
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message.slice(0, 500)}`));
  page.on("response", async (response) => {
    if (!response.url().includes("/FeatureServer/")) return;
    const head = await response
      .text()
      .then((text) => text.slice(0, 600))
      .catch(() => "");
    if (!response.ok() || head.startsWith('{"error"'))
      browserErrors.push(`${response.status()} ${response.url().slice(0, 220)}: ${head}`);
  });
  await page.getByRole("button", { name: "Start from a recipe", exact: true }).click();
  await page.getByRole("textbox", { name: "Package key", exact: true }).fill(key);
  await page.getByTestId("recipe-source").selectOption(await sourceOption(page));
  await expect(page.getByTestId("recipe-status")).toContainText("Verified");
  const fields = await page
    .getByTestId("recipe-category")
    .locator("option")
    .evaluateAll((options) => options.map((option) => option.value).filter(Boolean));
  const field = ["zoning_code", "zone_code"].find((name) => fields.includes(name)) ?? fields[0];
  if (!field) throw new Error("The recipe offered no category field.");
  await page.getByTestId("recipe-category").selectOption(field);
  await page.getByRole("checkbox", { name: field, exact: true }).check();
  await page.getByRole("button", { name: "Create editable draft", exact: true }).click();
  await expect(page.getByTestId("recipe-status")).toContainText("Created draft");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("studio-widget-grid-row")).not.toHaveCount(0);
  const pageRows = await page.getByTestId("studio-widget-grid-row").count();
  await expect
    .poll(async () => (await renderedLayer(page, "explore-layer", field))?.count ?? 0, { timeout: firstPaintTimeout })
    .toBeGreaterThan(0)
    .catch(async (error) => {
      throw new Error(
        `${error.message}\nmap: ${JSON.stringify(await mapDiagnostics(page))}\nbrowser: ${JSON.stringify(browserErrors)}`,
      );
    });
  const unfiltered = await renderedLayer(page, "explore-layer", field);
  expect(unfiltered.categories.length).toBeGreaterThan(1);
  return { field, unfiltered, pageRows };
}

/** Direct styling previews on the painted map without a write; Save writes exactly that paint. */
async function verifyDirectStyling(page, info, { key, readDraft, field }) {
  await page.getByRole("link", { name: "Content", exact: true }).click();
  await page
    .getByTestId("draft-row")
    .filter({ hasText: key })
    .getByRole("button", { name: "Open", exact: true })
    .click();
  await page.getByRole("button", { name: "Edit map style", exact: true }).click();
  const editor = page.getByRole("region", { name: "Map style editor", exact: true });
  await expect(editor.getByRole("group", { name: "Appearance" })).toBeVisible();
  const before = storedPaint(await readDraft(key), "explore-layer");
  await editor.getByLabel("Color", { exact: true }).fill("#d94801");
  await editor.getByLabel("Opacity").fill("60");
  await expect.poll(async () => (await renderedLayer(page, "explore-layer", field))?.colors).toEqual(["#d94801"]);
  await expect.poll(async () => (await renderedLayer(page, "explore-layer", field))?.opacity).toEqual([0.6]);
  expect(storedPaint(await readDraft(key), "explore-layer")).toEqual(before);

  const width = editor.getByLabel("Outline width (px)");
  await width.fill("500");
  await expect(editor.getByRole("status")).toContainText("between 0 and 50 pixels");
  await width.fill("2");
  await expectNoSeriousAxeViolations(page, info, "direct-style");
  await editor.getByRole("button", { name: "Save map style", exact: true }).press("Enter");
  await expect(editor.getByRole("status")).toHaveText("Map style saved to the authorized draft.");
  const saved = storedPaint(await readDraft(key), "explore-layer");
  expect(saved).toMatchObject({ "fill-color": "#d94801", "fill-opacity": 0.6 });

  await editor.getByLabel("Color", { exact: true }).fill("#000000");
  await expect.poll(async () => (await renderedLayer(page, "explore-layer", field))?.colors).toEqual(["#000000"]);
  await editor.getByRole("button", { name: "Discard visual edits", exact: true }).click();
  await expect.poll(async () => (await renderedLayer(page, "explore-layer", field))?.colors).toEqual(["#d94801"]);
  expect(storedPaint(await readDraft(key), "explore-layer")).toEqual(saved);
  await editor.getByRole("button", { name: "Close style editor", exact: true }).click();
  await expect(editor).toHaveCount(0);
}

/** A temporary filter shows where it was applied, narrows map and grid, and clears without a write. */
async function verifyTemporaryFilters(page, info, { key, readDraft, field, unfiltered, pageRows }) {
  const draftBeforeFilter = await readDraft(key);
  const choice = await page
    .getByTestId("studio-control-filter-select")
    .locator("option")
    .evaluateAll((options) => options.map((option) => option.value).find(Boolean));
  await page.getByTestId("studio-control-filter-select").selectOption(choice);
  const summary = page.getByTestId("studio-exploration-filters");
  await expect(summary.getByTestId("studio-exploration-filter")).toContainText(
    `Filter by ${field}: ${field} is ${choice}`,
  );
  await expect.poll(async () => (await renderedLayer(page, "explore-layer", field))?.categories).toEqual([choice]);
  const filteredRows = await page.getByTestId("studio-widget-grid-row").count();
  expect(filteredRows).toBeGreaterThan(0);
  expect(filteredRows).toBeLessThanOrEqual(pageRows);
  await expectNoSeriousAxeViolations(page, info, "temporary-filter");

  await summary.getByRole("button", { name: `Clear Filter by ${field} filter` }).focus();
  await page.keyboard.press("Enter");
  await expect(summary).toHaveCount(0);
  await expect(page.getByTestId("studio-control-filter-select")).toHaveValue("");
  await expect(page.getByTestId("studio-control-filter-select")).toBeFocused();
  await expect
    .poll(async () => (await renderedLayer(page, "explore-layer", field))?.categories)
    .toEqual(unfiltered.categories);
  await expect(page.getByTestId("studio-widget-grid-row")).toHaveCount(pageRows);

  await page.getByTestId("studio-control-filter-select").selectOption(choice);
  await expect(summary).toBeVisible();
  await summary.getByRole("button", { name: "Reset all filters", exact: true }).click();
  await expect(summary).toHaveCount(0);
  await expect(page.getByTestId("studio-widget-grid-row")).toHaveCount(pageRows);
  const draftAfterReset = await readDraft(key);
  expect(draftAfterReset.envelope).toEqual(draftBeforeFilter.envelope);
  expect(draftAfterReset.generation ?? draftAfterReset.revision).toEqual(
    draftBeforeFilter.generation ?? draftBeforeFilter.revision,
  );
}

/**
 * Recipe map, then direct styling and temporary filters, asserted on MapLibre's painted features,
 * the grid and the stored draft. `readDraft(key)` returns the server's draft for the key.
 */
export async function runStyleFilterJourney(
  page,
  info,
  { key, readDraft, sourceOption = parcelsSourceOption, firstPaintTimeout = 10_000 },
) {
  const recipe = await test.step("recipe map", () => createRecipeMap(page, key, sourceOption, firstPaintTimeout));
  await test.step("direct styling", () => verifyDirectStyling(page, info, { key, readDraft, field: recipe.field }));
  await test.step("temporary filters", () => verifyTemporaryFilters(page, info, { key, readDraft, ...recipe }));
}
