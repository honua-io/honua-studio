import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,mjs}"],
    exclude: ["test/playwright/**"],
  },
});
