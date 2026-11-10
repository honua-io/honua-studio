import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // happy-dom 21 leaves iframe and CSS loads off unless the window opts in.
    // These tests postMessage into a same-origin Maputnik frame and need that window.
    environmentOptions: {
      happyDOM: {
        settings: {
          enableCSSFileLoading: true,
          enableIframePageLoading: true,
        },
      },
    },
    include: ["test/**/*.test.ts"],
    exclude: ["test/playwright/**"],
  },
});
