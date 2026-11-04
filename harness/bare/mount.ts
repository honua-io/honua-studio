/**
 * Mounts `<honua-studio-app>` through the element's own `.session` property
 * (docs/embed-session.md) and only the public element contract, the same
 * contract the standalone shell and the Blazor test host use. Proves
 * third-party hosting without the standalone shell's chrome.
 */
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioAppElement } from "../../src/elements/studio-app-element.js";
import { createFixtureSession } from "./fixture-session.js";

declare global {
  interface Window {
    /** A real, signed mock-issuer access token (`mintFixtureAccessToken()`) set by test/playwright/bare-harness.spec.mjs via `page.addInitScript` — the mock honua-server's catalog/packages endpoints validate it, unlike this harness's own fixture adapter. */
    __honuaStudioFixtureToken?: string;
  }
}

registerAllStudioElements();

const root = document.getElementById("bare-host");
if (!root) throw new Error("Missing #bare-host mount element in harness/bare/index.html.");

const app = document.createElement("honua-studio-app") as HonuaStudioAppElement;
app.session = createFixtureSession(window.__honuaStudioFixtureToken);
// Self-owned routing here — the bare harness has no router of its own to
// hand ownership to (that scenario is what harness/blazor-host proves).
app.routingMode = "hash";

// Expose the mounted element + a hook to swap the session for the
// Playwright spec (test/playwright/bare-harness.spec.mjs) — a debugging
// convenience only a test host needs, never part of the element contract.
Object.assign(window, { __honuaStudioBareApp: app });

root.appendChild(app);
