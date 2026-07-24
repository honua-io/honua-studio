/**
 * Mock honua-server fixture (honua-studio#3 REQ-003, honua-studio#4 REQ-001).
 *
 * A tiny, dependency-free `node:http` server that serves canned Studio
 * catalog/lifecycle JSON and stands in for BOTH honua-server and the OIDC
 * identity provider it delegates to (`Oidc__Generic__Authority` in
 * honua-server's own config) — modeled on honua-sdk-js's
 * examples/*\/mock-server.mjs pattern (plain node:http, no framework,
 * exports a start function and is also directly runnable). No network
 * access; loopback only.
 *
 * Routes (unprefixed — vite.config.ts's dev/preview proxy rewrites
 * /api/* -> * and passes /oidc/* straight through before forwarding, so
 * this fixture and a real honua-server + external IdP (behind
 * HONUA_BASE_URL / HONUA_OIDC_ISSUER) are interchangeable from the
 * client's point of view):
 *   GET  /health                                -> { status, mode }
 *   GET  /v1/studio/catalog                      -> { datasets: CatalogDataset[] }   [bearer required]
 *   GET  /v1/studio/packages                     -> { packages: StudioPackageSummary[] } [bearer required]
 *   GET  /v1/studio/ai/capabilities              -> ApiResponse<StudioAiCapabilitiesResponse> [bearer required]
 *   POST /v1/studio/ai/chat                      -> SSE StudioAiChatEvent stream       [bearer required]
 *   GET  /oidc/.well-known/openid-configuration  -> OIDC discovery document
 *   GET  /oidc/authorize                         -> 302, auto-approves the fixture user (no login UI)
 *   POST /oidc/token                             -> authorization_code exchange + refresh_token ROTATION
 *   POST /oidc/revoke                            -> best-effort refresh-token revocation (RFC 7009)
 *
 * Auth model (P2-8 review finding): access tokens are short-lived signed
 * JWTs (HS256, dev-only secret — never used outside this loopback fixture);
 * refresh tokens are opaque and single-use — each `refresh_token` grant
 * deletes the presented token and issues a brand-new one, so a stolen or
 * replayed refresh token stops working the moment the legitimate client
 * rotates it. There is no hidden-iframe silent refresh anywhere in this
 * fixture or in src/auth/ — see docs/embed-session.md.
 *
 * The `/v1/studio/ai/chat` route (honua-studio#6, honua-server#3010) plays
 * `src/chat/fixtures/compose-districts-map.json` back turn-by-turn, keyed
 * by how many `role: "user"` messages the client's own accumulated request
 * history contains (this fixture is stateless server-side — the client's
 * own message history IS the turn cursor) — so `npm run dev`'s default
 * `SseChatTransport` (pointed at `/api`, per `<honua-studio-chat>`'s own
 * default) gets a real, scripted SSE conversation end to end, with zero
 * model credentials anywhere. This route deliberately does NOT import
 * anything from `src/` — this file runs under plain `node`, not a
 * TypeScript loader (see scripts/dev-mock.mjs) — so the SSE event-name
 * vocabulary below is a small, intentionally duplicated mirror of
 * `src/chat/ai-contract.ts`'s `CHAT_EVENT_TYPE_TO_SSE_NAME`, and the
 * fixture JSON is read directly via `node:fs`, never through a `.ts` import.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";

// Mirrors src/chat/ai-contract.ts's CHAT_EVENT_TYPE_TO_SSE_NAME — see this
// file's module doc for why it's a duplicate, not an import.
const CHAT_EVENT_TYPE_TO_SSE_NAME = {
  messageStart: "message_start",
  textDelta: "text_delta",
  toolCallStart: "tool_call_start",
  toolCallDelta: "tool_call_delta",
  toolCallStop: "tool_call_stop",
  messageStop: "message_stop",
  error: "error",
};

const FIXTURE_CONVERSATION = JSON.parse(
  readFileSync(new URL("./src/chat/fixtures/compose-districts-map.json", import.meta.url), "utf8"),
);

const AI_CAPABILITIES = {
  enabled: true,
  defaultProvider: "fixture",
  providers: [
    {
      provider: "fixture",
      kind: "fixture",
      model: "claude-sonnet-4-5-20250929",
      maxTokens: 4096,
      toolSupport: true,
      streaming: true,
      isDefault: true,
      configured: true,
    },
  ],
};

/** Writes one SSE frame exactly as honua-server#3010's `StudioAiProxyEndpoints.WriteSseEventAsync` does: `event: <name>\ndata: <json>\n\n`. */
function writeSseEvent(res, event) {
  const sseName = CHAT_EVENT_TYPE_TO_SSE_NAME[event.type] ?? "message";
  res.write(`event: ${sseName}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

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

/** Public client the mock IdP accepts — matches src/auth/config.ts's dev default. */
export const OIDC_CLIENT_ID = "honua-studio-dev";

/** The fixture user the mock authorize endpoint auto-approves; never a login prompt. */
const FIXTURE_USER = {
  sub: "studio-dev-user",
  name: "Dev User",
  email: "dev@honua.io",
  roles: ["admin"],
};

const ACCESS_TOKEN_TTL_SECONDS = 60;
const AUTHORIZATION_CODE_TTL_MS = 60_000;

// Loopback-only dev fixture secret. Real deployments never see this — a real
// honua-server validates bearer tokens against its configured OIDC
// provider's JWKS (Oidc__Generic__Authority), not against this constant.
const DEV_ONLY_JWT_SECRET = "honua-studio-mock-oidc-dev-secret-not-for-production";

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signFixtureJwt(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", DEV_ONLY_JWT_SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Verifies signature + expiry; returns the decoded payload, or null. */
function verifyFixtureJwt(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, signature] = parts;
  const expected = createHmac("sha256", DEV_ONLY_JWT_SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  if (!timingSafeEqualStrings(signature, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return null;
  return payload;
}

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    // Permissive CORS: this is a loopback dev fixture, never deployed. The
    // authorize/token endpoints are reached cross-origin (their absolute
    // URLs come from the discovery document, not the studio app's own
    // origin/proxy), so CORS must be open for the token exchange fetch.
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    ...extraHeaders,
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function unauthorized(res) {
  json(res, 401, { error: { code: 401, message: "Unauthorized" } }, { "www-authenticate": "Bearer" });
}

/**
 * Starts the fixture server on an ephemeral loopback port.
 * @returns {Promise<{ server: import("node:http").Server, url: string, close: () => Promise<void> }>}
 */
export async function startMockServer({ port = 0 } = {}) {
  // Pending authorization codes -> { codeChallenge, redirectUri, expiresAt }.
  const pendingCodes = new Map();
  // Active (unrotated) refresh tokens -> true. Deleted the moment they're
  // spent, so replaying a rotated-out refresh token always 400s.
  const activeRefreshTokens = new Set();

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = requestUrl.pathname;
    const issuer = `http://${req.headers.host}/oidc`;

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization",
      });
      res.end();
      return;
    }

    // ── OIDC discovery ──────────────────────────────────────────
    if (pathname === "/oidc/.well-known/openid-configuration" && req.method === "GET") {
      json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        revocation_endpoint: `${issuer}/revoke`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        id_token_signing_alg_values_supported: ["HS256"],
        scopes_supported: ["openid", "profile", "email", "honua.read", "honua.write"],
      });
      return;
    }

    // ── OIDC: authorization endpoint (auto-approves the fixture user) ──
    if (pathname === "/oidc/authorize" && req.method === "GET") {
      const params = requestUrl.searchParams;
      const clientId = params.get("client_id");
      const redirectUri = params.get("redirect_uri");
      const state = params.get("state") ?? "";
      const codeChallenge = params.get("code_challenge");
      const method = params.get("code_challenge_method");
      if (clientId !== OIDC_CLIENT_ID || !redirectUri || !codeChallenge || method !== "S256") {
        json(res, 400, { error: "invalid_request" });
        return;
      }
      const code = randomUUID();
      pendingCodes.set(code, {
        codeChallenge,
        redirectUri,
        expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS,
      });
      const location = new URL(redirectUri);
      location.searchParams.set("code", code);
      location.searchParams.set("state", state);
      res.writeHead(302, { location: location.toString() });
      res.end();
      return;
    }

    // ── OIDC: token endpoint (code exchange + refresh-token rotation) ──
    if (pathname === "/oidc/token" && req.method === "POST") {
      const body = new URLSearchParams(await readBody(req));
      const grantType = body.get("grant_type");

      if (grantType === "authorization_code") {
        const code = body.get("code") ?? "";
        const verifier = body.get("code_verifier") ?? "";
        const pending = pendingCodes.get(code);
        pendingCodes.delete(code); // single-use regardless of outcome
        const challenge = await webCryptoPkceChallenge(verifier);
        if (
          !pending ||
          pending.expiresAt < Date.now() ||
          body.get("client_id") !== OIDC_CLIENT_ID ||
          challenge !== pending.codeChallenge
        ) {
          json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
          return;
        }
        const refreshToken = randomUUID();
        activeRefreshTokens.add(refreshToken);
        json(res, 200, issueTokenResponse({ issuer, refreshToken, scope: body.get("scope") }));
        return;
      }

      if (grantType === "refresh_token") {
        const presented = body.get("refresh_token") ?? "";
        if (body.get("client_id") !== OIDC_CLIENT_ID || !activeRefreshTokens.has(presented)) {
          json(res, 400, { error: "invalid_grant", error_description: "unknown or already-rotated refresh token" });
          return;
        }
        // Rotation: the presented token is spent unconditionally, and a
        // fresh one takes its place — replaying `presented` after this
        // point always fails, even if the response below is lost in
        // flight (fail-closed, matches P2-8's rotation requirement).
        activeRefreshTokens.delete(presented);
        const rotated = randomUUID();
        activeRefreshTokens.add(rotated);
        json(res, 200, issueTokenResponse({ issuer, refreshToken: rotated, scope: body.get("scope") }));
        return;
      }

      json(res, 400, { error: "unsupported_grant_type" });
      return;
    }

    // ── OIDC: revocation endpoint (RFC 7009, best-effort) ───────
    if (pathname === "/oidc/revoke" && req.method === "POST") {
      const body = new URLSearchParams(await readBody(req));
      activeRefreshTokens.delete(body.get("token") ?? "");
      json(res, 200, {});
      return;
    }

    // ── Protected Studio API routes ─────────────────────────────
    if (pathname === "/v1/studio/catalog" && req.method === "GET") {
      if (!verifyFixtureJwt(bearerToken(req))) {
        unauthorized(res);
        return;
      }
      json(res, 200, CATALOG);
      return;
    }
    if (pathname === "/v1/studio/packages" && req.method === "GET") {
      if (!verifyFixtureJwt(bearerToken(req))) {
        unauthorized(res);
        return;
      }
      json(res, 200, PACKAGES);
      return;
    }
    if (pathname === "/v1/studio/ai/capabilities" && req.method === "GET") {
      if (!verifyFixtureJwt(bearerToken(req))) {
        unauthorized(res);
        return;
      }
      json(res, 200, { success: true, data: AI_CAPABILITIES });
      return;
    }
    // ── Studio AI proxy: fixture chat SSE stream (honua-studio#6) ──
    if (pathname === "/v1/studio/ai/chat" && req.method === "POST") {
      if (!verifyFixtureJwt(bearerToken(req))) {
        unauthorized(res);
        return;
      }
      let requestBody;
      try {
        requestBody = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "invalid_request", message: "Malformed JSON body." });
        return;
      }
      const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
      if (messages.length === 0) {
        json(res, 400, { error: "invalid_request", message: "At least one message is required." });
        return;
      }
      const turnIndex = messages.filter((m) => m?.role === "user").length - 1;
      const turn = FIXTURE_CONVERSATION.turns[turnIndex];

      // Tracks a REAL client disconnect (the response socket closing), not
      // `req.destroyed` — that flips true the moment `readBody()` above
      // finishes draining the request body (Node's `Readable` streams
      // auto-destroy on `'end'`), which happens on every normal request and
      // has nothing to do with whether the client is still there for the
      // response half.
      let clientDisconnected = false;
      res.once("close", () => {
        clientDisconnected = true;
      });

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        pragma: "no-cache",
        "access-control-allow-origin": "*",
      });
      if (!turn) {
        writeSseEvent(res, {
          type: "error",
          errorMessage: `mock-server fixture: no scripted turn ${turnIndex} in "${FIXTURE_CONVERSATION.id}".`,
        });
        res.end();
        return;
      }
      for (const event of turn.assistant.events) {
        if (clientDisconnected) break; // client disconnected/aborted mid-stream — matches the real proxy's cancellation convention
        writeSseEvent(res, event);
      }
      res.end();
      return;
    }
    if (pathname === "/health" && req.method === "GET") {
      json(res, 200, { status: "ok", mode: "mock" });
      return;
    }

    json(res, 404, { error: "not_found", path: pathname });
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

