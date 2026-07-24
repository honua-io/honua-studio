/**
 * Bare embed harness bootstrap (honua-studio#5 REQ-003). Mounts
 * `<honua-studio-app>` with a fixture session, using nothing beyond the
 * public element contract (src/elements/index.js) — the same contract the
 * standalone shell (src/main.ts) and the Blazor test host
 * (harness/blazor-host) use. Proves third-party hosting without console and
 * without the standalone shell's own chrome/theming choices.
 */
import { registerAllStudioElements } from "../../src/elements/registry.js";
import type { HonuaStudioAppElement } from "../../src/elements/studio-app-element.js";
import { createFixtureSession } from "./fixture-session.js";

registerAllStudioElements();

const root = document.getElementById("bare-host");
if (!root) throw new Error("Missing #bare-host mount element in harness/bare/index.html.");

const app = document.createElement("honua-studio-app") as HonuaStudioAppElement;
app.session = createFixtureSession();
// Self-owned routing here — the bare harness has no router of its own to
// hand ownership to (that scenario is what harness/blazor-host proves).
app.routingMode = "hash";

// Expose the mounted element + a hook to swap the session for the
// Playwright spec (test/playwright/bare-harness.spec.mjs) — a debugging
// convenience only a test host needs, never part of the element contract.
Object.assign(window, { __honuaStudioBareApp: app });

root.appendChild(app);
