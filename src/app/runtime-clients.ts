import type { AuthSession } from "../auth/types.js";
import { StudioLifecycleClient, type TokenSource } from "../lifecycle/lifecycle-client.js";
import { runtimeMcpBaseUrl, runtimeServerBaseUrl } from "../runtime-config.js";
import { AuthoritativeStyleProvider } from "../styles/authoritative-style-provider.js";

export interface SourceStyleProviderOptions {
  readonly baseUrl: string;
  readonly getAuth: () => Pick<AuthSession, "getAccessToken" | "fetchRequest"> | undefined;
  readonly signal?: AbortSignal;
}

/** A lifecycle client on the deployment's runtime server base. */
export function runtimeLifecycleClient(auth: TokenSource | undefined): StudioLifecycleClient {
  return new StudioLifecycleClient({ baseUrl: runtimeServerBaseUrl(), auth });
}

/** Style discovery for sources under `baseUrl`; a base other than the catalog root keeps that root as an alias. */
export function sourceStyleProvider(options: SourceStyleProviderOptions): AuthoritativeStyleProvider {
  return new AuthoritativeStyleProvider({
    baseUrl: options.baseUrl,
    ...(options.baseUrl !== runtimeMcpBaseUrl() ? { catalogAliasBaseUrl: runtimeMcpBaseUrl() } : {}),
    documentUrl: document.baseURI,
    getAuth: options.getAuth,
    signal: options.signal,
  });
}
