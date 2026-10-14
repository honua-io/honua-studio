import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { startPreviewServer } from "../test/playwright/helpers.mjs";
import { observedGeoJsonBounds } from "./lib/observed-geojson-bounds.mjs";

async function buildHashes() {
  const root = resolve("dist");
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = resolve(entry.parentPath ?? entry.path, entry.name);
    files.push([
      path.slice(root.length + 1),
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    ]);
  }
  return Object.fromEntries(files.sort(([a], [b]) => a.localeCompare(b)));
}

/** Actual production-map observer for the owned-server corpus, with explicit proxy provenance. */
export async function createBrowserStyleObserver({ baseUrl, tokenProvider, sources, requirements, directory }) {
  if (typeof tokenProvider !== "function")
    throw new Error("Browser style evidence requires a fresh host token provider.");
  if (!Array.isArray(sources))
    throw new Error("Browser style evidence requires explicit trusted host source descriptors.");
  const receipt = {
    schemaVersion: "honua.studio.browser-style-observer.v1",
    upstream: baseUrl,
    buildFiles: await buildHashes(),
    turns: [],
    requests: [],
    errors: [],
    releaseQualification: false,
  };
  let preview;
  let browser;
  const captures = [];
  await mkdir(directory, { recursive: true });
  const close = async () => {
    await Promise.all(captures);
    try {
      receipt.buildUnchanged = JSON.stringify(receipt.buildFiles) === JSON.stringify(await buildHashes());
    } catch (error) {
      receipt.buildUnchanged = false;
      receipt.errors.push(String(error));
    }
    await browser?.close();
    await preview?.close();
    await writeFile(resolve(directory, "browser-style-observer.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  };
  try {
    preview = await startPreviewServer({ HONUA_BASE_URL: baseUrl }, ["--port", "0"]);
    receipt.browserOrigin = preview.url;
    browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", (error) => receipt.errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") receipt.errors.push(message.text());
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (!["/api/", "/mcp", "/rest/", "/ogc/"].some((prefix) => url.pathname.startsWith(prefix))) return;
      captures.push(
        (async () => {
          const request = response.request();
          receipt.requests.push({
            browserUrl: response.url(),
            upstreamUrl: `${baseUrl}${url.pathname}${url.search}`,
            method: request.method(),
            body: request.postData(),
            status: response.status(),
            response: await response.text(),
          });
        })().catch((error) => receipt.errors.push(String(error))),
      );
    });
    await page.exposeBinding("styleObserverFreshToken", () => tokenProvider());
    await page.addInitScript(() => {
      window.__HONUA_STUDIO_HOST_SESSION__ = {
        getToken: () => window.styleObserverFreshToken(),
        onExpired: () => () => {},
      };
    });
    await page.goto(preview.url);
    await page.waitForFunction(() => Boolean(window.__honuaStudioApp?.studioClient));
    const discovered = await page.evaluate(() => window.__honuaStudioApp.studioClient.listCatalog());
    receipt.discoveredCatalog = discovered;
    const catalog = sources.map((source) => {
      const actual = discovered.find(
        (entry) =>
          entry.locator?.serviceId === source.locator?.serviceId && entry.locator?.layerId === source.locator?.layerId,
      );
      if (!actual || source.protocol !== actual.protocol || source.geometryType !== actual.geometryType)
        throw new Error(`Host source ${source.id} does not match actual catalog discovery.`);
      // Alias ids are the supported host-catalog contract. Locator bytes always come from actual discovery.
      return { ...actual, id: source.id };
    });
    receipt.hostCatalogBindings = catalog;
    await page.evaluate((catalog) => {
      window.__honuaStudioApp.sourceCatalog = catalog;
      document.querySelector("honua-studio-canvas").viewTransitionMs = 0;
    }, catalog);
    const boundRequirements = Object.fromEntries(
      Object.entries(requirements).map(([taskId, requirement]) => {
        if (requirement.serverRoot !== baseUrl)
          throw new Error(`Style requirement ${taskId} does not bind the owned upstream.`);
        return [taskId, { ...requirement, serverRoot: preview.url }];
      }),
    );
    return {
      requirements: boundRequirements,
      async observe({ taskId, turnIndex, state }) {
        const requirement = boundRequirements[taskId];
        if (!requirement) return [];
        if (state.layers.some((layer) => layer.metadata?.honua?.source))
          throw new Error("Source metadata overrides are not style proof inputs.");
        const turn = { taskId, turnIndex, authoritativeState: state, passed: false };
        receipt.turns.push(turn);
        try {
          await page.evaluate((state) => window.__honuaStudioApp.composition.replaceState(state), state);
          await page.waitForFunction(
            () => {
              const view = document.querySelector("honua-studio-canvas")?.mapView;
              return view?.status === "ready" && typeof view.observeAuthoritativeStyles === "function";
            },
            undefined,
            { timeout: 30000 },
          );
          await page.evaluate(async () => document.querySelector("honua-studio-canvas").mapView.settled());
          if (Object.keys(state.view).length === 0) {
            await page.waitForFunction(
              () => {
                const map = document.querySelector("honua-studio-canvas")?.mapView?.map;
                return map?.isStyleLoaded() && map.areTilesLoaded();
              },
              undefined,
              { timeout: 30000 },
            );
            await Promise.all(captures);
            const descriptor = await page.evaluate((sourceId) => {
              const view = document.querySelector("honua-studio-canvas").mapView;
              const observed = view.observeAuthoritativeStyles().find((entry) => entry.sourceId === sourceId);
              return observed && JSON.parse(observed.binding.descriptorBody);
            }, requirement.sourceId);
            if (!descriptor || descriptor.srid !== 4326)
              throw new Error("Actual source CRS is not verified EPSG:4326.");
            const queryPath = `/rest/services/${descriptor.serviceName.split("/").map(encodeURIComponent).join("/")}/FeatureServer/${descriptor.layerId}/query`;
            const observed = receipt.requests.findLast((entry) => {
              const url = new URL(entry.browserUrl);
              return url.pathname === queryPath && url.searchParams.get("f") === "geojson" && entry.status === 200;
            });
            if (!observed) throw new Error("No actual authenticated GeoJSON response for the style target.");
            const bounds = observedGeoJsonBounds(JSON.parse(observed.response));
            turn.diagnosticViewport = {
              reason: "Authoritative composition leaves view unspecified",
              crs: "EPSG:4326",
              query: observed.upstreamUrl,
              responseSha256: createHash("sha256").update(observed.response).digest("hex"),
              featureBounds: bounds,
            };
            await page.evaluate(
              (bounds) =>
                document
                  .querySelector("honua-studio-canvas")
                  .mapView.map.fitBounds(bounds, { duration: 0, padding: 40 }),
              bounds,
            );
          }
          await page.waitForFunction(
            (sourceId) => {
              const view = document.querySelector("honua-studio-canvas")?.mapView;
              return (
                view?.map?.isStyleLoaded() &&
                view.map.areTilesLoaded() &&
                view
                  .observeAuthoritativeStyles()
                  .some((entry) => entry.sourceId === sourceId && entry.renderedFeatureCount > 0)
              );
            },
            requirement.sourceId,
            { timeout: 30000 },
          );
          const observations = await page.evaluate(() =>
            document.querySelector("honua-studio-canvas").mapView.observeAuthoritativeStyles(),
          );
          await Promise.all(captures);
          if (receipt.errors.length) throw new Error("Browser errors occurred; inspect retained observer receipt.");
          if (JSON.stringify(receipt.buildFiles) !== JSON.stringify(await buildHashes()))
            throw new Error("Production build changed during style observation.");
          const name = `${taskId.replace(/[^a-z0-9-]/gi, "_")}-${turnIndex}`;
          await page.screenshot({ path: resolve(directory, `${name}.png`), fullPage: true });
          turn.observations = observations;
          turn.passed = true;
          return observations;
        } catch (error) {
          turn.error = String(error);
          throw error;
        }
      },
      close,
    };
  } catch (error) {
    receipt.errors.push(String(error));
    await close();
    throw error;
  }
}
