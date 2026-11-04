/**
 * Blazor Web App test host glue (see
 * harness/blazor-host/README.md § Findings for the full story). Built by
 * ../../vite.blazor-assets.config.ts into
 * harness/blazor-host/StudioHost/wwwroot/studio/{mount.js,style.css},
 * loaded once from Components/App.razor's `<head>` — a `type="module"`
 * script is implicitly deferred, so it only runs after the initial HTML
 * parses; it is NOT what re-mounts the element on navigation (see
 * `resync()` below for that — Blazor Web App's client-side navigation
 * rewrites the live document wholesale, so staying mounted takes active
 * defensive re-assertion, not just "don't re-run the script").
 *
 * Deliberately plain JS glue, no C# interop package: `window.Blazor` already
 * exposes `navigateTo()` publicly once `blazor.web.js` loads (the same
 * function anchor-interception uses internally), and `document` dispatches a
 * plain `"enhancedload"` event after (some, not all — see `resync()`)
 * navigations complete — both are documented Blazor JS APIs, not private
 * internals. Session injection uses the same fixture adapter as
 * harness/bare, proving the contract, not the transport, is what's shared
 * across hosts.
 */
import "../../src/theme/tokens.css";
import "../../src/theme/theme-standalone.css";
import "../../src/theme/theme-console.css";

import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioAppElement } from "../../src/elements/studio-app-element.js";
import { HonuaStudioCanvasElement } from "../../src/elements/studio-canvas-element.js";
import { createFixtureSession } from "../bare/fixture-session.js";

declare global {
  interface Window {
    Blazor?: {
      navigateTo(uri: string, options?: { replace?: boolean; forceLoad?: boolean }): void;
    };
    __honuaStudioMountCount?: number;
    // Exposed for test/playwright/blazor-host.spec.mjs's render-mode-switch
    // leak assertion only — reads the class's own static instance counter,
    // never mutates it. Not part of the element contract.
    HonuaStudioCanvasElement?: typeof HonuaStudioCanvasElement;
    /** A real, signed mock-issuer access token (`mintFixtureAccessToken()`) set by test/playwright/blazor-host.spec.mjs via `page.addInitScript` — the mock honua-server's catalog/packages endpoints validate it. */
    __honuaStudioFixtureToken?: string;
  }
}

registerAllStudioElements();
window.HonuaStudioCanvasElement = HonuaStudioCanvasElement;

const BASE_PATH = "/studio";
const CONTAINER_ID = "studio-host";

function ensureContainer(): HTMLElement {
  // Created in JS and never declared in a .razor file. Blazor reconciles a
  // server-rendered element's children against its own output and clears
  // foreign children. A node with no server-rendered counterpart is left
  // alone. See harness/blazor-host/README.md.
  let container = document.getElementById(CONTAINER_ID);
  if (!container) {
    container = document.createElement("div");
    container.id = CONTAINER_ID;
    container.dataset.testid = CONTAINER_ID;
    document.body.prepend(container);
  }
  return container;
}

function mount(): void {
  const container = ensureContainer();
  if (container.querySelector("honua-studio-app")) return; // idempotent: no navigation pathway may ever remount this.

  window.__honuaStudioMountCount = (window.__honuaStudioMountCount ?? 0) + 1;

  const app = document.createElement("honua-studio-app") as HonuaStudioAppElement;
  app.routingMode = "host";
  app.setAttribute("base-path", BASE_PATH);
  app.setAttribute("current-path", window.location.pathname);
  app.session = createFixtureSession(window.__honuaStudioFixtureToken);
  // A debug marker only this test host reads (test/playwright/blazor-host.spec.mjs)
  // to prove DOM node identity survives enhanced nav — not part of the element contract.
  (app as unknown as { dataset: DOMStringMap }).dataset.mountToken = String(window.__honuaStudioMountCount);

  app.addEventListener("honua-studio-navigate", (event) => {
    const detail = (event as CustomEvent<{ path: string }>).detail;
    window.Blazor?.navigateTo(detail.path);
  });

  container.appendChild(app);
}

function syncCurrentPath(): void {
  const app = document.getElementById(CONTAINER_ID)?.querySelector<HonuaStudioAppElement>("honua-studio-app");
  if (app) app.currentPath = window.location.pathname;
}

/**
 * Navigation can replace foreign DOM nodes, so `mount()` alone does not
 * survive it. `resync()` re-asserts the element after every navigation
 * signal. `mount()` is idempotent: it recreates the container only when the
 * element is missing. See harness/blazor-host/README.md.
 */
function resync(): void {
  mount();
  syncCurrentPath();
}

resync();

// `enhancedload` covers a plain enhanced navigation.
// `honua-studio-host-navigation` covers an interactive circuit. Blazor
// captures `pushState` before this deferred module runs, so the wrap has to
// be installed by the inline script in Components/App.razor, ahead of
// blazor.web.js.
document.addEventListener("enhancedload", resync);
document.addEventListener("honua-studio-host-navigation", resync);

// Both events fire when navigation starts. The interactive-circuit DOM
// rewrite lands later, so an immediate resync is wiped again. The observer
// reacts when the element disappears instead of guessing a delay.
const watchdog = new MutationObserver(() => {
  if (!document.getElementById(CONTAINER_ID)?.querySelector("honua-studio-app")) resync();
});
watchdog.observe(document.body, { childList: true, subtree: true });
