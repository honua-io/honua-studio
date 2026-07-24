/**
 * Router stub (honua-studio#3).
 *
 * A minimal hash router: enough wiring for the app shell to mount route
 * views and for honua-studio#5's embed contract to build on ("routing
 * integration" in the element contract), without pretending to be the
 * real Studio router. Phase 1 composition views replace these routes.
 */

export interface Route {
  path: string;
  render: (root: HTMLElement) => void;
}

export class Router {
  private readonly routes: Route[];
  private readonly fallback: Route;
  private readonly root: HTMLElement;
  private readonly onHashChange = () => this.render();

  constructor(root: HTMLElement, routes: Route[], fallback: Route) {
    this.root = root;
    this.routes = routes;
    this.fallback = fallback;
  }

  private currentPath(): string {
    const hash = window.location.hash.replace(/^#/, "");
    return hash === "" ? "/" : hash;
  }

  private matchedRoute(): Route {
    const path = this.currentPath();
    return this.routes.find((route) => route.path === path) ?? this.fallback;
  }

  private render(): void {
    this.matchedRoute().render(this.root);
  }

  /** Starts listening for hash changes and renders the current route once. */
  start(): void {
    window.addEventListener("hashchange", this.onHashChange);
    this.render();
  }

  /** Removes the hashchange listener. */
  stop(): void {
    window.removeEventListener("hashchange", this.onHashChange);
  }
}
