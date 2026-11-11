import type { AuthSession } from "../auth/index.js";
import type { CatalogDataset, StudioClient } from "../client/studio-client.js";
import type { HonuaStudioNavigateDetail, HonuaStudioRoutingMode } from "../elements/types.js";
import { renderAbout } from "../pages/about.js";
import { renderContent } from "../pages/content.js";
import { type HomeViewContext, renderHome } from "../pages/home.js";
import { Router } from "../router/router.js";

export type RouteContext = Required<HomeViewContext>;

export interface StudioRouteContext extends RouteContext {
  /** False when the open view still holds edits navigation must not discard. */
  readonly releaseView: () => boolean;
}

export interface StudioRoute {
  readonly path: string;
  readonly navTestId: string;
  readonly label: string;
  readonly render: (root: HTMLElement, context: StudioRouteContext) => void;
}

export const STUDIO_ROUTES: readonly StudioRoute[] = [
  {
    path: "/",
    navTestId: "nav-home",
    label: "Home",
    render: (root, context) => renderHome(root, context),
  },
  {
    path: "/content",
    navTestId: "nav-content",
    label: "Content",
    render: (root, { auth, releaseView }) => renderContent(root, auth, releaseView),
  },
  { path: "/about", navTestId: "nav-about", label: "About", render: (root) => renderAbout(root) },
];

const HOME_ROUTE = STUDIO_ROUTES[0]!;

function normalizePath(path: string): string {
  if (!path || path === "") return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function stripBasePath(path: string, basePath: string | null): string {
  if (!basePath) return path;
  const trimmedBase = basePath.replace(/\/$/, "");
  if (trimmedBase && path.startsWith(trimmedBase)) {
    const rest = path.slice(trimmedBase.length);
    return normalizePath(rest === "" ? "/" : rest);
  }
  return path;
}

function withBasePath(path: string, basePath: string | null): string {
  if (!basePath) return path;
  const trimmedBase = basePath.replace(/\/$/, "");
  return path === "/" ? trimmedBase || "/" : `${trimmedBase}${path}`;
}

/** The parts of `<honua-studio-app>` routing reads; all public element API. */
export interface ShellRouterHost extends EventTarget {
  readonly routingMode: HonuaStudioRoutingMode;
  readonly studioClient: StudioClient;
  readonly auth: AuthSession;
  getAttribute(name: string): string | null;
}

export interface ShellRouterOptions {
  readonly host: ShellRouterHost;
  readonly hasView: () => boolean;
  readonly viewRoot: () => HTMLElement;
  readonly onRouteRendered: () => void;
  readonly isWorkspaceHost: () => boolean;
  readonly addCatalogSource: (dataset: CatalogDataset) => Promise<void>;
  /** Returns false when the current view holds work that navigation must not discard. */
  readonly releaseView?: () => boolean;
}

/** Renders the routed `#view` outlet: self-owned hash routing, or a host-owned path in `host` mode. */
export class ShellRouter {
  #hashRouter: Router | undefined;
  #currentPath = "/";
  #ignoreNextHash = false;

  constructor(private readonly options: ShellRouterOptions) {}

  get currentPath(): string {
    return this.#currentPath;
  }

  /** Binds a fresh hash router to the current `#view`; a chrome rebuild replaces that node. */
  startHashRouting(): void {
    if (this.options.host.routingMode !== "hash" || this.options.isWorkspaceHost()) return;
    this.#hashRouter?.stop();
    this.#hashRouter = new Router(
      this.options.viewRoot(),
      STUDIO_ROUTES.map((route) => ({ path: route.path, render: (root) => this.#showRoute(route, root) })),
      { path: "*", render: (root) => this.#showRoute(HOME_ROUTE, root) },
    );
    this.#hashRouter.start();
  }

  stop(): void {
    this.#hashRouter?.stop();
    this.#hashRouter = undefined;
  }

  /** Adopts a host-owned path, removing the `base-path` prefix. False leaves the accepted path in place. */
  followHostPath(path: string | null): boolean {
    const next = stripBasePath(normalizePath(path ?? "/"), this.options.host.getAttribute("base-path"));
    if (next !== this.#currentPath && !this.#releaseView()) return false;
    this.#currentPath = next;
    return true;
  }

  render(): void {
    if (!this.options.hasView()) return;
    if (!this.#releaseView()) return;
    if (this.options.isWorkspaceHost()) {
      this.options.viewRoot().replaceChildren();
      return;
    }
    const route = STUDIO_ROUTES.find((candidate) => candidate.path === this.#currentPath) ?? HOME_ROUTE;
    this.#renderRoute(route, this.options.viewRoot());
  }

  /** In `host` mode the host owns the URL: never touch window.location, only request navigation. */
  requestNavigation(path: string, event: Event): void {
    const { host } = this.options;
    if (host.routingMode !== "host") return;
    event.preventDefault();
    host.dispatchEvent(
      new CustomEvent<HonuaStudioNavigateDetail>("honua-studio-navigate", {
        bubbles: true,
        composed: true,
        detail: { path: withBasePath(path, host.getAttribute("base-path")) },
      }),
    );
  }

  #showRoute(route: StudioRoute, root: HTMLElement): void {
    if (this.#ignoreNextHash) {
      this.#ignoreNextHash = false;
      return;
    }
    if (route.path !== this.#currentPath) {
      if (!this.#releaseView()) {
        this.#restoreHash();
        return;
      }
      this.#currentPath = route.path;
    } else if (!this.#releaseView()) return;
    this.#renderRoute(route, root);
  }

  #releaseView(): boolean {
    return this.options.releaseView?.() ?? true;
  }

  #restoreHash(): void {
    const desired = this.#currentPath;
    const shown = window.location.hash.replace(/^#/, "") || "/";
    if (shown === desired) return;
    this.#ignoreNextHash = true;
    window.location.hash = desired;
  }

  #renderRoute(route: StudioRoute, root: HTMLElement): void {
    const { host } = this.options;
    route.render(root, {
      client: host.studioClient,
      auth: host.auth,
      onAddSource: this.options.addCatalogSource,
      releaseView: () => this.#releaseView(),
    });
    this.options.onRouteRendered();
  }
}
