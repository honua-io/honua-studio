import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * Builds the Blazor Web App test host's client bundle (honua-studio#5) —
 * separate from vite.config.ts's app build because this one needs FIXED
 * output filenames (Razor references them directly, no manifest lookup) and
 * a different `outDir`: straight into the .NET project's own `wwwroot`, so
 * `dotnet build`/`dotnet run` picks the assets up as ordinary static content
 * with no copy step of its own. Run via `npm run build:blazor-assets`
 * (harness/blazor-host/README.md documents the full build sequence).
 */
const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    outDir: resolve(projectRoot, "harness/blazor-host/StudioHost/wwwroot/studio"),
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: resolve(projectRoot, "harness/blazor-host-src/mount.ts"),
      formats: ["es"],
      fileName: () => "mount.js",
    },
    rollupOptions: {
      output: {
        assetFileNames: "[name][extname]",
      },
    },
  },
});
