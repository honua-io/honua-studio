/**
 * Embed-mode auth session (honua-studio#4 REQ-003).
 *
 * Consumes a host-provided {@link SessionAdapter} instead of running any
 * OIDC flow of its own. This is the load-bearing rule REQ-003 exists to
 * enforce: `signIn()` / `handleRedirectCallback()` are unreachable no-ops or
 * throw, and there is no code path here that ever navigates the browser or
 * calls a token endpoint. See docs/embed-session.md for the full contract
 * and rationale (including the REQ-011 admin-only note for Phase 0/1).
 */
import { cookieRequestTarget, sendCookieRequest, validCookieTransport } from "./cookie-host-transport.js";
import { type AuthTransitionEvent, INITIAL_AUTH_STATE, reduceAuthState } from "./state-machine.js";
import type {
  AuthSession,
  AuthSessionListener,
  AuthState,
  BearerSessionAdapter,
  CookieSessionAdapter,
  SessionAdapter,
  Unsubscribe,
} from "./types.js";

export function isCookieSession(session: SessionAdapter | undefined): session is CookieSessionAdapter {
  return session !== undefined && "kind" in session && session.kind === "cookie";
}

/** Two cookie sessions of one principal, environment and verified deployment path: a lease renewal. */
export function isSameCookiePrincipal(previous: SessionAdapter | undefined, next: SessionAdapter | undefined): boolean {
  return (
    isCookieSession(previous) &&
    isCookieSession(next) &&
    Boolean(previous.principalId) &&
    previous.baseUrl === next.baseUrl &&
    previous.principalId === next.principalId &&
    previous.environmentId === next.environmentId &&
    verifiedSourcePathBase(previous.sourcePathBase) === verifiedSourcePathBase(next.sourcePathBase)
  );
}

export function verifiedSourcePathBase(value: string | undefined): string {
  const path = value ?? "";
  if (path !== "" && (!/^\/(?:[A-Za-z0-9_-]+)(?:\/[A-Za-z0-9_-]+)*$/.test(path) || path.length > 512))
    throw new Error("Invalid verified deployment source path.");
  return path;
}

export class HostAdapterAuthSession implements AuthSession {
  readonly mode = "host-adapter" as const;

  private state: AuthState = INITIAL_AUTH_STATE;
  private readonly listeners = new Set<AuthSessionListener>();
  private unsubscribeExpired: Unsubscribe;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private expiryGeneration = 0;
  private disposed = false;
  readonly fetchRequest?: typeof fetch;

