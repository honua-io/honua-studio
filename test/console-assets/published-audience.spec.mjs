import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { expect, test } from "@playwright/test";

// This proves the built renderer against HTTP fixtures, not a deployed Server
// publication or an end-to-end installed workflow.
test("built audience view paints a current-reader shared style and table without reading denied sources", async ({
  page,
}) => {
  const root = resolve("dist-console");
  const requests = [];
  const fields = [
    { name: "OBJECTID", type: "esriFieldTypeOID" },
    { name: "district", type: "esriFieldTypeString" },
  ];
  const coordinates = [
    [-157.86, 21.29],
    [-157.84, 21.29],
    [-157.84, 21.31],
    [-157.86, 21.31],
    [-157.86, 21.29],
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
                  features: [
                    {
                      type: "Feature",
                      id: 1,
                      properties: { OBJECTID: 1, district: "North" },
                      geometry: { type: "Polygon", coordinates: [coordinates] },
                    },
                  ],
                }
              : {
                  objectIdFieldName: "OBJECTID",
                  geometryType: "esriGeometryPolygon",
                  spatialReference: { wkid: 4326 },
                  fields,
                  features: [{ attributes: { OBJECTID: 1, district: "North" }, geometry: { rings: [coordinates] } }],
                  exceededTransferLimit: false,
                },
          ),
        );
      } else response.writeHead(403).end();
      return;
    }
    if (url.pathname === "/") {
      response
        .writeHead(200, { "Content-Type": "text/html" })
        .end(
          '<!doctype html><title>Published audience</title><div id="map" style="width:800px;height:500px"></div><div id="widgets"></div>',
        );
      return;
    }
    const file = resolve(root, `.${url.pathname}`);
    if (!file.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const bytes = await readFile(file);
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
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async () => {
      const runtime = await import("/console.js");
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
        widgets: [{ id: "grid", kind: "table", sourceId: "service/1" }],
        view: { center: [-157.85, 21.3], zoom: 13 },
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
    });
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
    expect(requests.some((request) => /denied|secret|mcp/.test(request.path))).toBe(false);
    await page.evaluate(() => window.audienceFixture.view.dispose());
    await expect(page.locator("honua-studio-widget-deck")).toHaveCount(0);
  } finally {
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
  }
});
