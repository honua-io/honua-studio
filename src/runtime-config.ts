/** Runtime-only deployment contract. Values are fetched from `/config.json`; no rebuild is required. */
export interface StudioRuntimeConfig {
  readonly schemaVersion: "honua.studio.runtime-config.v1";
  readonly serverBaseUrl: string;
  readonly oidc: {
    readonly issuer: string;
    readonly clientId: string;
    readonly audience?: string;
    readonly scopes: readonly string[];
  };
  readonly model: {
    readonly mode: "server-proxy" | "client-direct";
    readonly provider?: string;
    readonly baseUrl?: string;
  };
}

declare global {
  interface Window {
    __honuaStudioRuntimeConfig?: StudioRuntimeConfig;
  }
}

const DEFAULT_CONFIG: StudioRuntimeConfig = {
  schemaVersion: "honua.studio.runtime-config.v1",
  serverBaseUrl: "/api",
  oidc: {
    issuer: "/oidc",
    clientId: "honua-studio-dev",
    scopes: ["openid", "profile", "honua.read", "honua.write"],
  },
  model: { mode: "server-proxy" },
};

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseRuntimeConfig(value: unknown): StudioRuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Runtime config must be an object.");
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== "honua.studio.runtime-config.v1") {
    throw new Error('Runtime config schemaVersion must be "honua.studio.runtime-config.v1".');
  }
  if (!nonEmpty(input.serverBaseUrl)) throw new Error("Runtime config serverBaseUrl is required.");
  const oidc = input.oidc as Record<string, unknown> | undefined;
  if (!oidc || !nonEmpty(oidc.issuer) || !nonEmpty(oidc.clientId)) {
    throw new Error("Runtime config oidc.issuer and oidc.clientId are required.");
  }
  if (!Array.isArray(oidc.scopes) || oidc.scopes.length === 0 || !oidc.scopes.every(nonEmpty)) {
    throw new Error("Runtime config oidc.scopes must be a non-empty string array.");
  }
  const model = input.model as Record<string, unknown> | undefined;
  if (!model || (model.mode !== "server-proxy" && model.mode !== "client-direct")) {
    throw new Error('Runtime config model.mode must be "server-proxy" or "client-direct".');
  }
  if (model.mode === "client-direct" && !nonEmpty(model.baseUrl)) {
    throw new Error("Runtime config model.baseUrl is required in client-direct mode.");
  }
  return {
    schemaVersion: input.schemaVersion,
    serverBaseUrl: input.serverBaseUrl.trim().replace(/\/$/, ""),
    oidc: {
      issuer: oidc.issuer.trim(),
      clientId: oidc.clientId.trim(),
      ...(nonEmpty(oidc.audience) ? { audience: oidc.audience.trim() } : {}),
      scopes: oidc.scopes.map((scope) => scope.trim()),
    },
    model: {
      mode: model.mode,
      ...(nonEmpty(model.provider) ? { provider: model.provider.trim() } : {}),
      ...(nonEmpty(model.baseUrl) ? { baseUrl: model.baseUrl.trim().replace(/\/$/, "") } : {}),
    },
  };
}

export async function loadRuntimeConfig(
  fetchImpl: typeof fetch = fetch,
  url = "/config.json",
): Promise<StudioRuntimeConfig> {
  const response = await fetchImpl(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load Studio runtime config (${response.status}).`);
  return parseRuntimeConfig(await response.json());
}

let installedConfig: StudioRuntimeConfig | undefined;

export function installRuntimeConfig(config: StudioRuntimeConfig | undefined): void {
  installedConfig = config;
  if (typeof window !== "undefined") window.__honuaStudioRuntimeConfig = config;
}

export function runtimeConfig(): StudioRuntimeConfig {
  return (
    installedConfig ??
    (typeof window === "undefined" ? DEFAULT_CONFIG : (window.__honuaStudioRuntimeConfig ?? DEFAULT_CONFIG))
  );
}

export function runtimeServerBaseUrl(): string {
  return runtimeConfig().serverBaseUrl;
}
