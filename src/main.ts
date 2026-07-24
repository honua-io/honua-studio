/**
 * Standalone shell bootstrap (honua-studio#5 REQ-002).
 *
 * The app IS `<honua-studio-app>` — this file's only job is to register the
 * element kit and mount exactly one instance of it. Nothing here reaches
 * into the element's shadow DOM, imports its internals, or does anything a
 * third-party embedder (harness/bare, harness/blazor-host) couldn't also do
 * through the same public attributes/properties/events documented in
 * docs/element-contract.md — that's the whole point of REQ-002 ("no
 * privileged internal APIs").
 *
 * Session bootstrap (honua-studio#4 REQ-001/003) — resolving standalone
 * OIDC vs. an embed host adapter, and completing an OIDC redirect callback
 * — is NOT done here: it's entirely `HonuaStudioAppElement`'s own job (see
 * its `onConnect`), so every host gets it for free through the public
 * contract, not just this shell. This file never constructs an
 * `AuthSession` itself.
 *
 * The only extra thing the standalone shell does beyond a bare embed is
 * theme the page chrome AROUND the element (the `<body>` background) to
 * match — a host-level concern, done entirely by listening for the
 * element's public `honua-studio-theme-change` event, never by reading the
 * element's internals.
 */
import "./theme/tokens.css";
import "./theme/theme-standalone.css";
import "./theme/theme-console.css";
import "./styles/app.css";

import type { HonuaStudioAppElement, HonuaStudioThemeChangeDetail } from "./elements/index.js";
import { registerAllStudioElements } from "./elements/registry.js";

registerAllStudioElements();

const root = document.getElementById("app");
if (!root) {
  throw new Error("Missing #app mount element in index.html.");
}

const app = document.createElement("honua-studio-app") as HonuaStudioAppElement;
app.routingMode = "hash";

// Mirror the element's theme onto <html> for the page-level chrome (body
// background/font — see src/styles/app.css) that lives outside the element.
// This is the standalone shell's own choice, made entirely through the
// element's public "honua-studio-theme-change" event; it is not part of the
// element contract itself (a Blazor/console/bare-harness host is free to
// ignore document.documentElement completely, as harness/bare does).
app.addEventListener("honua-studio-theme-change", (event) => {
  const detail = (event as CustomEvent<HonuaStudioThemeChangeDetail>).detail;
  document.documentElement.dataset.themeSet = detail.themeSet;
  if (detail.mode === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = detail.mode;
});

root.replaceChildren(app);
