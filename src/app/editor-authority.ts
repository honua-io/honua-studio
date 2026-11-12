import { HostAdapterAuthSession, isCookieSession, verifiedSourcePathBase } from "../auth/host-session.js";
import { type AuthSession, type SessionAdapter, createAuthSession } from "../auth/index.js";
import type { CookieSessionAdapter } from "../auth/types.js";
import { StudioClient } from "../client/studio-client.js";
import type { StudioLifecycleClient } from "../lifecycle/lifecycle-client.js";
import { runtimeMcpBaseUrl, runtimeServerBaseUrl } from "../runtime-config.js";
import type { AuthoritativeStyleProvider } from "../styles/authoritative-style-provider.js";
import { runtimeLifecycleClient, sourceStyleProvider } from "./runtime-clients.js";
import { StalenessEpoch } from "./staleness-epoch.js";

export const EDITOR_AUTHORITY_CHANGED = "The editor authority changed.";
export const EDITOR_SESSION_CHANGED = "The editor session changed.";

export interface EditorStyleProviderOptions {
  readonly getAuthority?: () => unknown;
  readonly signal?: AbortSignal;
}

export interface EditorAuthorityHooks {
  readonly isConnected: () => boolean;
  readonly onAuthReplaced: () => void;
  readonly onAuthStateChange: () => void;
}

/** Duck-typed: only sessions that own an external subscription expose `dispose()`. */
function disposeAuthSession(auth: AuthSession | undefined): void {
  (auth as (AuthSession & { dispose?: () => void }) | undefined)?.dispose?.();
}

/**
 * The human authority Studio acts for: the host session adapter, the `AuthSession` resolved from it and the
 * catalog client bound to it. `epoch` advances when the principal changes and `lease` on every session
 * assignment, so async work can tell that the authority or its credentials moved on.
 */
export class EditorAuthority {
  readonly epoch = new StalenessEpoch();
  readonly lease = new StalenessEpoch();
  #session: SessionAdapter | undefined;
  #auth: AuthSession | undefined;
  #authUnsubscribe: (() => void) | undefined;
  #redirectCallbackHandled = false;
  #studioClient: StudioClient | undefined;
  #studioClientOverridden = false;

  constructor(private readonly hooks: EditorAuthorityHooks) {}

  get session(): SessionAdapter | undefined {
    return this.#session;
  }

  get auth(): AuthSession {
    return this.#auth ?? this.resetAuth();
  }

  /** The resolved session without building one. */
  get resolvedAuth(): AuthSession | undefined {
    return this.#auth;
  }

  get holdsSession(): boolean {
    return Boolean(this.#session || this.#auth);
  }

  get hasCookieSession(): boolean {
    return isCookieSession(this.#session);
  }

  /** The verified deployment path of a cookie session; undefined for any other session. */
  get cookieSourcePathBase(): string | undefined {
    return isCookieSession(this.#session) ? verifiedSourcePathBase(this.#session.sourcePathBase) : undefined;
  }

  /** Where this authority reads published sources: the verified cookie path, else the catalog root. */
  get sourceBaseUrl(): string {
    return this.cookieSourcePathBase ?? runtimeMcpBaseUrl();
  }

  lifecycleClient(): StudioLifecycleClient {
    return runtimeLifecycleClient(this.auth);
  }

  createEditorStyleProvider(options: EditorStyleProviderOptions = {}): AuthoritativeStyleProvider {
    const generation = this.epoch.current;
    const authority = options.getAuthority?.();
    return sourceStyleProvider({
      baseUrl: this.sourceBaseUrl,
      signal: options.signal,
      getAuth: () => {
        if (!this.epoch.isCurrent(generation) || options.getAuthority?.() !== authority)
          throw new Error("The selected style editor authority changed.");
        return this.auth;
      },
    });
  }

  adoptSession(session: SessionAdapter | undefined): void {
    this.#session = session;
    this.lease.next();
  }

  /** Renews a same-principal cookie lease in place; false when the resolved session cannot renew. */
  renewCookieLease(session: CookieSessionAdapter): boolean {
    if (!(this.#auth instanceof HostAdapterAuthSession)) return false;
    this.#auth.renewCookie(session);
    return true;
  }

  /** Rebuilds `auth` from the current session, disposing the previous one. */
  resetAuth(): AuthSession {
    this.#releaseAuth();
    this.forgetStudioClient();
    const auth = createAuthSession({ hostAdapter: this.#session });
    this.#auth = auth;
    this.hooks.onAuthReplaced();
    this.#authUnsubscribe = auth.subscribe(() => this.hooks.onAuthStateChange());
    if (this.hooks.isConnected()) void this.#completeStandaloneRedirectCallback(auth);
    return auth;
  }

  disposeAuth(): void {
    this.#releaseAuth();
    this.#auth = undefined;
  }

  get studioClient(): StudioClient {
    if (!this.#studioClient)
      this.#studioClient = new StudioClient(runtimeServerBaseUrl(), this.auth, runtimeMcpBaseUrl());
    return this.#studioClient;
  }

  set studioClient(client: StudioClient) {
    this.#studioClient = client;
    this.#studioClientOverridden = true;
  }

  get studioClientOverridden(): boolean {
    return this.#studioClientOverridden;
  }

  forgetStudioClient(): void {
    if (!this.#studioClientOverridden) this.#studioClient = undefined;
  }

  #releaseAuth(): void {
    this.#authUnsubscribe?.();
    this.#authUnsubscribe = undefined;
    disposeAuthSession(this.#auth);
  }

  /** Completes a standalone OIDC redirect back to this page, at most once; a no-op otherwise. */
  async #completeStandaloneRedirectCallback(auth: AuthSession): Promise<void> {
    if (this.#redirectCallbackHandled) return;
    if (auth.mode !== "standalone" || !auth.isRedirectCallback()) return;
    this.#redirectCallbackHandled = true;
    try {
      await auth.handleRedirectCallback();
    } catch {
      // The auth state already shows the failure; the shell stays usable so the user can retry sign-in.
    }
    window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
  }
}
