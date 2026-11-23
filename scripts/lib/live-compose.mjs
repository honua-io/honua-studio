import { liveModelLimits } from "./live-model-guard.mjs";

// The quickstart's Console edge: the static bundle at /console/, every other path forwarded to the server.
export const consoleOrigin = "https://localhost:18083";
export const consoleUrl = `${consoleOrigin}/console`;
export const identityOrigin = "https://host.docker.internal:8443";
export const serverOrigin = "http://127.0.0.1:18080";
export const realmName = "studio-live";
const consoleClientId = "studio-console";
export const studioSecretNames = {
  provider: "anthropic_api_key",
  oidcClient: "oidc_client_secret",
  operatorSigning: "operator_signing_key",
};
const tokenClaims = {
  "jsonType.label": "String",
  "id.token.claim": "true",
  "access.token.claim": "true",
  "userinfo.token.claim": "true",
};

export function validateImageLock(lock) {
  for (const component of ["server", "executor"]) {
    if (!/^ghcr.io\/honua-io\/honua-server@sha256:[a-f0-9]{64}$/.test(lock[component]?.image)) {
      throw new Error(`${component} needs an immutable Honua image digest.`);
    }
    if (!/^[a-f0-9]{40}$/.test(lock[component].revision)) throw new Error(`${component} needs its source revision.`);
  }
  if (lock.server.revision !== lock.executor.revision)
    throw new Error("Server and executor must use the same candidate.");
  validateConsoleBundle(lock.console);
}

/** Console ships as the official static build (honua-console ci.yml artifact), not a container image. */
export function validateConsoleBundle(bundle) {
  if (!/^[a-f0-9]{40}$/.test(bundle?.revision ?? "")) throw new Error("console needs its source revision.");
  if (!/^[1-9]\d*$/.test(String(bundle.runId)) || !/^[1-9]\d*$/.test(String(bundle.artifactId)))
    throw new Error("console needs the official build run and artifact ids.");
  if (bundle.artifact !== "honua-console-web") throw new Error("console must pin the honua-console-web artifact.");
  if (!/^sha256:[a-f0-9]{64}$/.test(bundle.artifactDigest ?? ""))
    throw new Error("console needs the artifact sha256 digest.");
}

export function studioComposeOverlay(lock, { mode = "full" } = {}) {
  validateImageLock(lock);
  const secretNames = Object.values(studioSecretNames).filter(
    (name) => mode !== "oidc-lifecycle" || name !== studioSecretNames.provider,
  );
  return {
    services: {
      honua: {
        image: lock.server.image,
        environment: studioServerEnvironment(mode),
        secrets: secretNames,
        volumes: ["./identity/certs:/certs:ro"],
        depends_on: { keycloak: { condition: "service_started" } },
      },
      keycloak: keycloakService(),
    },
    secrets: Object.fromEntries(secretNames.map((name) => [name, { file: `./secrets/${name}` }])),
  };
}

/** Customer settings that route Console sign-in through the server to the test realm (console.config.json). */
export function consoleOidcSettings() {
  return {
    HONUA_CONSOLE_AUTH_MODE: "oidc",
    HONUA_CONSOLE_OIDC_AUTHORITY: `${identityOrigin}/realms/${realmName}`,
    HONUA_CONSOLE_OIDC_CLIENT_ID: consoleClientId,
  };
}

