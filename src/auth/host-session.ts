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
import { type AuthTransitionEvent, INITIAL_AUTH_STATE, reduceAuthState } from "./state-machine.js";
import type {
  AuthSession,
  AuthSessionListener,
  AuthState,
  BearerSessionAdapter,
  SessionAdapter,
  Unsubscribe,
} from "./types.js";

export class HostAdapterAuthSession implements AuthSession {
  readonly mode = "host-adapter" as const;

  private state: AuthState = INITIAL_AUTH_STATE;
  private readonly listeners = new Set<AuthSessionListener>();
  private readonly unsubscribeExpired: Unsubscribe;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  readonly fetchRequest?: typeof fetch;

  constructor(private readonly adapter: SessionAdapter) {
    this.unsubscribeExpired = this.adapter.onExpired(() => {
      this.dispatch({ type: "refresh-failed", error: "The host session expired." });
    });
    // Resolve the host's token proactively (fire-and-forget) rather than
    // waiting for the first outgoing API request to ask for one — otherwise
    // any UI gated on `status === "fresh"` (see src/pages/home.ts) would
    // never leave "signed-out", since nothing else calls getAccessToken()
    // until a request needs it.
    if ("kind" in adapter && adapter.kind === "cookie") {
      const cookie = Object.freeze({ ...adapter });
      this.adapter = cookie;
      if (
        cookie.baseUrl !== "/api/studio" ||
        !cookie.environmentId ||
        !cookie.csrfToken ||
        !Number.isFinite(Date.parse(cookie.expiresAt))
      ) {
        throw new Error("Invalid cookie host session.");
      }
      this.fetchRequest = async (input, init) => {
        if (this.getState().status !== "fresh") throw new Error("The host session expired.");
        if (input instanceof Request) throw new Error("Cookie transport requires an explicit URL.");
        let path = String(input);
        if (/^https?:\/\//.test(path)) {
          if (typeof location === "undefined")
            throw new Error("Absolute cookie transport URLs require a browser origin.");
          const url = new URL(path);
          if (url.origin !== location.origin) throw new Error("Cookie transport requires the host origin.");
          path = url.pathname + url.search;
        }
        const pathname = path.split("?")[0]!;
        if (/[^\x20-\x7e]|[\\#]/.test(path) || /%(?:2e|2f|5c)/i.test(pathname) || pathname.split("/").includes(".."))
          throw new Error("Cookie host transport rejected an unbounded URL.");
        let target: string;
        if (pathname === "/mcp" || pathname === "/api/mcp") {
          const request = JSON.parse(String(init?.body ?? "{}")) as {
            method?: string;
            params?: { name?: string; arguments?: Record<string, unknown> };
          };
          const args = request.params?.arguments ?? {};
          const tool = request.params?.name;
          const layerList =
            tool === "honua_list_layers" &&
            Object.keys(args).every((key) => key === "offset" || key === "limit") &&
            Number.isSafeInteger(args.offset ?? 0) &&
            Number(args.offset ?? 0) >= 0 &&
            Number.isSafeInteger(args.limit ?? 100) &&
            Number(args.limit ?? 100) > 0 &&
            Number(args.limit ?? 100) <= 100;
          const styleRead =
            tool === "honua_get_style" &&
            Object.keys(args).every((key) => key === "styleId" || key === "includeStylesheet" || key === "encoding") &&
            (args.styleId === undefined || (typeof args.styleId === "string" && args.styleId.length <= 256)) &&
            (args.includeStylesheet === undefined || args.includeStylesheet === true) &&
            (args.encoding === undefined || args.encoding === "mapbox-style");
          const describe =
            tool === "honua_describe_layer" &&
            Object.keys(args).every((key) => key === "serviceId" || key === "layerId") &&
            typeof args.serviceId === "string" &&
            args.serviceId.length > 0 &&
            args.serviceId.length <= 256 &&
            Number.isSafeInteger(args.layerId) &&
            Number(args.layerId) >= 0;
          if (
            request.method !== "initialize" &&
            request.method !== "notifications/initialized" &&
            !(request.method === "tools/call" && (layerList || styleRead || describe))
          )
            throw new Error("The human catalog transport only permits layer discovery and style readback.");
          target = "/api/studio/catalog-mcp";
        } else if (
          (/^\/rest\/services\/(?:[^/]+\/)+FeatureServer\/\d+\/query$/.test(pathname) ||
            /^\/ogc\/features\/collections\/[^/]+\/items$/.test(pathname)) &&
          (init?.method ?? "GET") === "GET"
        ) {
          target = `/api/studio/data${path}`;
        } else {
          if (
            !pathname.startsWith("/api/v1/studio/") &&
            !pathname.startsWith("/api/studio/v1/studio/") &&
            pathname !== "/api/health"
          )
            throw new Error("Cookie host transport only permits bounded Studio requests.");
          target = path.startsWith("/api/studio/") ? path : `/api/studio${path.slice(4)}`;
        }
        const headers = new Headers(init?.headers);
        headers.delete("authorization");
        headers.delete("x-api-key");
        headers.set("X-Honua-Environment", cookie.environmentId);
        if (!["GET", "HEAD", "OPTIONS"].includes((init?.method ?? "GET").toUpperCase()))
          headers.set("X-CSRF-Token", cookie.csrfToken);
        const response = await fetch(target, { ...init, headers, credentials: "same-origin", redirect: "error" });
        if (response.status === 401) this.dispatch({ type: "refresh-failed", error: "The host session expired." });
        return response;
      };
    }
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
    if ("kind" in this.adapter && this.adapter.kind === "cookie") {
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
