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
    const viewer = createPublishedMapViewer({
      route: "/qualification-map",
      origin: "http://127.0.0.1",
      container: { dataset: {} },
      widgetContainer: {},
      title: {},
      status,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              family: "map",
              envelope: { family: "map", body },
              sourceCatalog: [],
            },
          }),
          { headers: { "X-Honua-Viewer-Partition": "a".repeat(64) } },
        ),
      loadRenderer: async () => ({
        AudienceStyleProvider: class {},
        createReadOnlyAppView(options) {
          renderedBody = options.body;
          return { status: "ready", renderedFeatureCount: 0, settled: async () => {}, dispose() {} };
        },
      }),
    });
    await viewer.reload();
    viewer.dispose();
    assert.equal(status.textContent, "Map ready.");
    assert.deepEqual(renderedBody, body);
  }
});
