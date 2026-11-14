import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { expect, test } from "@playwright/test";

function varint(value) {
  const bytes = [];
  let remaining = value;
  do {
    bytes.push((remaining & 127) | (remaining > 127 ? 128 : 0));
    remaining = Math.floor(remaining / 128);
  } while (remaining);
  return bytes;
}
function field(number, bytes) {
  return [...varint(number * 8 + 2), ...varint(bytes.length), ...bytes];
}
function archive(raster) {
  const feature = [8, 1, 24, 1, ...field(4, [9, ...varint(4096), ...varint(4096)])];
  const layer = [...field(1, [...Buffer.from("land")]), ...field(2, feature), 40, ...varint(4096), 120, 2];
  const tile = raster
    ? Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==",
        "base64",
      )
    : Buffer.from(field(3, layer));
  const metadata = Buffer.from(JSON.stringify(raster ? {} : { vector_layers: [{ id: "land" }] }));
  const directory = Buffer.from([1, 0, 1, ...varint(tile.length), 1]);
  const data = Buffer.alloc(127 + directory.length + metadata.length + tile.length);
  data.write("PMTiles");
  data[7] = 3;
  for (const [offset, value] of [
    [8, 127],
    [16, directory.length],
    [24, 127 + directory.length],
    [32, metadata.length],
    [40, data.length - tile.length],
    [48, 0],
    [56, data.length - tile.length],
    [64, tile.length],
    [72, 1],
    [80, 1],
    [88, 1],
  ])
    data.writeBigUInt64LE(BigInt(value), offset);
  data[96] = 1;
  data[97] = 1;
  data[98] = 1;
  data[99] = raster ? 2 : 1;
  data.writeInt32LE(-1800000000, 102);
  data.writeInt32LE(-850000000, 106);
  data.writeInt32LE(1800000000, 110);
  data.writeInt32LE(850000000, 114);
  directory.copy(data, 127);
  metadata.copy(data, 127 + directory.length);
  tile.copy(data, data.length - tile.length);
  return data;
}

// Built audience renderer with HTTP archives; no deployed publication or paid calls.
test("published PMTiles vector and raster use credential-free range reads", async ({ page, context }) => {
  const root = resolve("dist-console");
  const requests = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname.endsWith(".pmtiles")) {
      requests.push({
        path: url.pathname,
        range: request.headers.range,
        cookie: request.headers.cookie,
        auth: request.headers.authorization,
      });
      const data = archive(url.pathname === "/raster.pmtiles");
      const match = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
      if (!match) {
        response.writeHead(400).end();
        return;
      }
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), data.length - 1);
      response.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${data.length}`, ETag: '"v1"' });
      response.end(data.subarray(start, end + 1));
      return;
    }
    if (url.pathname === "/") {
      response
        .writeHead(200, { "Content-Type": "text/html" })
        .end('<!doctype html><div id="map" style="width:800px;height:500px"></div><div id="widgets"></div>');
      return;
    }
    const file = resolve(root, url.pathname.slice(1));
    if (!file.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    try {
      response
        .writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : "application/octet-stream" })
        .end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    await context.addCookies([{ name: "author_session", value: "must-not-leak", url: origin }]);
    await page.goto(origin);
    await page.evaluate(async () => {
      const runtime = await import("/console.js");
      const body = {
        layers: [
          { id: "image", sourceId: "image", type: "raster", visible: true },
          {
            id: "point",
            sourceId: "point",
            type: "circle",
            visible: true,
            metadata: { honua: { sourceLayer: "land" } },
          },
        ],
        sourceBindings: ["image", "point"].map((id) => ({
          sourceId: id,
          protocol: "pmtiles",
          locator: {
            url: `${location.origin}/${id === "image" ? "raster" : "vector"}.pmtiles`,
            sourceType: id === "image" ? "raster" : "vector",
          },
        })),
        mapSpec: {
          version: 8,
          sources: {
            image: { type: "raster", url: `pmtiles://${location.origin}/raster.pmtiles` },
            point: { type: "vector", url: `pmtiles://${location.origin}/vector.pmtiles` },
          },
          layers: [
            { id: "image", type: "raster", source: "image" },
            {
              id: "point",
              type: "circle",
              source: "point",
              "source-layer": "land",
              paint: { "circle-radius": 20, "circle-color": "#ff0000" },
            },
          ],
        },
        view: { center: [0, 0], zoom: 0 },
      };
      window.pmtilesFixture = runtime.createReadOnlyCompositionView({
        container: document.querySelector("#map"),
        widgetContainer: document.querySelector("#widgets"),
        body,
        documentUrl: location.href,
        getAudienceTransport: () => {
          throw new Error("PMTiles requested audience credentials");
        },
      });
      await window.pmtilesFixture.settled();
    });
    await expect.poll(() => page.evaluate(() => window.pmtilesFixture.renderedFeatureCount)).toBeGreaterThan(0);
    await expect.poll(() => requests.some((request) => request.path === "/raster.pmtiles")).toBe(true);
    expect(await page.evaluate(() => window.pmtilesFixture.projection.unresolved)).toEqual([]);
    expect(errors).toEqual([]);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((request) => request.range && !request.cookie && !request.auth)).toBe(true);
    await page.evaluate(() => window.pmtilesFixture.dispose());
  } finally {
    await new Promise((done) => server.close(done));
  }
});
