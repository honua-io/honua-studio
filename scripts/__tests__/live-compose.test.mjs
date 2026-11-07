import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { approverRealm, studioComposeOverlay, validateImageLock } from "../lib/live-compose.mjs";

const lock = JSON.parse(readFileSync(new URL("../live-compose-images.json", import.meta.url), "utf8"));

test("qualification refuses mutable images and a mismatched server/executor candidate", () => {
  assert.doesNotThrow(() => validateImageLock(lock));
  for (const component of ["server", "console", "executor"]) {
    const changed = structuredClone(lock);
    changed[component].image = `ghcr.io/honua-io/honua-${component}:latest`;
    assert.throws(() => validateImageLock(changed), /immutable/);
  }
  const changed = structuredClone(lock);
  changed.executor.revision = "a".repeat(40);
  assert.throws(() => validateImageLock(changed), /same candidate/);
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
  assert.deepEqual(realm.clients[0].redirectUris, ["http://127.0.0.1:5174/admin/auth/callback"]);
});

test("customer overlay preserves publication authorization and configures only direct Opus", () => {
  const overlay = studioComposeOverlay(lock);
  const server = overlay.services.honua;
  assert.equal(server.image, lock.server.image);
  assert.equal(overlay.services.console.image, lock.console.image);
  assert.equal(overlay.services["compose-executor"], undefined);
  assert.equal(server.environment.Studio__EndUserAuthorization__Enabled, "true");
  assert.equal(server.environment.StudioAiProxy__Providers__opus__Kind, "anthropic");
  assert.equal(server.environment.StudioAiProxy__Providers__opus__Model, "claude-opus-5-5");
  assert.equal(server.environment.StudioAiProxy__Providers__opus__Endpoint, "https://api.anthropic.com");
  assert.equal(server.environment.StudioAiProxy__Disclosure__Approvals__0__Model, "claude-opus-5-5");
  assert.equal(server.environment.AiExecutionAdmission__Backend, "postgres");
  assert.equal(server.environment.HONUA_SECRET_FILE__HONUA_STUDIOAI_OPUS_API_KEY, "/run/secrets/anthropic_api_key");
  assert.equal(server.environment.StudioAiProxy__Providers__opus__ApiKey, undefined);
  assert.equal(overlay.services.console.environment.HONUA_ADMIN_API_KEY, "");
  assert.equal(overlay.services.console.environment.Honua__Server__AdminApiKey, "");
  assert.equal(overlay.services.keycloak.environment.KC_HTTP_ENABLED, "false");
  assert.equal(
    overlay.services.console.volumes.some((value) => value.includes("docker.sock")),
    false,
  );
});
