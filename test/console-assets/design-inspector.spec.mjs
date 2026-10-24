import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { expect, test } from "@playwright/test";
import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";

test("built shared editor inspects actual data, follows exact owners, and fences draft and authority changes", async ({ page }) => {
  const mock = await startMockServer();
  const directory = resolve("dist-console");
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const upstream = await fetch(`${mock.url}${url.pathname.slice(4)}${url.search}`, { method: request.method, headers: request.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      const headers = Object.fromEntries([...upstream.headers].filter(([name]) => !["content-length", "content-encoding", "transfer-encoding", "connection"].includes(name)));
      response.writeHead(upstream.status, headers);
      response.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    if (url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html" }).end('<!doctype html><title>Design inspector</title><div id="host"></div>');
      return;
    }
    const file = resolve(directory, `.${url.pathname}`);
    if (!file.startsWith(`${directory}${sep}`)) { response.writeHead(403).end(); return; }
    try { response.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : "application/octet-stream" }).end(await readFile(file)); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async (token) => {
      const runtime = await import("/console.js");
      runtime.registerAllStudioElements();
      const app = document.createElement("honua-studio-app");
      app.session = { getToken: async () => token, onExpired: () => () => {} };
      app.agentSessionAdapter = { async submitTurn() { throw new Error("No model in HTTP fixture proof."); } };
      app.sourceCatalog = [{ id: "hi-parcels/0", title: "Parcels", protocol: "geoservices-feature-service", geometryType: "Polygon", locator: { serviceId: "hi-parcels", layerId: 0, url: `${location.origin}/api/rest/services/hi-parcels/FeatureServer/0` } }];
      document.getElementById("host").append(app);
      const response = await fetch("/api/v1/studio/package-drafts", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ packageKey: "design-inspector", envelope: { family: "map", schemaVersion: "1.0", format: "honua_map_package.v1", body: { mapPackageId: "design-inspector", format: "honua_map_package.v1", layers: [{ id: "parcels-a", sourceId: "hi-parcels/0", title: "Parcels", visible: true }, { id: "parcels-b", sourceId: "hi-parcels/0", title: "Parcels", visible: true }], widgets: [{ id: "table", kind: "table", sourceId: "parcels-a", config: { fields: ["zoning_code"] } }, { id: "chart", kind: "chart", sourceId: "hi-parcels/0", config: { groupBy: "zoning_code" } }], controls: [{ id: "zoning", kind: "filterSelect", sourceId: "hi-parcels/0", config: { field: "zoning_code", options: ["R-5", "B-2"] } }], interactions: [{ id: "zoning-map", on: { ref: "control:zoning", event: "change" }, do: { ref: "layer:parcels-a", verb: "setFilter", args: { field: "zoning_code", value: "$event.value" } } }, { id: "unsupported-query", on: { ref: "control:zoning", event: "change" }, do: { ref: "widget:chart", verb: "runWidgetQuery" } }] } } }) });
      const created = await response.json();
      await app.attachWorkspaceDraft(created.data.draftId);
      window.__designApp = app;
    }, mintFixtureAccessToken());
    await expect.poll(() => page.evaluate(() => document.querySelector("honua-studio-canvas")?.mapView?.status)).toBe("ready");
    await page.getByTestId("design-inspector-toggle").click();
    const panel = page.getByRole("region", { name: "Data and interaction inspector" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Described fields:");
    await expect(panel).toContainText("zoning_code (String)");
    await expect(panel.locator('[data-connection="unsupported-query"]')).toContainText("unsupported");
    const follow = panel.locator('[data-connection="zoning-map"] button[data-ref="layer:parcels-a"]');
    await follow.focus();
    await page.keyboard.press("Enter");
    await expect(follow).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.__designApp.selectedDesignRelationship)).toEqual({ interactionId: "zoning-map", ownerRef: "layer:parcels-a" });
    expect(await page.evaluate(() => window.__designApp.composition.selection)).toEqual([{ kind: "layer", id: "parcels-a" }]);
    await page.getByTestId("studio-control-filter-select").selectOption("R-5");
    await expect(panel).toContainText("zoning_code = R-5");
    await expect(panel).toContainText("matching rows from");
    await expect.poll(() => page.evaluate(() => document.querySelector("honua-studio-canvas")?.mapView?.map?.getStyle().layers.find((layer) => layer.id === "parcels-a")?.filter)).toEqual(["==", ["get", "zoning_code"], "R-5"]);
    const counts = await page.evaluate(() => {
      const deck = document.querySelector("honua-studio-canvas").widgetDeck;
      return { rows: deck.inspectSourceData("hi-parcels/0"), chart: deck.shadowRoot.querySelector('[data-widget-id="chart"]')?.textContent, table: deck.shadowRoot.querySelector('[data-widget-id="table"]')?.textContent };
    });
    expect(counts.rows).toContain("matching rows");
    await expect(page.getByTestId("studio-widget-chart-summary")).toContainText("1 categories, top R-5");
    const cells = await page.getByTestId("studio-widget-grid-row").allTextContents();
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((row) => row.trim() === "R-5")).toBe(true);
    await panel.getByRole("button", { name: "Reset temporary filters" }).click();
    await expect(panel).toContainText("No temporary source filters");
    expect(await page.evaluate(() => window.__designApp.composition.state.interactions.length)).toBe(2);
    await page.evaluate(() => window.__designApp.createWorkspaceDraft("next-inspector-draft"));
    await expect(panel).toHaveCount(0);
    await page.getByTestId("design-inspector-toggle").click();
    await expect(panel).toContainText("No components in this draft");
    await page.evaluate(() => { window.__designApp.session = { getToken: async () => undefined, onExpired: () => () => {} }; });
    await expect(panel).toHaveCount(0);
    expect(await page.evaluate(() => window.__designApp.selectedDesignRelationship)).toBeUndefined();
    await page.screenshot({ path: ".tmp/design-inspector-authority-fence.png", fullPage: true });
  } finally {
    await new Promise((done) => server.close(done));
    await mock.close();
  }
});