function bearerToken(req) {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

/**
 * Mints a signed fixture access token outside the OIDC token endpoint —
 * used by tests that simulate an embed HOST already holding a session (see
 * docs/embed-session.md's host-adapter mode), where the token legitimately
 * comes from a different origin/session than this fixture's own OIDC issuer,
 * but must still pass this fixture's bearer verification the same way a real
 * honua-server would validate any token signed by the operator's configured
 * IdP.
 */
export function mintFixtureAccessToken({
  issuer = "https://console.example/oidc",
  ttlSeconds = ACCESS_TOKEN_TTL_SECONDS,
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signFixtureJwt({
    iss: issuer,
    sub: FIXTURE_USER.sub,
    aud: OIDC_CLIENT_ID,
    name: FIXTURE_USER.name,
    email: FIXTURE_USER.email,
    roles: FIXTURE_USER.roles,
    scope: "openid profile honua.read honua.write",
    iat: now,
    exp: now + ttlSeconds,
  });
}

function issueTokenResponse({ issuer, refreshToken, scope }) {
  const now = Math.floor(Date.now() / 1000);
  const resolvedScope = scope || "openid profile honua.read honua.write";
  const accessToken = signFixtureJwt({
    iss: issuer,
    sub: FIXTURE_USER.sub,
    aud: OIDC_CLIENT_ID,
    name: FIXTURE_USER.name,
    email: FIXTURE_USER.email,
    roles: FIXTURE_USER.roles,
    scope: resolvedScope,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
  });
  const idToken = signFixtureJwt({
    iss: issuer,
    sub: FIXTURE_USER.sub,
    aud: OIDC_CLIENT_ID,
    name: FIXTURE_USER.name,
    email: FIXTURE_USER.email,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
  });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refreshToken,
    scope: resolvedScope,
    id_token: idToken,
  };
}

/** base64url(SHA-256(verifier)) via WebCrypto — Node >=20 exposes globalThis.crypto. */
async function webCryptoPkceChallenge(verifier) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url");
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