function studioServerEnvironment(mode) {
  const environment = {
    Studio__EndUserAuthorization__Enabled: "true",
    Oidc__Enabled: "true",
    Oidc__Generic__Enabled: "true",
    Oidc__Generic__Authority: `${identityOrigin}/realms/${realmName}`,
    Oidc__Generic__ClientId: consoleClientId,
    HONUA_SECRET_FILE__Oidc__Generic__ClientSecret: `/run/secrets/${studioSecretNames.oidcClient}`,
    Authentication__OperatorBearer__Enabled: "true",
    HONUA_SECRET_FILE__Authentication__OperatorBearer__SigningKey: `/run/secrets/${studioSecretNames.operatorSigning}`,
    SSL_CERT_FILE: "/certs/ca-bundle.crt",
    StudioAiProxy__Enabled: "true",
    StudioAiProxy__DefaultProvider: "opus",
    StudioAiProxy__Providers__opus__Kind: "anthropic",
    StudioAiProxy__Providers__opus__Endpoint: "https://api.anthropic.com",
    StudioAiProxy__Providers__opus__Model: liveModelLimits.model,
    StudioAiProxy__Providers__opus__MaxTokens: String(liveModelLimits.maxTokens),
    StudioAiProxy__Providers__opus__SupportsTools: "true",
    HONUA_SECRET_FILE__HONUA_STUDIOAI_OPUS_API_KEY: `/run/secrets/${studioSecretNames.provider}`,
    StudioAiProxy__Disclosure__WorkloadDataClassification: "unclassified",
    StudioAiProxy__Disclosure__Approvals__0__Provider: "opus",
    StudioAiProxy__Disclosure__Approvals__0__Kind: "anthropic",
    StudioAiProxy__Disclosure__Approvals__0__Destination: "https://api.anthropic.com",
    StudioAiProxy__Disclosure__Approvals__0__Model: liveModelLimits.model,
    StudioAiProxy__Disclosure__Approvals__0__UseCase: "studio-chat",
    StudioAiProxy__Disclosure__Approvals__0__DataClassification: "unclassified",
    AiExecutionAdmission__DeploymentId: "studio-live-compose",
    AiExecutionAdmission__Backend: "postgres",
  };
  if (mode !== "oidc-lifecycle") return environment;
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([name]) => !isModelProviderSetting(name))),
    StudioAiProxy__Enabled: "false",
  };
}

function isModelProviderSetting(name) {
  return name.startsWith("StudioAiProxy__") || name === "HONUA_SECRET_FILE__HONUA_STUDIOAI_OPUS_API_KEY";
}

function keycloakService() {
  return {
    image: "quay.io/keycloak/keycloak:26.0",
    command: ["start", "--import-realm"],
    user: "1000:1001",
    environment: {
      KC_HOSTNAME: identityOrigin,
      KC_HTTP_ENABLED: "false",
      KC_HTTPS_CERTIFICATE_FILE: "/certs/kc.crt",
      KC_HTTPS_CERTIFICATE_KEY_FILE: "/certs/kc.key",
    },
    volumes: ["./identity/certs:/certs:ro", "./identity/realm:/opt/keycloak/data/import:ro"],
    ports: [`127.0.0.1:${new URL(identityOrigin).port}:8443`],
    networks: { default: { aliases: ["host.docker.internal"] } },
  };
}

export function approverRealm({ password, clientSecret }) {
  return {
    realm: realmName,
    enabled: true,
    sslRequired: "all",
    registrationAllowed: false,
    roles: { realm: [{ name: "admin" }, { name: "user" }] },
    users: [
      {
        username: "studio-approver",
        enabled: true,
        email: "studio-approver@example.test",
        emailVerified: true,
        firstName: "Studio",
        lastName: "Approver",
        realmRoles: ["admin", "user"],
        credentials: [{ type: "password", value: password, temporary: false }],
      },
    ],
    clients: [
      {
        clientId: consoleClientId,
        enabled: true,
        protocol: "openid-connect",
        publicClient: false,
        secret: clientSecret,
        standardFlowEnabled: true,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: false,
        redirectUris: [`${consoleOrigin}/admin/auth/callback`],
        webOrigins: [consoleOrigin],
        attributes: { "pkce.code.challenge.method": "S256" },
        protocolMappers: [
          {
            name: "roles",
            protocol: "openid-connect",
            protocolMapper: "oidc-usermodel-realm-role-mapper",
            config: {
              "claim.name": "roles",
              ...tokenClaims,
              multivalued: "true",
            },
          },
          {
            name: "tenant",
            protocol: "openid-connect",
            protocolMapper: "oidc-hardcoded-claim-mapper",
            config: {
              "claim.name": "tenant_id",
              "claim.value": "public",
              ...tokenClaims,
            },
          },
        ],
      },
    ],
  };
}
