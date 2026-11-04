import { HostAdapterAuthSession } from "../auth/host-session.js";
import { type AuthSession, type SessionAdapter, createAuthSession } from "../auth/index.js";
import type { CookieSessionAdapter } from "../auth/types.js";
import { StudioClient } from "../client/studio-client.js";
import { runtimeMcpBaseUrl, runtimeServerBaseUrl } from "../runtime-config.js";
import { StalenessEpoch } from "./staleness-epoch.js";

export const WORKSPACE_AUTHORITY_CHANGED = "The workspace authority changed.";

export interface WorkspaceAuthorityHooks {
  readonly isConnected: () => boolean;
  readonly onAuthReplaced: (auth: AuthSession) => void;
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
export class WorkspaceAuthority {
  readonly epoch = new StalenessEpoch();
  readonly lease = new StalenessEpoch();
  #session: SessionAdapter | undefined;
  #auth: AuthSession | undefined;
  #authUnsubscribe: (() => void) | undefined;
  #redirectCallbackHandled = false;
  #studioClient: StudioClient | undefined;
  #studioClientOverridden = false;

  constructor(private readonly hooks: WorkspaceAuthorityHooks) {}

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
    this.hooks.onAuthReplaced(auth);
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
