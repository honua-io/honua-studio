import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { liveMapBody } from "../lib/live-publication.mjs";

const source = resolve(".tmp/live-console-source/src/Honua.Console.Web/wwwroot/js/published-map-viewer.mjs");
const { createPublishedMapViewer } = await import(pathToFileURL(source));

test("the live map fixture uses the server's case-sensitive draft status", () => {
  assert.equal(liveMapBody("qualification-map").status, "Draft");
});

test("both lifecycle versions reach the pinned Console viewer's renderer without changing their body", async () => {
  for (const extra of [{}, { themeId: "live-journey-dark" }]) {
    const body = liveMapBody("qualification-map", extra);
    const status = { textContent: "" };
    let renderedBody;
    const keys = [];
    const viewer = createPublishedMapViewer({
      route: "/qualification-map",
      documentUrl: "https://localhost:18083/console/maps/published/qualification-map",
      container: { dataset: {} },
      widgetContainer: {},
      title: {},
      status,
      // The static bundle reads the server's native published route through the Console edge.
      connect: async (key) => {
        keys.push(key);
        return {
          response: Response.json({
            success: true,
            data: { family: "map", envelope: { family: "map", body }, sourceCatalog: [] },
          }),
          dataBase: "https://localhost:18083",
          styleBase: "https://localhost:18083/ogc/styles",
          current: () => true,
          fetch: async () => {
            throw new Error("The fixture publication has no data reads.");
          },
        };
      },
      loadRenderer: async () => ({
        AudienceStyleProvider: class {},
        createReadOnlyCompositionView(options) {
          renderedBody = options.body;
          return { status: "ready", renderedFeatureCount: 0, settled: async () => {}, dispose() {} };
        },
      }),
    });
    await viewer.reload();
    viewer.dispose();
    assert.equal(status.textContent, "Map ready.");
    assert.deepEqual(renderedBody, body);
    assert.deepEqual(keys, ["qualification-map"]);
  }
});
