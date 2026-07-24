/**
 * Mock honua-server fixture (honua-studio#3 REQ-003).
 *
 * A tiny, dependency-free `node:http` server that serves canned Studio
 * catalog/lifecycle JSON — modeled on honua-sdk-js's examples/*\/mock-server.mjs
 * pattern (plain node:http, no framework, exports a start function and is
 * also directly runnable). No network access; loopback only.
 *
 * Routes (unprefixed — vite.config.ts's dev/preview proxy rewrites
 * /api/* -> * before forwarding, so this fixture and a real honua-server
 * behind HONUA_BASE_URL are interchangeable from the client's point of view):
 *   GET /health            -> { status, mode }
 *   GET /v1/studio/catalog  -> { datasets: CatalogDataset[] }
 *   GET /v1/studio/packages -> { packages: StudioPackageSummary[] }
 */
import http from "node:http";
import { fileURLToPath } from "node:url";

const CATALOG = {
  datasets: [
    { id: "hi-parcels", title: "Hawai'i statewide parcels", protocol: "ogc-features", geometryType: "Polygon" },
    {
      id: "hi-roads",
      title: "Hawai'i road centerlines",
      protocol: "geoservices-feature-service",
      geometryType: "LineString",
    },
    { id: "hi-wells", title: "Groundwater monitoring wells", protocol: "ogc-features", geometryType: "Point" },
    { id: "hi-imagery", title: "Statewide orthoimagery (COG)", protocol: "stac", geometryType: "Raster" },
  ],
};

const PACKAGES = {
  packages: [
    {
      id: "pkg-composing-districts",
      family: "map",
      format: "honua_map_package.v1",
      status: "Composing",
      title: "Operations districts overview",
      updatedAt: "2026-07-20T18:04:00Z",
    },
    {
      id: "pkg-draft-wells",
      family: "query",
      format: "honua_query_package.v1",
      status: "Draft",
      title: "Wells below threshold",
      updatedAt: "2026-07-21T09:12:00Z",
    },
    {
      id: "pkg-ready-dashboard",
      family: "dashboard",
      format: "honua_dashboard_package.v1",
      status: "Ready",
      title: "Statewide roads condition dashboard",
      updatedAt: "2026-07-18T14:47:00Z",
    },
  ],
};

const ROUTES = {
  "/health": () => ({ status: "ok", mode: "mock" }),
  "/v1/studio/catalog": () => CATALOG,
  "/v1/studio/packages": () => PACKAGES,
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    // Permissive CORS: this is a loopback dev fixture, never deployed.
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

/**
 * Starts the fixture server on an ephemeral loopback port.
 * @returns {Promise<{ server: import("node:http").Server, url: string, close: () => Promise<void> }>}
 */
export async function startMockServer({ port = 0 } = {}) {
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const handler = ROUTES[requestUrl.pathname];
    if (req.method !== "GET" || !handler) {
      json(res, 404, { error: "not_found", path: requestUrl.pathname });
      return;
    }
    json(res, 200, handler());
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(undefined));
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Mock honua-server fixture failed to bind a loopback TCP port.");
  }
  const url = `http://127.0.0.1:${address.port}`;

  const close = () =>
    new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve(undefined)));
    });

  return { server, url, close };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url, close } = await startMockServer({ port: process.env.PORT ? Number(process.env.PORT) : 0 });
  process.stdout.write(`[honua-studio] mock honua-server fixture listening at ${url}\n`);

  const shutdown = async () => {
    await close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
