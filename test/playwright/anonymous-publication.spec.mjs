import { expect, test } from "@playwright/test";
import { liveMapBody } from "../../scripts/lib/live-publication.mjs";
import { verifyAnonymousPublication } from "./anonymous-publication.mjs";

const publication = {
  consoleUrl: "http://127.0.0.1:5199",
  route: "/qualification-map",
  itemId: "item",
  versionId: "reviewed-version",
  requestId: "approved-request",
};

test("anonymous witness checks the exact approved version, rendered canvas and absence of credentials", async ({
  browser,
}) => {
  const newContext = browser.newContext.bind(browser);
  const witnessedBrowser = {
    async newContext(options) {
      const context = await newContext(options);
      await context.route("**/*", async (route) => {
        const request = route.request();
        expect(request.headers().authorization).toBeUndefined();
        expect(request.headers()["x-api-key"]).toBeUndefined();
        expect(request.headers().cookie).toBeUndefined();
        await route.fulfill({
          contentType: "text/html",
          body: "<p data-map-status>Map ready.</p><div data-map-canvas><canvas></canvas></div>",
        });
      });
      // APIRequestContext traffic is served by the separate loopback fixture below.
      return context;
    },
  };
  const { createServer } = await import("node:http");
  let omitLayers = false;
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers["x-api-key"]).toBeUndefined();
    expect(request.headers.cookie).toBeUndefined();
    response.setHeader("content-type", "application/json");
    const body = liveMapBody("qualification-map");
    if (omitLayers) body.layers = undefined;
    response.end(
      JSON.stringify({
        success: true,
        data: {
          ...publication,
          publicationId: publication.requestId,
          visibility: "public",
          family: "map",
          envelope: { family: "map", body },
        },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const options = { ...publication, consoleUrl: `http://127.0.0.1:${server.address().port}` };
    await verifyAnonymousPublication(witnessedBrowser, options);
    await expect(
      verifyAnonymousPublication(witnessedBrowser, { ...options, versionId: "different-version" }),
    ).rejects.toThrow();
    omitLayers = true;
    await expect(verifyAnonymousPublication(witnessedBrowser, options)).rejects.toThrow();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
