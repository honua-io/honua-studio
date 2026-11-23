import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  liveApprovalBrowserArguments,
  liveApprovalConfiguration,
  liveApprovalConfigured,
  liveApprovalEnvironmentNames,
  publishedRouteLinks,
} from "../lib/live-approval-config.mjs";
import { approverRealm, studioComposeOverlay, validateImageLock } from "../lib/live-compose.mjs";

const lock = JSON.parse(readFileSync(new URL("../live-compose-images.json", import.meta.url), "utf8"));

test("the approval browser trusts only an explicitly supplied certificate pin", () => {
  assert.deepEqual(liveApprovalBrowserArguments({ HONUA_LIVE_CONSOLE_URL: "http://127.0.0.1:5174" }), []);
  const pin = `${"a".repeat(43)}=`;
  assert.deepEqual(liveApprovalBrowserArguments({ HONUA_LIVE_APPROVER_IDP_SPKI: pin }), [
    `--ignore-certificate-errors-spki-list=${pin}`,
  ]);
  assert.throws(() => liveApprovalBrowserArguments({ HONUA_LIVE_APPROVER_IDP_SPKI: `${pin},untrusted` }));
  const settings = Object.fromEntries(Object.values(liveApprovalEnvironmentNames).map((name) => [name, "synthetic"]));
  assert.equal(liveApprovalConfigured(settings), true);
  settings.HONUA_LIVE_APPROVER_PASSWORD = undefined;
  assert.equal(liveApprovalConfigured(settings), false);
});

test("the approval browser pins exactly the identity provider and Console edge certificates", () => {
  const idp = `${"a".repeat(43)}=`;
  const edge = `${"b".repeat(43)}=`;
  assert.deepEqual(liveApprovalBrowserArguments({ HONUA_LIVE_APPROVER_IDP_SPKI: idp, HONUA_LIVE_CONSOLE_SPKI: edge }), [
    `--ignore-certificate-errors-spki-list=${idp},${edge}`,
  ]);
  assert.throws(() => liveApprovalBrowserArguments({ HONUA_LIVE_CONSOLE_SPKI: "not-a-pin" }), /CONSOLE_SPKI/);
});

test("only the server-hosted Console needs an environment profile id", () => {
  const settings = {
    HONUA_LIVE_CONSOLE_URL: "https://localhost:18083/console",
    HONUA_LIVE_APPROVER_IDP_ORIGIN: "https://host.docker.internal:8443",
    HONUA_LIVE_APPROVER_USERNAME: "studio-approver",
    HONUA_LIVE_APPROVER_PASSWORD: "synthetic",
  };
  assert.equal(liveApprovalConfigured(settings), true);
  assert.equal(liveApprovalConfiguration(settings).profileId, undefined);
  const serverHosted = { ...settings, HONUA_LIVE_CONSOLE_URL: "https://demo.example.test" };
  assert.equal(liveApprovalConfigured(serverHosted), false);
  assert.throws(() => liveApprovalConfiguration(serverHosted), /HONUA_LIVE_CONSOLE_PROFILE_ID/);
});

test("audience links read the server's native route through the static Console edge", () => {
  assert.deepEqual(publishedRouteLinks("https://localhost:18083/console/", "/district"), {
    definition: "https://localhost:18083/api/v1/studio/published/district",
    map: "https://localhost:18083/console/maps/published/district",
  });
  assert.deepEqual(publishedRouteLinks("https://demo.example.test", "/district"), {
    definition: "https://demo.example.test/api/studio/viewer/published/district",
    map: "https://demo.example.test/maps/published/district",
  });
});

test("qualification refuses mutable images and a mismatched server/executor candidate", () => {
  assert.doesNotThrow(() => validateImageLock(lock));
  for (const component of ["server", "executor"]) {
    const changed = structuredClone(lock);
    changed[component].image = `ghcr.io/honua-io/honua-${component}:latest`;
    assert.throws(() => validateImageLock(changed), /immutable/);
  }
  const changed = structuredClone(lock);
  changed.executor.revision = "a".repeat(40);
  assert.throws(() => validateImageLock(changed), /same candidate/);
});

test("qualification pins the official static Console build, not a container image", () => {
  assert.equal(lock.console.image, undefined);
  for (const [field, value, message] of [
    ["revision", "trunk", /source revision/],
    ["runId", "latest", /run and artifact ids/],
    ["artifactId", 0, /run and artifact ids/],
    ["artifact", "honua-console-preview", /honua-console-web/],
    ["artifactDigest", "3cbc57bb", /sha256 digest/],
  ]) {
    const changed = structuredClone(lock);
    changed.console[field] = value;
    assert.throws(() => validateImageLock(changed), message);
  }
});

