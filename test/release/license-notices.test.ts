import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Plugin, UserConfig } from "vite";
import { describe, expect, it } from "vitest";

import { collectLicenseNotices } from "../../scripts/lib/license-notices.mjs";
import standaloneConfig from "../../vite.config";

const require = createRequire(import.meta.url);

function fixturePackage(root: string, path: string, manifest: object, files: Record<string, string>): string {
  const directory = join(root, "node_modules", path);
  mkdirSync(join(directory, "dist"), { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
  return join(directory, "dist", "index.js");
}

describe("third-party licence notices", () => {
  it("lists each bundled package once with its licence and notice texts", () => {
    const root = mkdtempSync(join(tmpdir(), "studio-notices-"));
    const map = fixturePackage(
      root,
      "map-lib",
      { name: "map-lib", version: "6.1.0", license: "BSD-3-Clause" },
      { "LICENSE.txt": "Copyright (c) Map Lib contributors", NOTICE: "Map Lib notice" },
    );
    const tiles = fixturePackage(
      root,
      "@scope/tiles",
      { name: "@scope/tiles", version: "4.0.0", license: "BSD-3-Clause" },
      {},
    );
    const vendored = join(root, "vendored");
    mkdirSync(vendored);
    writeFileSync(join(vendored, "@scope__tiles.txt"), "Copyright 2021 Tiles LLC");
    const notices = collectLicenseNotices(
      [map, `${map}?worker`, tiles, `${tiles}?url`, join(root, "src", "main.ts"), "\0virtual:module"],
      { vendored },
    );

    expect(notices.match(/^map-lib@6\.1\.0$/gmu)).toHaveLength(1);
    expect(notices).toContain('License: "BSD-3-Clause"');
    expect(notices).toContain("Copyright (c) Map Lib contributors");
    expect(notices).toContain("Map Lib notice");
    expect(notices).toContain(
      '@scope/tiles@4.0.0\nLicense: "BSD-3-Clause"\nvendored @scope__tiles.txt\nCopyright 2021 Tiles LLC',
    );
    expect(notices.indexOf("@scope/tiles")).toBeLessThan(notices.indexOf("map-lib"));
    expect(notices).not.toContain("main.ts");
  });

  it("fails the build when a bundled package has no licence text", () => {
    const root = mkdtempSync(join(tmpdir(), "studio-notices-"));
    const bare = fixturePackage(root, "bare-lib", { name: "bare-lib", version: "1.0.0", license: "MIT" }, {});
    expect(() => collectLicenseNotices([bare], { vendored: join(root, "none") })).toThrow(/bare-lib@1\.0\.0/u);
  });

  it("vendors the texts that pmtiles and @turf/jsts do not ship", () => {
    const notices = collectLicenseNotices([
      require.resolve("pmtiles"),
      join(dirname(require.resolve("@turf/jsts/package.json")), "dist", "jsts.min.js"),
    ]);
    expect(notices).toContain("Copyright 2021 Protomaps LLC");
    expect(notices).toContain("Eclipse Distribution License - v 1.0");
  });

  it("is part of the standalone build that the published image serves", () => {
    const config = standaloneConfig as (env: { command: "build"; mode: string }) => UserConfig;
    const plugins = (config({ command: "build", mode: "production" }).plugins ?? []) as Plugin[];
    expect(plugins.map((plugin) => plugin.name)).toContain("license-notices");
  });
});
