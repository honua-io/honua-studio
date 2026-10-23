import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { expect, test } from "@playwright/test";

// This proves the built renderer against HTTP fixtures, not a deployed Server
// publication or an end-to-end installed workflow.
async function assertAudienceView(page, mount) {
  const root = resolve("dist-console");
  const requests = [];
  const workerRequests = [];
  const fields = [
    { name: "OBJECTID", type: "esriFieldTypeOID" },
    { name: "district", type: "esriFieldTypeString" },
    { name: "day", type: "esriFieldTypeString" },
  ];
  // Keep both fixture polygons inside one z13 tile: idless tile-clipped
  // fragments are not an independent source-row count oracle.
  const coordinates = [
    [-157.847, 21.3],
    [-157.845, 21.3],
    [-157.845, 21.302],
    [-157.847, 21.302],
    [-157.847, 21.3],
  ];
  const features = [
    { attributes: { OBJECTID: 1, district: "North", day: "2026-01-01" }, geometry: { rings: [coordinates] } },
    {
      attributes: { OBJECTID: 2, district: "South", day: "2026-01-03" },
      geometry: { rings: [coordinates.map(([x, y]) => [x + 0.005, y])] },
    },
  ];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      requests.push({ path: url.pathname, method: request.method, reader: request.headers["x-test-reader"] });
      response.setHeader("Content-Type", "application/json");
      if (url.pathname === "/api/studio/viewer/styles/district") {
        response.setHeader("ETag", '"style-v7"');
        response.end(
          JSON.stringify({
            version: 8,
            sources: { canonical: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
            layers: [
              {
                id: "district-fill",
                type: "fill",
                source: "canonical",
                paint: {
                  "fill-color": ["match", ["get", "district"], "North", "#003366", "#ddaa22"],
                },
              },
            ],
          }),
        );
      } else if (url.pathname === "/api/studio/viewer/data/rest/services/parcels/FeatureServer/1") {
        response.end(JSON.stringify({ id: 1, geometryType: "esriGeometryPolygon", objectIdField: "OBJECTID", fields }));
      } else if (url.pathname === "/api/studio/viewer/data/rest/services/parcels/FeatureServer/1/query") {
        response.end(
          JSON.stringify(
            url.searchParams.get("f") === "geojson"
              ? {
                  type: "FeatureCollection",
                  features: features.map((feature) => ({
                    type: "Feature",
                    id: feature.attributes.OBJECTID,
                    properties: feature.attributes,
                    geometry: { type: "Polygon", coordinates: feature.geometry.rings },
                  })),
                }
              : {
                  objectIdFieldName: "OBJECTID",
                  geometryType: "esriGeometryPolygon",
                  spatialReference: { wkid: 4326 },
                  fields,
                  features,
                  exceededTransferLimit: false,
                },
          ),
        );
      } else response.writeHead(403).end();
      return;
    }
    if (url.pathname === mount) {
      response
        .writeHead(200, { "Content-Type": "text/html" })
        .end(
          '<!doctype html><title>Published audience</title><div id="map" style="width:800px;height:500px"></div><div id="widgets"></div>',
        );
      return;
    }
    if (!url.pathname.startsWith(mount)) {
      response.writeHead(404).end();
      return;
    }
    const file = resolve(root, url.pathname.slice(mount.length));
    if (!file.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const bytes = await readFile(file);
      if (/\/assets\/maplibre-gl-worker-[^/]+\.js$/.test(url.pathname))
        workerRequests.push({ path: url.pathname, method: request.method });
      response.writeHead(200, {
        "Content-Type": url.pathname.endsWith(".js") ? "text/javascript" : "application/octet-stream",
      });
      response.end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}${mount}`);
    await page.evaluate(async (mount) => {
      const runtime = await import(`${mount}console.js`);
      const base = `${location.origin}/api/studio/viewer/data`;
      const catalog = [
        {
          id: "service/1",
          title: "Parcels",
          protocol: "geoservices-feature-service",
          geometryType: "Polygon",
          locator: { serviceId: "service", layerId: 1, url: `${base}/rest/services/parcels/FeatureServer` },
        },
      ];
      const transport = {
        fetchRequest: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("X-Test-Reader", "current-reader");
          return fetch(input, { ...init, headers });
        },
      };
      const body = {
        layers: [
          { id: "parcels", sourceId: "service/1", type: "fill", visible: true, styleRef: "district" },
          { id: "secret", sourceId: "denied", type: "fill", visible: true, styleRef: "denied-style" },
        ],
        widgets: [
          { id: "grid", kind: "table", sourceId: "parcels", config: { fields: ["OBJECTID", "district", "day"] } },
          { id: "chart", kind: "chart", sourceId: "parcels", config: { groupBy: "district" } },
        ],
        controls: [
          {
            id: "district",
            kind: "filterSelect",
            sourceId: "service/1",
            config: { field: "district", options: ["North", "South"] },
          },
          { id: "period", kind: "filterDateRange", sourceId: "parcels", config: { field: "day" } },
        ],
        view: { center: [-157.843, 21.301], zoom: 13 },
      };
      const durable = JSON.stringify(body);
      const view = runtime.createReadOnlyCompositionView({
        container: document.querySelector("#map"),
        widgetContainer: document.querySelector("#widgets"),
        body,
        projection: { catalog, baseUrl: base },
        sourceAuthBaseUrl: base,
        documentUrl: location.href,
        getAudienceTransport: () => transport,
        styleProvider: new runtime.AudienceStyleProvider({
          styleBaseUrl: "/api/studio/viewer/styles",
          documentUrl: location.href,
          catalog,
          getTransport: () => transport,
        }),
      });
      window.audienceFixture = { view, body, durable };
      await view.settled();
    }, mount);
    await expect.poll(() => page.evaluate(() => window.audienceFixture.view.renderedFeatureCount)).toBeGreaterThan(0);
    await expect(page.locator("honua-studio-widget-deck")).toContainText("North");
    const observed = await page.evaluate(() => {
      const { view, body, durable } = window.audienceFixture;
      return {
        status: view.status,
        detail: view.statusDetail,
        rendered: view.projection.renderedLayerIds,
        style: view.projection.mapPackage.styleRefs[0]?.body,
        unchanged: JSON.stringify(body) === durable,
        editor: document.querySelectorAll("honua-studio-app").length,
      };
    });
    expect(observed.status).toBe("ready");
    expect(observed.detail).toContain("secret");
    expect(observed.rendered).toEqual(["parcels"]);
    expect(JSON.stringify(observed.style)).toContain("#003366");
    expect(observed.unchanged).toBe(true);
    expect(observed.editor).toBe(0);
    expect(requests.some((request) => request.path.endsWith("/styles/district"))).toBe(true);
    expect(requests.some((request) => request.path.endsWith("/1/query"))).toBe(true);
    expect(requests.every((request) => request.method === "GET" && request.reader === "current-reader")).toBe(true);
    expect(workerRequests.length).toBeGreaterThan(0);
    expect(
      workerRequests.every((request) => request.method === "GET" && request.path.startsWith(`${mount}assets/`)),
    ).toBe(true);
    expect(requests.some((request) => /denied|secret|mcp/.test(request.path))).toBe(false);
    const bars = () => page.locator(".widget-chart-bar title").allTextContents();
    const cells = () =>
      page
        .getByTestId("studio-widget-grid-row")
        .evaluateAll((nodes) => nodes.map((node) => [...node.querySelectorAll("td")].map((cell) => cell.textContent)));
    const rendered = () => page.evaluate(() => window.audienceFixture.view.renderedFeatureCount);
    await expect.poll(async () => (await bars()).sort()).toEqual(["North: 1", "South: 1"]);
    await expect.poll(cells).toEqual([
      ["1", "North", "2026-01-01"],
      ["2", "South", "2026-01-03"],
    ]);
    await expect.poll(rendered).toBe(2);
    await page.getByTestId("studio-control-filter-select").selectOption("North");
    await expect.poll(bars).toEqual(["North: 1"]);
    await expect.poll(cells).toEqual([["1", "North", "2026-01-01"]]);
    await expect.poll(rendered).toBe(1);
    await page.getByTestId("studio-control-date-from").fill("2026-01-02");
    await page.getByTestId("studio-control-date-from").press("Tab");
    await expect.poll(rendered).toBe(0);
    await expect.poll(bars).toEqual([]);
    await page.getByTestId("studio-control-date-to").fill("2026-01-03");
    await page.getByTestId("studio-control-date-to").press("Tab");
    await page.getByTestId("studio-control-filter-select").selectOption("");
    await expect.poll(bars).toEqual(["South: 1"]);
    await expect.poll(cells).toEqual([["2", "South", "2026-01-03"]]);
    await expect.poll(rendered).toBe(1);
    await page.getByTestId("studio-control-date-from").fill("");
    await page.getByTestId("studio-control-date-from").press("Tab");
    await page.getByTestId("studio-control-date-to").fill("");
    await page.getByTestId("studio-control-date-to").press("Tab");
    await expect.poll(async () => (await bars()).sort()).toEqual(["North: 1", "South: 1"]);
    await expect.poll(cells).toHaveLength(2);
    await expect.poll(rendered).toBe(2);
    expect(
      await page.evaluate(() => JSON.stringify(window.audienceFixture.body) === window.audienceFixture.durable),
    ).toBe(true);
    expect(requests.every((request) => request.method === "GET" && request.reader === "current-reader")).toBe(true);
    await page.evaluate(() => window.audienceFixture.view.dispose());
    await expect(page.locator("honua-studio-widget-deck")).toHaveCount(0);
  } finally {
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
  }
}

for (const mount of ["/", "/_studio/", "/tenants/kestrel/_studio/"]) {
  test(`built audience view at ${mount} paints a current-reader shared style and table without reading denied sources`, async ({
    page,
  }) => {
    await assertAudienceView(page, mount);
  });
}
