/**
 * Standalone OIDC Authorization Code + PKCE session (honua-studio#4 REQ-001/002).
 *
 * Thin driver over `@honua/sdk-js/auth`'s `oauth2()` provider — the
 * established seam (examples/oauth-signin in honua-sdk-js): PKCE
 * verifier/challenge generation, the redirect round-trip, and
 * refresh-token-rotation-based silent refresh all live there. This module
 * adds exactly two things honua-studio needs on top:
 *
 * 1. OIDC discovery, so only an issuer URL (not four separate endpoint URLs)
 *    needs configuring (see discovery.ts).
 * 2. The {@link AuthState} state machine (state-machine.ts) the app shell and
 *    studio-client read, projected from the SDK provider's lifecycle events.
 *
 * Per the P2-8 review finding, there is deliberately no hidden iframe here —
 * `@honua/sdk-js/auth`'s provider refreshes via `refresh_token` grants only,
 * and the mock issuer (mock-server.mjs) rotates the refresh token on every
 * use, which is what actually survives 2026-era storage partitioning.
 * REQ-002 is satisfied by simply never configuring a persistent
 * `CredentialStore` — the provider's default is in-memory only, scoped to
 * this page load; nothing is written to localStorage/sessionStorage (the SDK
 * does use sessionStorage for the *in-flight PKCE transaction* — verifier +
 * state — which is not a credential and is cleared the moment the redirect
 * completes).
 *
 * Deliberately imports only from the `@honua/sdk-js/auth` subpath, never the
 * package root or `/honua` — those pull in the full gRPC-Web/protobuf
 * generated client (`@bufbuild/protobuf` et al.), an optional peer
 * dependency Studio has no other reason to require just to sign in.
 */
import { type HonuaAuthEvent, type OAuth2Provider, oauth2 } from "@honua/sdk-js/auth";

import type { OidcEnvConfig } from "./config.js";
import { discoverOidc } from "./discovery.js";
import { type AuthTransitionEvent, INITIAL_AUTH_STATE, reduceAuthState } from "./state-machine.js";
import type { AuthSession, AuthSessionListener, AuthState, GetAccessTokenOptions, Unsubscribe } from "./types.js";

export interface OidcAuthSessionOptions {
  /** Override `fetch` (tests / non-default runtimes). Defaults to `globalThis.fetch`. */
  fetchFn?: typeof fetch;
  /** Override the window used for the redirect + PKCE-transaction storage (tests). Defaults to `globalThis.window`. */
  windowRef?: Window;
}

export class OidcAuthSession implements AuthSession {
  readonly mode = "standalone" as const;

  private state: AuthState = INITIAL_AUTH_STATE;
  private readonly listeners = new Set<AuthSessionListener>();
  private readonly providerReady: Promise<OAuth2Provider>;
  private readonly fetchFn: typeof fetch;
  private readonly windowRef: Window | undefined;

  constructor(
    private readonly config: OidcEnvConfig,
    options: OidcAuthSessionOptions = {},
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.windowRef = options.windowRef;
    this.providerReady = this.initProvider();
  }

  private async initProvider(): Promise<OAuth2Provider> {
    const discovery = await discoverOidc(this.config.issuer, this.fetchFn);
    return oauth2({
      authorizationEndpoint: discovery.authorization_endpoint,
      tokenEndpoint: discovery.token_endpoint,
      revocationEndpoint: discovery.revocation_endpoint,
      clientId: this.config.clientId,
      redirectUri: this.config.redirectUri,
      scopes: this.config.scopes,
      ...(this.config.audience ? { extraAuthorizationParams: { audience: this.config.audience } } : {}),
      fetchFn: this.fetchFn,
      windowRef: this.windowRef,
      // No `store` option: defaults to InMemoryCredentialStore (REQ-002).
      onEvent: (event) => this.onProviderEvent(event),
    });
  }

  private onProviderEvent(event: HonuaAuthEvent): void {
    switch (event.type) {
      case "signed-in":
        this.dispatch({
          type: "credential-issued",
          accessToken: event.credential.accessToken,
          expiresAt: event.credential.expiresAt,
        });
        return;
      case "token-refreshed":
        this.dispatch({
          type: "token-rotated",
          accessToken: event.credential.accessToken,
          expiresAt: event.credential.expiresAt,
        });
        return;
      case "refresh-failed":
        this.dispatch({ type: "refresh-failed", error: event.error.message });
        return;
      case "signed-out":
        this.dispatch({ type: "signed-out" });
        return;
      default:
        return;
    }
  }

  getState(): AuthState {
    return this.state;
  }

  subscribe(listener: AuthSessionListener): Unsubscribe {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getAccessToken(options?: GetAccessTokenOptions): Promise<string | undefined> {
    const provider = await this.providerReady;
    const forceRefresh = options?.forceRefresh ?? false;
    if (forceRefresh) {
      this.dispatch({ type: "refresh-started" });
    }
    try {
      const credentials = await provider.getCredentials({
        reason: forceRefresh ? "unauthorized" : "manual",
        forceRefresh,
      });
      return credentials?.bearerToken;
    } catch (error) {
      // provider.getCredentials() only ever rejects with a HonuaAuthError
      // (interaction_required / refresh_failed / invalid_grant — see
      // @honua/sdk-js/auth). Only surface "expired" when a session actually
      // existed and lapsed — calling getAccessToken() before any sign-in is
      // a routine "not signed in yet" check, not a session expiry, so it
      // leaves "signed-out" alone.
      if (this.state.status !== "signed-out") {
        this.dispatch({ type: "refresh-failed", error: describeError(error) });
      }
      return undefined;
    }
  }

  isRedirectCallback(url?: string): boolean {
    // Synchronous by contract (AuthSession.isRedirectCallback) — safe before
    // the provider resolves because it only inspects the URL, never network
    // state. main.ts always awaits providerReady (via getAccessToken /
    // handleRedirectCallback) before this matters.
    const href = url ?? this.windowRef?.location?.href ?? window.location.href;
    return parseRedirectCallbackHint(href);
  }

  async handleRedirectCallback(url?: string): Promise<void> {
    this.dispatch({ type: "callback-started" });
    try {
      const provider = await this.providerReady;
      const credential = await provider.handleRedirectCallback(url);
      this.dispatch({
        type: "credential-issued",
        accessToken: credential.accessToken,
        expiresAt: credential.expiresAt,
      });
    } catch (error) {
      this.dispatch({ type: "refresh-failed", error: describeError(error) });
      throw error;
    }
  }

  async signIn(): Promise<void> {
    this.dispatch({ type: "sign-in-started" });
    try {
      const provider = await this.providerReady;
      // Redirect mode never resolves (the page navigates away).
      await provider.signIn();
    } catch (error) {
      this.dispatch({ type: "refresh-failed", error: describeError(error) });
      throw error;
    }
  }

  async signOut(): Promise<void> {
    const provider = await this.providerReady;
    await provider.signOut();
  }

  private dispatch(event: AuthTransitionEvent): void {
    this.state = reduceAuthState(this.state, event);
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

function parseRedirectCallbackHint(href: string): boolean {
  let target: URL;
  try {
    target = new URL(href);
  } catch {
    return false;
  }
  return target.searchParams.has("error") || (target.searchParams.has("code") && target.searchParams.has("state"));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
