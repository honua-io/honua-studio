import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const NOTICE_FILE = /^(licen[cs]e|notice|copying)([.-]|$)/i;

/**
 * Third-party notices for every npm package a bundle contains: name@version,
 * the declared licence and the package's own licence/notice files. Bundled
 * BSD/MIT code has to carry its notice wherever the build is redistributed.
 */
export function collectLicenseNotices(moduleIds) {
  const packages = new Map();
  for (const id of moduleIds) {
    if (!id.includes("node_modules/")) continue;
    let directory = dirname(id.split("?")[0]);
    while (directory !== dirname(directory)) {
      const manifestPath = join(directory, "package.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (manifest.name) {
          const texts = readdirSync(directory)
            .filter((name) => NOTICE_FILE.test(name))
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
  return [...packages]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, text]) => `${name}\n${text}`)
    .join("\n\n========================================\n\n");
}

/** Emits LICENSE and THIRD-PARTY-NOTICES.txt next to the bundle. */
export function licenseNotices() {
  return {
    name: "license-notices",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "LICENSE", source: readFileSync(resolve("LICENSE"), "utf8") });
      this.emitFile({
        type: "asset",
        fileName: "THIRD-PARTY-NOTICES.txt",
        source: collectLicenseNotices(this.getModuleIds()),
      });
    },
  };
}