  constructor(private adapter: SessionAdapter) {
    if (isCookieSession(adapter)) {
      verifiedSourcePathBase(adapter.sourcePathBase);
      if (!validCookieTransport(adapter)) throw new Error("Invalid cookie host session.");
    }
    const generation = this.expiryGeneration;
    this.unsubscribeExpired = this.adapter.onExpired(() => {
      if (generation === this.expiryGeneration)
        this.dispatch({ type: "refresh-failed", error: "The host session expired." });
    });
    // Resolve the host's token proactively (fire-and-forget) rather than
    // waiting for the first outgoing API request to ask for one — otherwise
    // any UI gated on `status === "fresh"` (see src/pages/home.ts) would
    // never leave "signed-out", since nothing else calls getAccessToken()
    // until a request needs it.
    if (isCookieSession(adapter)) {
      const cookie = Object.freeze({ ...adapter });
      this.adapter = cookie;
      const sourcePathBase = verifiedSourcePathBase(cookie.sourcePathBase);
      this.fetchRequest = async (input, init) => {
        const cookie = this.adapter;
        if (!isCookieSession(cookie)) throw new Error("The host session changed.");
        if (this.disposed || this.getState().status !== "fresh") throw new Error("The host session expired.");
        if (input instanceof Request) throw new Error("Cookie transport requires an explicit URL.");
        let path = String(input);
        if (/^https?:\/\//.test(path)) {
          if (typeof location === "undefined")
            throw new Error("Absolute cookie transport URLs require a browser origin.");
          const url = new URL(path);
          if (url.origin !== location.origin) throw new Error("Cookie transport requires the host origin.");
          path = url.pathname + url.search;
        }
        let target: string | undefined;
        if (
          sourcePathBase &&
          path.startsWith(`${sourcePathBase}/`) &&
          (cookie.baseUrl === "/api/v1/studio" ||
            path.startsWith(`${sourcePathBase}/rest/`) ||
            path === `${sourcePathBase}/mcp`)
        ) {
          try {
            target = cookieRequestTarget(path.slice(sourcePathBase.length), init);
          } catch {
            // Canonical routes can share a deployment prefix without containing it.
          }
        }
        target ??= cookieRequestTarget(path, init);
        const method = (init?.method ?? "GET").toUpperCase();
        const safeRead = ["GET", "HEAD", "OPTIONS"].includes(method) || target === "/api/studio/catalog-mcp";
        let response: Response | undefined;
        let responseLease = cookie;
        try {
          response = await sendCookieRequest(cookie, target, init);
        } catch (error) {
          if (
            !safeRead ||
            init?.signal?.aborted ||
            this.adapter === cookie ||
            this.disposed ||
            this.getState().status !== "fresh"
          )
            throw error;
          // A captured Console transport rejects stale responses after a lease replacement.
          // Only a safe read may recover through the replacement capture below.
        }
        // A write is never replayed. renewCookie admits only a lease of the same principal, environment and
        // source path, so a write that crossed a renewal keeps its outcome; any other authority change
        // disposes this session.
        if (!safeRead && this.disposed)
          throw new Error("The host session changed during this request. Check the original outcome before retrying.");
        if (safeRead && this.adapter !== cookie) {
          const renewed = this.adapter;
          if (!isCookieSession(renewed) || this.getState().status !== "fresh")
            throw new Error("The host session changed.");
          init?.signal?.throwIfAborted();
          response = await sendCookieRequest(renewed, target, init);
          if (this.adapter !== renewed) throw new Error("The session renewed again during this read. Retry it.");
          responseLease = renewed;
        }
        if (!response) throw new Error("The host session changed.");
        if (response.status === 401 && this.adapter === responseLease)
          this.dispatch({ type: "refresh-failed", error: "The host session expired." });
        if (!response.body) return response;
        const originalBody = response.body;
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        // A same-principal lease replacement keeps this body. Disposal is the principal boundary and rejects it.
        const requireCurrent = () => {
          if (this.disposed || this.getState().status !== "fresh") throw new Error("The host session expired.");
        };
        const body = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                requireCurrent();
                reader ??= originalBody.getReader();
                const part = await reader.read();
                requireCurrent();
                if (part.done) controller.close();
                else controller.enqueue(part.value);
              } catch (error) {
                if (reader) void reader.cancel().catch(() => {});
                controller.error(error);
              }
            },
            cancel(reason) {
              return reader ? reader.cancel(reason) : originalBody.cancel(reason);
            },
          },
          { highWaterMark: 0 },
        );
        const guarded = new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        Object.defineProperties(guarded, {
          url: { value: response.url },
          redirected: { value: response.redirected },
          type: { value: response.type },
        });
        return guarded;
      };
    }
    void this.getAccessToken();
  }

  /** Renew a cookie lease without changing the authority observed by in-flight reads. */
  renewCookie(adapter: CookieSessionAdapter): void {
    if (this.disposed) throw new Error("The host session is disposed.");
    const previous = this.adapter;
    if (
      !isCookieSession(previous) ||
      previous.principalId !== adapter.principalId ||
      previous.environmentId !== adapter.environmentId ||
      verifiedSourcePathBase(previous.sourcePathBase) !== verifiedSourcePathBase(adapter.sourcePathBase) ||
      previous.baseUrl !== adapter.baseUrl ||
      !validCookieTransport(adapter)
    )
      throw new Error("Cookie lease renewal changed the session authority.");
    const cookie = Object.freeze({ ...adapter });
    const unsubscribe = adapter.onExpired(() => {
      if (this.adapter === cookie) this.dispatch({ type: "refresh-failed", error: "The host session expired." });
    });
    this.expiryGeneration++;
    this.unsubscribeExpired();
    this.unsubscribeExpired = unsubscribe;
    this.adapter = cookie;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.dispatch({ type: "host-authenticated", expiresAt: Date.parse(cookie.expiresAt) });
    void this.getAccessToken();
  }

  getState(): AuthState {
    if (this.state.status === "fresh" && this.state.expiresAt !== undefined && this.state.expiresAt <= Date.now())
      this.dispatch({ type: "refresh-failed", error: "The host session expired." });
    return this.state;
  }

  subscribe(listener: AuthSessionListener): Unsubscribe {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getAccessToken(): Promise<string | undefined> {
    if (isCookieSession(this.adapter)) {
      const expiresAt = Date.parse(this.adapter.expiresAt);
      if (this.state.status === "expired" || expiresAt <= Date.now()) {
        this.dispatch({ type: "refresh-failed", error: "The host session expired." });
        return undefined;
      }
      this.dispatch({ type: "host-authenticated", expiresAt });
      if (!this.expiryTimer)
        this.expiryTimer = setTimeout(
          () => {
            this.dispatch({ type: "refresh-failed", error: "The host session expired." });
          },
          Math.min(expiresAt - Date.now(), 2147483647),
        );
      return undefined;
    }
    let token: string | undefined;
    try {
      token = await (this.adapter as BearerSessionAdapter).getToken();
    } catch (error) {
      this.dispatch({ type: "refresh-failed", error: describeError(error) });
      return undefined;
    }
    if (!token) {
      this.dispatch({ type: "refresh-failed", error: "The host session returned no token." });
      return undefined;
    }
    this.dispatch({ type: "credential-issued", accessToken: token });
    return token;
  }

  isRedirectCallback(_url?: string): boolean {
    return false;
  }

  async handleRedirectCallback(_url?: string): Promise<void> {
    // Never applicable: the host owns the whole session lifecycle, so no
    // redirect back to this app is ever part of the auth flow.
  }

  async signIn(): Promise<void> {
    throw new Error(
      "Host-adapter auth mode never initiates its own sign-in flow (honua-studio#4 REQ-003) — " +
        "the host page owns the session lifecycle. See docs/embed-session.md.",
    );
  }

  async signOut(): Promise<void> {
    throw new Error(
      "Host-adapter auth mode never initiates its own sign-out (honua-studio#4 REQ-003) — " +
        "the host page owns the session lifecycle. See docs/embed-session.md.",
    );
  }

  /** Detaches from the host's onExpired subscription. Call when the app unmounts. */
  dispose(): void {
    this.disposed = true;
    this.unsubscribeExpired();
    clearTimeout(this.expiryTimer);
  }

  private dispatch(event: AuthTransitionEvent): void {
    this.state = reduceAuthState(this.state, event);
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
