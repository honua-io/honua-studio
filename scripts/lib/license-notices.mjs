import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NOTICE_FILE = /^(licen[cs]e|notice|copying)([.-]|$)/i;
// Upstream texts for bundled packages whose npm archive ships none.
const VENDORED = fileURLToPath(new URL("../licenses/", import.meta.url));

/**
 * Third-party notices for every npm package a bundle contains: name@version,
 * the declared licence and the package's own licence/notice files. Bundled
 * BSD/MIT code has to carry its notice wherever the build is redistributed, so
 * a package without any licence text fails the build until one is vendored
 * under scripts/licenses/<name with "/" as "__">.txt.
 */
export function collectLicenseNotices(moduleIds, { vendored = VENDORED } = {}) {
  const packages = new Map();
  for (const id of moduleIds) {
    if (!id.includes("node_modules/")) continue;
    let directory = dirname(id.split("?")[0]);
    while (directory !== dirname(directory)) {
      const manifestPath = join(directory, "package.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (manifest.name) {
          const key = `${manifest.name}@${manifest.version}`;
          if (packages.has(key)) break;
          const texts = readdirSync(directory)
            .filter((name) => NOTICE_FILE.test(name))
            .sort()
            .map((name) => `${name}\n${readFileSync(join(directory, name), "utf8")}`);
          if (texts.length === 0) {
            const fallback = `${manifest.name.replace("/", "__")}.txt`;
            if (!existsSync(join(vendored, fallback)))
              throw new Error(`${key} ships no licence text; vendor it as scripts/licenses/${fallback}.`);
            texts.push(`vendored ${fallback}\n${readFileSync(join(vendored, fallback), "utf8")}`);
          }
          packages.set(
            key,
            `License: ${JSON.stringify(manifest.license ?? "See package notices")}\n${texts.join("\n\n")}`,
          );
          break;
        }
      }
      directory = dirname(directory);
    }
  }
  return [...packages]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, text]) => `${name}\n${text}`)
    .join("\n\n========================================\n\n");
}

/**
 * Emits LICENSE and THIRD-PARTY-NOTICES.txt next to the bundle. Covers the
 * main module graph; worker chunks today import only their own package.
 */
export function licenseNotices(root = process.cwd()) {
  return {
    name: "license-notices",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "LICENSE", source: readFileSync(resolve(root, "LICENSE"), "utf8") });
      this.emitFile({
        type: "asset",
        fileName: "THIRD-PARTY-NOTICES.txt",
        source: collectLicenseNotices(this.getModuleIds()),
      });
    },
  };
}
