/** Runtime configuration loaded by the static Studio shell before mount. */
export interface HonuaStudioRuntimeConfig {
  /** Base before `/v1` and `/mcp`; `/api` uses the local dev/static proxy. */
  readonly serverBaseUrl: string;
  readonly oidc?: {
    readonly issuer?: string;
    readonly clientId?: string;
    readonly redirectUri?: string;
    readonly scopes?: readonly string[];
  };
  readonly model?: {
    readonly provider?: string;
    readonly model?: string;
  };
}

interface RuntimeConfigWire {
  readonly serverBaseUrl?: unknown;
  readonly oidc?: {
    readonly issuer?: unknown;
    readonly clientId?: unknown;
    readonly redirectUri?: unknown;
    readonly scopes?: unknown;
  };
  readonly model?: {
    readonly provider?: unknown;
    readonly model?: unknown;
  };
}

declare global {
  interface Window {
    __HONUA_STUDIO_CONFIG__?: HonuaStudioRuntimeConfig;
  }
}

const DEFAULT_CONFIG: HonuaStudioRuntimeConfig = { serverBaseUrl: "/api" };

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function scopes(value: unknown): readonly string[] | undefined {
  const values = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? value.split(/\s+/)
      : [];
  const normalized = values.map((entry) => entry.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeRuntimeConfig(value: unknown): HonuaStudioRuntimeConfig {
  const wire = value && typeof value === "object" ? (value as RuntimeConfigWire) : {};
  const oidc = {
    issuer: text(wire.oidc?.issuer),
    clientId: text(wire.oidc?.clientId),
    redirectUri: text(wire.oidc?.redirectUri),
    scopes: scopes(wire.oidc?.scopes),
  };
  const model = {
    provider: text(wire.model?.provider),
    model: text(wire.model?.model),
  };
  const hasOidc = Object.values(oidc).some((entry) => entry !== undefined);
  const hasModel = Object.values(model).some((entry) => entry !== undefined);
  return {
    serverBaseUrl: text(wire.serverBaseUrl) ?? DEFAULT_CONFIG.serverBaseUrl,
    ...(hasOidc ? { oidc } : {}),
    ...(hasModel ? { model } : {}),
  };
}

export function getRuntimeConfig(
  target: Window | undefined = typeof window === "undefined" ? undefined : window,
): HonuaStudioRuntimeConfig {
  return target?.__HONUA_STUDIO_CONFIG__ ?? DEFAULT_CONFIG;
}

/**
 * Loads `/config.json` for a build-once, configure-at-runtime deployment.
 * A missing file deliberately falls back to same-origin fixture defaults;
 * malformed or inaccessible declared config fails closed before app mount.
 */
export async function loadRuntimeConfig(
  options: { readonly url?: string; readonly fetchImpl?: typeof fetch; readonly target?: Window } = {},
): Promise<HonuaStudioRuntimeConfig> {
  const target = options.target ?? (typeof window === "undefined" ? undefined : window);
  if (target?.__HONUA_STUDIO_CONFIG__) return target.__HONUA_STUDIO_CONFIG__;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(options.url ?? "/config.json", { headers: { accept: "application/json" } });
  if (response.status === 404) return DEFAULT_CONFIG;
  if (!response.ok) throw new Error(`Honua Studio runtime config responded ${response.status}.`);
  const config = normalizeRuntimeConfig(await response.json());
  if (target) target.__HONUA_STUDIO_CONFIG__ = config;
  return config;
}
