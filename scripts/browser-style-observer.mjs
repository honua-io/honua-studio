import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { startPreviewServer } from "../test/playwright/helpers.mjs";
import { observedGeoJsonBounds } from "./lib/observed-geojson-bounds.mjs";
import { bindObservedSources } from "./lib/observer-source-bindings.mjs";
import { bindOwnedDeployment } from "./lib/owned-deployment-binding.mjs";
import { collectRenderedWidgetObservations, requireRenderedWidgetData } from "./lib/rendered-widget-observations.mjs";
import {
  bindWidgetFeatureResponse,
  expectedChartValues,
  expectedWidgetData,
  requireMatchingWidgetData,
} from "./lib/widget-data-expectations.mjs";

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
export async function createBrowserStyleObserver({
  baseUrl,
  tokenProvider,
  sources,
  requirements,
  directory,
  deploymentReceipt,
}) {
  if (typeof tokenProvider !== "function")
    throw new Error("Browser style evidence requires a fresh host token provider.");
  if (!Array.isArray(sources))
    throw new Error("Browser style evidence requires explicit trusted host source descriptors.");
  const deployment = await bindOwnedDeployment(deploymentReceipt, baseUrl);
  const receipt = {
    deployment: deployment.identity,
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
  let modules;
  let requestSequence = 0;
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
    try {
      receipt.deploymentAfter = await deployment.verify();
    } catch (error) {
      receipt.errors.push(String(error));
      receipt.deploymentChanged = true;
    }
    await browser?.close();
    await preview?.close();
    await modules?.close();
    await writeFile(resolve(directory, "browser-style-observer.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    if (receipt.deploymentChanged) throw new Error("Owned deployment changed during browser style observation.");
  };
  try {
    modules = await createServer({
      root: process.cwd(),
      configFile: false,
      server: { middlewareMode: true, hmr: false, ws: false },
      appType: "custom",
    });
    const pipelinePaths = [
      "src/widgets/widget-config.ts",
      "src/widgets/widget-data.ts",
      "src/widgets/chart-spec.ts",
      "src/widgets/chart-data.ts",
      "src/widgets/chart-render.ts",
      "src/map/source-resolution.ts",
    ];
    const pipeline = Object.assign(
      {},
      ...(await Promise.all(pipelinePaths.map((path) => modules.ssrLoadModule(`/${path}`)))),
    );
    receipt.expectedPipelineSourceHashes = Object.fromEntries(
      await Promise.all(
        pipelinePaths.map(async (path) => [
          path,
          createHash("sha256")
            .update(await readFile(resolve(path)))
            .digest("hex"),
        ]),
      ),
    );
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
      const sequence = requestSequence++;
      captures.push(
        (async () => {
          const request = response.request();
          receipt.requests.push({
            sequence,
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
    await page.waitForFunction(() => Boolean(window.__honuaStudioApp?.sourceCatalog?.length));
    const discovered = await page.evaluate(() => window.__honuaStudioApp.studioClient.listCatalog());
    receipt.discoveredCatalog = discovered;
    const catalog = bindObservedSources(sources, discovered, baseUrl, preview.url);
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
        if (!requirement && !state.widgets.some((widget) => widget.kind === "chart" || widget.kind === "table"))
          return [];
        if (state.layers.some((layer) => layer.metadata?.honua?.source))
          throw new Error("Source metadata overrides are not style proof inputs.");
        const turn = { taskId, turnIndex, authoritativeState: state, passed: false };
        receipt.turns.push(turn);
        try {
          await page.evaluate((state) => window.__honuaStudioApp.composition.replaceState(state), state);
          if (requirement) {
            await page.waitForFunction(
              () => {
                const view = document.querySelector("honua-studio-canvas")?.mapView;
                return view?.status === "ready" && typeof view.observeAuthoritativeStyles === "function";
              },
              undefined,
              { timeout: 30000 },
            );
            await page.evaluate(async () => {
              const view = document.querySelector("honua-studio-canvas").mapView;
              await view.settled();
              await view.refreshAuthoritativeStyles();
            });
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
          }
          const observations = requirement
            ? await page.evaluate(() =>
                document.querySelector("honua-studio-canvas").mapView.observeAuthoritativeStyles(),
              )
            : [];
          // Observe the real rendered card, including visible data errors which never reach console.error.
          const widgetDeadline = Date.now() + 30000;
          do {
            turn.widgets = await page.evaluate(collectRenderedWidgetObservations, state.widgets);
            if (!turn.widgets.some((entry) => entry.state === "loading")) break;
            await page.waitForTimeout(50);
          } while (Date.now() < widgetDeadline);
          requireRenderedWidgetData(turn.widgets);
          await Promise.all(captures);
          turn.widgetDataBindings = [];
          for (const widget of state.widgets.filter((entry) => entry.kind === "chart" || entry.kind === "table")) {
            const resolved = pipeline.resolveCompositionSource(
              { id: widget.sourceId, sourceId: widget.sourceId, visible: true },
              { catalog, baseUrl: `${preview.url}/api`, featureLimit: 500 },
            );
            if (!pipeline.isCompositionSourceResolution(resolved) || typeof resolved.source.data !== "string")
              throw new Error("Widget source did not resolve to a captured feature query.");
            const queryUrl = new URL(resolved.source.data, preview.url).href;
            const bound = bindWidgetFeatureResponse(
              queryUrl,
              [...receipt.requests].sort((a, b) => a.sequence - b.sequence),
            );
            const expected = expectedWidgetData(widget, bound.collection, pipeline);
            if (expected.kind === "chart")
              expected.renderedValues = await page.evaluate(expectedChartValues, expected.svg);
            const actual = turn.widgets.find((entry) => entry.widgetId === widget.id);
            requireMatchingWidgetData(actual, expected);
            const { svg: _svg, ...retainedExpected } = expected;
            turn.widgetDataBindings.push({
              widgetId: widget.id,
              sourceId: widget.sourceId,
              config: widget.config,
              query: queryUrl,
              upstreamQuery: bound.request.upstreamUrl,
              responseSequence: bound.request.sequence,
              responseSha256: createHash("sha256").update(bound.request.response).digest("hex"),
              featureCount: bound.collection.features.length,
              expected: retainedExpected,
              actual,
            });
            const visible = await page.evaluate(async (id) => {
              const root = document.querySelector("honua-studio-canvas")?.widgetDeck?.shadowRoot;
              const card = [...(root?.querySelectorAll('[data-testid="studio-widget"]') ?? [])].find(
                (entry) => entry.dataset.widgetId === id,
              );
              if (!card) throw new Error("Rendered widget disappeared.");
              card.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
              await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              const body = card.querySelector(
                '[data-testid="studio-widget-chart"] svg, [data-testid="studio-widget-grid"]',
              );
              if (!body) throw new Error("Widget visualization disappeared.");
              const rect = body.getBoundingClientRect();
              return {
                visible: body.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                viewportWidth: innerWidth,
                viewportHeight: innerHeight,
              };
            }, widget.id);
            if (
              !visible.visible ||
              visible.width <= 0 ||
              visible.height <= 0 ||
              visible.x >= visible.viewportWidth ||
              visible.y >= visible.viewportHeight ||
              visible.x + visible.width <= 0 ||
              visible.y + visible.height <= 0
            )
              throw new Error("Widget body is not visibly painted in the viewport.");
            actual.visibility = visible;
            await page.screenshot({
              path: resolve(
                directory,
                `${taskId.replace(/[^a-z0-9-]/gi, "_")}-${turnIndex}-widget-${widget.id.replace(/[^a-z0-9-]/gi, "_")}.png`,
              ),
            });
            // Re-read the real DOM after paint; never rely on the pre-scroll snapshot alone.
            const afterPaint = (await page.evaluate(collectRenderedWidgetObservations, [widget]))[0];
            requireRenderedWidgetData([afterPaint]);
            requireMatchingWidgetData(afterPaint, expected);
          }
          if (receipt.errors.length) throw new Error("Browser errors occurred; inspect retained observer receipt.");
          if (JSON.stringify(receipt.buildFiles) !== JSON.stringify(await buildHashes()))
            throw new Error("Production build changed during style observation.");
          const name = `${taskId.replace(/[^a-z0-9-]/gi, "_")}-${turnIndex}`;
          await page.screenshot({ path: resolve(directory, `${name}.png`), fullPage: true });
          turn.deployment = await deployment.verify();
          turn.observations = observations;
          turn.passed = true;
          return observations;
        } catch (error) {
          turn.error = String(error);
          await page.screenshot({
            path: resolve(directory, `${taskId.replace(/[^a-z0-9-]/gi, "_")}-${turnIndex}-failed.png`),
            fullPage: true,
          });
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
