import "./theme/tokens.css";
import "./theme/theme-standalone.css";
import "./theme/theme-console.css";
import "./styles/app.css";

import { mountApp } from "./app.js";
import { createAuthSession } from "./auth/index.js";
import { ThemeLoader } from "./theme/theme-loader.js";

const themeLoader = new ThemeLoader(document.documentElement, window.localStorage);
const initialThemeState = themeLoader.boot();

const root = document.getElementById("app");
if (!root) {
  throw new Error("Missing #app mount element in index.html.");
}

/**
 * Resolves the session before the shell renders (honua-studio#4 REQ-001).
 * `createAuthSession()` picks standalone OIDC or embed host-adapter mode
 * (REQ-003) — in standalone mode, a redirect back from the IdP is completed
 * here, and the `code`/`state` query params are scrubbed from the address
 * bar so a page refresh never re-submits them.
 */
async function bootstrapAuth() {
  const auth = createAuthSession();
  if (auth.mode === "standalone" && auth.isRedirectCallback()) {
    try {
      await auth.handleRedirectCallback();
    } catch {
      // The state machine already reflects the failure (state-machine.ts
      // moves to "expired" via the provider's own error handling); the
      // shell still needs to mount so the user can retry sign-in.
    }
    window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
  }
  return auth;
}

const auth = await bootstrapAuth();
mountApp({ root, themeLoader, initialThemeState, auth });
