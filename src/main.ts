import "./theme/tokens.css";
import "./theme/theme-standalone.css";
import "./theme/theme-console.css";
import "./styles/app.css";

import { mountApp } from "./app.js";
import { ThemeLoader } from "./theme/theme-loader.js";

const themeLoader = new ThemeLoader(document.documentElement, window.localStorage);
const initialThemeState = themeLoader.boot();

const root = document.getElementById("app");
if (!root) {
  throw new Error("Missing #app mount element in index.html.");
}

mountApp({ root, themeLoader, initialThemeState });
