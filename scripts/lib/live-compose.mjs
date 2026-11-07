export function validateImageLock(lock) {
  for (const component of ["server", "executor", "console"]) {
    const repository = component === "console" ? "honua-console" : "honua-server";
    if (!new RegExp(`^ghcr.io/honua-io/${repository}@sha256:[a-f0-9]{64}$`).test(lock[component]?.image)) {
      throw new Error(`${component} needs an immutable Honua image digest.`);
    }
    if (!/^[a-f0-9]{40}$/.test(lock[component].revision)) throw new Error(`${component} needs its source revision.`);
  }
  if (lock.server.revision !== lock.executor.revision)
    throw new Error("Server and executor must use the same candidate.");
}

export function studioComposeOverlay(lock) {
  validateImageLock(lock);
  return {
    services: {
      honua: {
        image: lock.server.image,
        environment: studioServerEnvironment(),
        secrets: ["anthropic_api_key", "oidc_client_secret", "operator_signing_key"],
        volumes: ["./identity/certs:/certs:ro"],
        extra_hosts: ["host.docker.internal:host-gateway"],
        depends_on: { keycloak: { condition: "service_started" } },
      },
      console: {
        image: lock.console.image,
        ports: ["127.0.0.1:5174:8080"],
        environment: {
          ASPNETCORE_ENVIRONMENT: "Development",
          ASPNETCORE_URLS: "http://+:8080",
          HONUA_SERVER_BASE_URL: "http://honua:8080",
          Honua__Server__BaseUrl: "http://honua:8080",
          HONUA_ADMIN_API_KEY: "",
          Honua__Server__AdminApiKey: "",
          Studio__EmbedJsStudio: "true",
          SSL_CERT_FILE: "/certs/ca-bundle.crt",
        },
        volumes: ["./identity/certs:/certs:ro"],
        extra_hosts: ["host.docker.internal:host-gateway"],
        depends_on: { honua: { condition: "service_started" } },
      },
      keycloak: keycloakService(),
    },
    secrets: Object.fromEntries(
      ["anthropic_api_key", "oidc_client_secret", "operator_signing_key"].map((name) => [
        name,
        { file: `./secrets/${name}` },
      ]),
    ),
  };
}

function studioServerEnvironment() {
  return {
    PUBLIC_BASE_URL: "http://127.0.0.1:5174",
    Studio__EndUserAuthorization__Enabled: "true",
    Oidc__Enabled: "true",
    Oidc__Generic__Enabled: "true",
    Oidc__Generic__Authority: "https://host.docker.internal:8443/realms/studio-live",
    Oidc__Generic__ClientId: "studio-console",
    HONUA_SECRET_FILE__Oidc__Generic__ClientSecret: "/run/secrets/oidc_client_secret",
    Authentication__OperatorBearer__Enabled: "true",
    HONUA_SECRET_FILE__Authentication__OperatorBearer__SigningKey: "/run/secrets/operator_signing_key",
    SSL_CERT_FILE: "/certs/ca-bundle.crt",
    StudioAiProxy__Enabled: "true",
    StudioAiProxy__DefaultProvider: "opus",
    StudioAiProxy__Providers__opus__Kind: "anthropic",
    StudioAiProxy__Providers__opus__Endpoint: "https://api.anthropic.com",
    StudioAiProxy__Providers__opus__Model: "claude-opus-5-5",
    StudioAiProxy__Providers__opus__SupportsTools: "true",
    HONUA_SECRET_FILE__HONUA_STUDIOAI_OPUS_API_KEY: "/run/secrets/anthropic_api_key",
    StudioAiProxy__Disclosure__WorkloadDataClassification: "unclassified",
    StudioAiProxy__Disclosure__Approvals__0__Provider: "opus",
    StudioAiProxy__Disclosure__Approvals__0__Kind: "anthropic",
    StudioAiProxy__Disclosure__Approvals__0__Destination: "https://api.anthropic.com",
    StudioAiProxy__Disclosure__Approvals__0__Model: "claude-opus-5-5",
    StudioAiProxy__Disclosure__Approvals__0__UseCase: "studio-chat",
    StudioAiProxy__Disclosure__Approvals__0__DataClassification: "unclassified",
    AiExecutionAdmission__DeploymentId: "studio-live-compose",
    AiExecutionAdmission__Backend: "postgres",
  };
}

function keycloakService() {
  return {
    image: "quay.io/keycloak/keycloak:26.0",
    command: ["start", "--import-realm"],
    user: "1000:1001",
    environment: {
      KC_HOSTNAME: "https://host.docker.internal:8443",
      KC_HTTP_ENABLED: "false",
      KC_HTTPS_CERTIFICATE_FILE: "/certs/kc.crt",
      KC_HTTPS_CERTIFICATE_KEY_FILE: "/certs/kc.key",
    },
    volumes: ["./identity/certs:/certs:ro", "./identity/realm:/opt/keycloak/data/import:ro"],
    ports: ["127.0.0.1:8443:8443"],
  };
}

export function approverRealm({ password, clientSecret }) {
  return {
    realm: "studio-live",
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
        clientId: "studio-console",
        enabled: true,
        protocol: "openid-connect",
        publicClient: false,
        secret: clientSecret,
        standardFlowEnabled: true,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: false,
        redirectUris: ["http://127.0.0.1:5174/admin/auth/callback"],
        webOrigins: ["http://127.0.0.1:5174"],
        attributes: { "pkce.code.challenge.method": "S256" },
        protocolMappers: [
          {
            name: "roles",
            protocol: "openid-connect",
            protocolMapper: "oidc-usermodel-realm-role-mapper",
            config: {
              "claim.name": "roles",
              "jsonType.label": "String",
              multivalued: "true",
              "id.token.claim": "true",
              "access.token.claim": "true",
              "userinfo.token.claim": "true",
            },
          },
          {
            name: "tenant",
            protocol: "openid-connect",
            protocolMapper: "oidc-hardcoded-claim-mapper",
            config: {
              "claim.name": "tenant_id",
              "claim.value": "public",
              "jsonType.label": "String",
              "id.token.claim": "true",
              "access.token.claim": "true",
              "userinfo.token.claim": "true",
            },
          },
        ],
      },
    ],
  };
}
