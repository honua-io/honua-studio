/**
 * Blazor Web App test host glue (honua-studio#5; see
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
  // honua-studio#5 finding (harness/blazor-host/README.md § Findings,
  // hazard 1): this container is created here, in JS, and NEVER declared in
  // any .razor file. A version of this that instead targeted a
  // server-rendered `<div id="studio-host">` — whether inside <Routes/>,
  // inside MainLayout outside @Body, or a sibling of <Routes/> in
  // App.razor's own body — got its children silently cleared on every
  // client-side navigation (both enhanced navigation AND, unexpectedly,
  // navigation inside an interactive-server circuit, which isn't gated
  // behind the "enhancedload" event at all). Blazor's client-side patcher
  // reconciles an element's children against what ITS OWN rendered output
  // says that element should contain — an element with no corresponding
  // server-rendered counterpart anywhere has nothing to reconcile against,
  // so a genuinely foreign node (and everything under it) is left alone.
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
 * honua-studio#5 finding (harness/blazor-host/README.md § Findings, hazard
 * 1): `mount()` alone is not enough. Empirically (three placements tried:
 * inside `<Routes/>`, in the shared layout outside `@Body`, and a plain JS
 * container prepended straight to `<body>`, even to `<html>` itself), a
 * Blazor Web App page navigated to from inside an interactive-server
 * circuit replaces essentially the ENTIRE live document — not a scoped
 * region — with freshly rendered content, wiping any node with no
 * corresponding server-rendered counterpart REGARDLESS of where it lives in
 * the tree. `document`/`window` and this module's own JS state survive
 * (it's a client-side navigation, not a real page load — confirmed via
 * Playwright: no `load`/`domcontentloaded` fires, only `framenavigated`),
 * but the DOM itself is not a safe place to persist anything across this
 * kind of navigation without actively re-asserting your content afterward.
 *
 * `resync()` is that active re-assertion: `mount()` is fully idempotent
 * (recreates the container + element only if genuinely missing, no-ops
 * otherwise), so calling it defensively after every observed navigation
 * signal is cheap and correct for both outcomes — the common case where a
 * navigation DIDN'T wipe anything (nothing to do) and this host's actual
 * case where it did (rebuilds within the same tick, before the next paint).
 */
function resync(): void {
  mount();
  syncCurrentPath();
}

resync();

// document's "enhancedload" fires after a plain (non-interactive-circuit)
// enhanced navigation. "honua-studio-host-navigation" is this test host's
// OWN event (dispatched by a blocking inline script in Components/App.razor's
// <head>, ahead of _framework/blazor.web.js) covering interactive-circuit
// navigation too: this module, being a deferred `type="module"` script,
// necessarily runs AFTER blazor.web.js — wrapping history.pushState from
// here was tried first and silently never fired, because blazor.web.js had
// already captured its own reference to the ORIGINAL history.pushState
// before this module ever ran. The inline script installs the same wrap,
// early enough to actually observe it.
document.addEventListener("enhancedload", resync);
document.addEventListener("honua-studio-host-navigation", resync);

// Neither of the above is sufficient BY ITSELF: both fire at the moment
// navigation STARTS (the URL update), but empirically Blazor's actual DOM
// rewrite for interactive-circuit navigation lands asynchronously — one or
// more ticks LATER. resync()ing immediately on the nav event recreates the
// element just in time for Blazor's delayed rewrite to wipe it right back
// out. A MutationObserver watching for the element's actual disappearance,
// rather than guessing at a delay, is what closes that race: it reacts to
// the wipe itself, whenever it really happens, on every pathway uniformly.
// This is the mechanism that actually keeps honua-studio-app is mounted —
// the event listeners above are a same-tick fast path for the common case,
// this is what makes it correct.
const watchdog = new MutationObserver(() => {
  if (!document.getElementById(CONTAINER_ID)?.querySelector("honua-studio-app")) resync();
});
watchdog.observe(document.body, { childList: true, subtree: true });