test("the seeded approver is a person using authorization code with PKCE, never a service account", () => {
  const realm = approverRealm({ password: "synthetic-password", clientSecret: "synthetic-client-secret" });
  assert.equal(realm.users.length, 1);
  assert.equal(realm.users[0].username, "studio-approver");
  assert.deepEqual(realm.users[0].realmRoles, ["admin", "user"]);
  assert.equal(realm.users[0].credentials[0].value, "synthetic-password");
  assert.equal(realm.clients[0].directAccessGrantsEnabled, false);
  assert.equal(realm.clients[0].serviceAccountsEnabled, false);
  assert.equal(realm.clients[0].standardFlowEnabled, true);
  assert.equal(realm.clients[0].attributes["pkce.code.challenge.method"], "S256");
  assert.deepEqual(realm.clients[0].redirectUris, ["https://localhost:18083/admin/auth/callback"]);
});

test("customer overlay preserves publication authorization and configures only direct Opus", () => {
  const overlay = studioComposeOverlay(lock);
  const server = overlay.services.honua;
  assert.equal(server.image, lock.server.image);
  // The quickstart's own Console edge (compose.console.yaml) serves the static bundle unchanged.
  assert.equal(overlay.services.console, undefined);
  assert.equal(server.environment.PUBLIC_BASE_URL, undefined);
  assert.equal(overlay.services["compose-executor"], undefined);
  assert.equal(server.environment.Studio__EndUserAuthorization__Enabled, "true");
  assert.equal(server.environment.StudioAiProxy__Providers__opus__Kind, "anthropic");
  assert.equal(server.environment.StudioAiProxy__Providers__opus__Model, "claude-opus-5-5");
  assert.equal(server.environment.StudioAiProxy__Providers__opus__MaxTokens, "1024");
  assert.equal(server.environment.StudioAiProxy__Providers__opus__Endpoint, "https://api.anthropic.com");
  assert.equal(server.environment.StudioAiProxy__Disclosure__Approvals__0__Model, "claude-opus-5-5");
  assert.equal(server.environment.AiExecutionAdmission__Backend, "postgres");
  assert.equal(server.environment.HONUA_SECRET_FILE__HONUA_STUDIOAI_OPUS_API_KEY, "/run/secrets/anthropic_api_key");
  assert.equal(server.environment.StudioAiProxy__Providers__opus__ApiKey, undefined);
  assert.equal(overlay.services.keycloak.environment.KC_HTTP_ENABLED, "false");
  assert.deepEqual(overlay.services.keycloak.networks.default.aliases, ["host.docker.internal"]);
  assert.equal(server.extra_hosts, undefined);
});

test("the approval observer leaves the customer quickstart and identity ports available", async () => {
  const { approvalObserverPort } = await import("../lib/live-diagnostics.mjs");
  for (const reservedPort of [18080, 18081, 18082, 18083, 8443]) assert.notEqual(approvalObserverPort, reservedPort);
});

test("the model-free overlay keeps human authorization without provider configuration or credentials", () => {
  const full = studioComposeOverlay(lock);
  const overlay = studioComposeOverlay(lock, { mode: "oidc-lifecycle" });
  const environment = overlay.services.honua.environment;
  assert.equal(environment.StudioAiProxy__Enabled, "false");
  assert.deepEqual(
    Object.keys(environment).filter((key) => key.startsWith("StudioAiProxy__")),
    ["StudioAiProxy__Enabled"],
  );
  assert.equal(environment.HONUA_SECRET_FILE__HONUA_STUDIOAI_OPUS_API_KEY, undefined);
  assert.equal(environment.Studio__EndUserAuthorization__Enabled, "true");
  assert.deepEqual(overlay.services.console, full.services.console);
  assert.deepEqual(overlay.services.keycloak, full.services.keycloak);
  for (const key of Object.keys(full.services.honua.environment).filter((name) => name.startsWith("Oidc__"))) {
    assert.equal(environment[key], full.services.honua.environment[key]);
  }
  assert.equal(overlay.secrets.anthropic_api_key, undefined);
  assert.equal(overlay.services.honua.secrets.includes("anthropic_api_key"), false);
});
