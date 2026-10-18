import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineConfig } from "vite";

// Review artifact only: a clean install of published 0.2.2 must never silently
// produce a broad native-tool bundle with its old unconditional draft injection.
// Replace this pin and provenance explicitly when adopting the immutable release.
const reviewedSessionSha256 = "6a648853c7343515b19c2ce652882f97e5a38dc4fb38da9412164cce49efc470";
const installedSessionSha256 = createHash("sha256")
  .update(readFileSync(resolve("node_modules/@honua/sdk-js/dist/src/studio-agent/session.js")))
  .digest("hex");
if (installedSessionSha256 !== reviewedSessionSha256) {
  throw new Error(
    "Console assets require the reviewed schema-aware SDK artifact. Install the documented review tarball or explicitly qualify and pin its published replacement.",
  );
}

export default defineConfig({
  publicDir: false,
  plugins: [
    {
      name: "console-license-notices",
      closeBundle() {
        const directory = resolve("public/maputnik");
        if (!existsSync(join(directory, "PROVENANCE.json")))
          throw new Error("Build the pinned Maputnik assets before Console assets.");
        const provenance = JSON.parse(readFileSync(join(directory, "PROVENANCE.json"), "utf8"));
        if (provenance.revision !== "66377f5dcf14275e205869f0c6549b2e86d7d879")
          throw new Error("Unexpected Maputnik source revision.");
        const integrationFiles = [
          "scripts/maputnik/host-store.ts",
          "scripts/maputnik/host-entry.jsx",
          "scripts/maputnik/host-layout.css",
          "scripts/maputnik/dependency-overlay.json",
          "scripts/vendor-maputnik.mjs",
        ];
        if (JSON.stringify(Object.keys(provenance.integration).sort()) !== JSON.stringify([...integrationFiles].sort()))
          throw new Error("Maputnik integration provenance is incomplete.");
        for (const path of integrationFiles)
          if (
            provenance.integration[path] !==
            createHash("sha256")
              .update(readFileSync(resolve(path)))
              .digest("hex")
          )
            throw new Error("Rebuild Maputnik assets after integration source changes.");
        const names = readdirSync(directory).sort();
        const expected = [...Object.keys(provenance.files), "PROVENANCE.json"].sort();
        if (JSON.stringify(names) !== JSON.stringify(expected))
          throw new Error("Maputnik asset payload differs from its receipt.");
        for (const name of names) {
          const path = join(directory, name);
          if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
            throw new Error("Maputnik assets must be regular files.");
          if (name === "PROVENANCE.json") continue;
          const bytes = readFileSync(path);
          const entry = provenance.files[name];
          if (entry.bytes !== bytes.length || entry.sha256 !== createHash("sha256").update(bytes).digest("hex"))
            throw new Error("Maputnik asset hash differs from its receipt.");
        }
        cpSync(directory, resolve("dist-console/maputnik"), { recursive: true });
      },
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "SDK-PROVENANCE.json",
          source: `${JSON.stringify(
            {
              releaseQualified: false,
              kind: "review-artifact",
              version: "0.2.3",
              sourceCommit: "da4003fe2",
              packageSourceCommit: "4582b47db",
              tarballSha256: "306596b48f96291df65b54da8d7db24cf5d3c8edd6942e8424b53728dde6e8fa",
              sessionSha256: installedSessionSha256,
            },
            null,
            2,
          )}\n`,
        });
        const packages = new Map<string, string>();
        for (const id of this.getModuleIds()) {
          if (!id.includes("node_modules/")) continue;
          let directory = dirname(id.split("?")[0]);
          while (directory !== dirname(directory)) {
            const manifestPath = join(directory, "package.json");
            if (existsSync(manifestPath)) {
              const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
              if (manifest.name) {
                const texts = readdirSync(directory)
                  .filter((name) => /^(licen[cs]e|notice|copying)([.-]|$)/i.test(name))
                  .sort()
                  .map((name) => `${name}\n${readFileSync(join(directory, name), "utf8")}`);
                packages.set(
                  `${manifest.name}@${manifest.version}`,
                  `License: ${JSON.stringify(manifest.license ?? "See package notices")}\n${texts.join("\n\n")}`,
                );
                break;
              }
            }
            directory = dirname(directory);
          }
        }
        this.emitFile({ type: "asset", fileName: "LICENSE", source: readFileSync(resolve("LICENSE"), "utf8") });
        this.emitFile({
          type: "asset",
          fileName: "THIRD-PARTY-NOTICES.txt",
          source: [...packages]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, text]) => `${name}\n${text}`)
            .join("\n\n========================================\n\n"),
        });
      },
    },
  ],
  worker: { format: "es" },
  build: {
    outDir: "dist-console",
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: { entry: "src/console-entry.ts", formats: ["es"], fileName: () => "console.js" },
    rollupOptions: {
      output: {
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith(".css")) ? "style.css" : "[name][extname]",
      },
    },
  },
});
