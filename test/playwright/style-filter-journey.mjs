import { expect } from "@playwright/test";
import { expectNoSeriousAxeViolations } from "./helpers.mjs";

/** Rendered features of the composed layer, read from MapLibre after it painted, with each feature's evaluated paint. */
function renderedLayer(page, layerId) {
  return page.evaluate((id) => {
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
      zoning: [...new Set(features.map((feature) => feature.properties.zoning_code))].sort(),
      colors: [...new Set(features.map((feature) => rgba(feature.layer.paint["fill-color"])))],
      opacity: [...new Set(features.map((feature) => feature.layer.paint["fill-opacity"]))],
    };
  }, layerId);
}

function storedPaint(draft, layerId) {
  const layers = draft.envelope.body.mapSpec?.layers ?? draft.envelope.body.style?.layers ?? [];
  return layers.find((layer) => layer.id === layerId)?.paint;
}

/** The first authorized parcels dataset the recipe offers; fixture and live catalogs name it differently. */
async function parcelsSourceOption(page) {
  const source = page.getByTestId("recipe-source");
  await expect(source.locator("option[value^='hi-parcels']")).not.toHaveCount(0);
  return source.locator("option[value^='hi-parcels']").first().getAttribute("value");
}

/**
 * Recipe map, then #129 direct styling and #130 temporary filters, asserted on MapLibre's painted
 * features, the grid and the stored draft. `readDraft(key)` returns the server's draft for the key.
 */
export async function runStyleFilterJourney(page, info, { key, readDraft, sourceOption = parcelsSourceOption }) {
  await page.getByRole("button", { name: "Start from a recipe", exact: true }).click();
  await page.getByRole("textbox", { name: "Package key", exact: true }).fill(key);
  await page.getByTestId("recipe-source").selectOption(await sourceOption(page));
  await expect(page.getByTestId("recipe-status")).toContainText("Verified");
  await page.getByTestId("recipe-category").selectOption("zoning_code");
  await page.getByRole("checkbox", { name: "zoning_code", exact: true }).check();
  await page.getByRole("button", { name: "Create editable draft", exact: true }).click();
  await expect(page.getByTestId("recipe-status")).toContainText("Created draft");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByTestId("studio-widget-grid-row")).not.toHaveCount(0);
  const pageRows = await page.getByTestId("studio-widget-grid-row").count();
  await expect.poll(async () => (await renderedLayer(page, "explore-layer"))?.count ?? 0).toBeGreaterThan(0);
  const unfiltered = await renderedLayer(page, "explore-layer");
  expect(unfiltered.zoning.length).toBeGreaterThan(1);

  // #129: direct styling previews on the painted map without a write; Save writes exactly that paint.
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
  await expect.poll(async () => (await renderedLayer(page, "explore-layer"))?.colors).toEqual(["#d94801"]);
  await expect.poll(async () => (await renderedLayer(page, "explore-layer"))?.opacity).toEqual([0.6]);
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
  await expect.poll(async () => (await renderedLayer(page, "explore-layer"))?.colors).toEqual(["#000000"]);
  await editor.getByRole("button", { name: "Discard visual edits", exact: true }).click();
  await expect.poll(async () => (await renderedLayer(page, "explore-layer"))?.colors).toEqual(["#d94801"]);
  expect(storedPaint(await readDraft(key), "explore-layer")).toEqual(saved);
  await editor.getByRole("button", { name: "Close style editor", exact: true }).click();
  await expect(editor).toHaveCount(0);

  // #130: a temporary filter is visible where it was applied, narrows map and grid, and clears without a write.
  const draftBeforeFilter = await readDraft(key);
  const choice = unfiltered.zoning[0];
  await page.getByTestId("studio-control-filter-select").selectOption(choice);
  const summary = page.getByTestId("studio-exploration-filters");
  await expect(summary.getByTestId("studio-exploration-filter")).toHaveText(
    new RegExp(`Filter by zoning_code: zoning_code is ${choice}`),
  );
  await expect.poll(async () => (await renderedLayer(page, "explore-layer"))?.zoning).toEqual([choice]);
  const filteredRows = await page.getByTestId("studio-widget-grid-row").count();
  expect(filteredRows).toBeGreaterThan(0);
  expect(filteredRows).toBeLessThanOrEqual(pageRows);
  await expectNoSeriousAxeViolations(page, info, "temporary-filter");

  await summary.getByRole("button", { name: "Clear Filter by zoning_code filter" }).focus();
  await page.keyboard.press("Enter");
  await expect(summary).toHaveCount(0);
  await expect(page.getByTestId("studio-control-filter-select")).toHaveValue("");
  await expect(page.getByTestId("studio-control-filter-select")).toBeFocused();
  await expect.poll(async () => (await renderedLayer(page, "explore-layer"))?.zoning).toEqual(unfiltered.zoning);
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
