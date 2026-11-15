import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Plugin, UserConfig } from "vite";
import { describe, expect, it } from "vitest";

import { collectLicenseNotices } from "../../scripts/lib/license-notices.mjs";
import standaloneConfig from "../../vite.config";

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
    const tiles = fixturePackage(root, "@scope/tiles", { name: "@scope/tiles", version: "4.0.0" }, {});
    const notices = collectLicenseNotices([
      map,
      `${map}?worker`,
      tiles,
      join(root, "src", "main.ts"),
      "\0virtual:module",
    ]);

    expect(notices.match(/^map-lib@6\.1\.0$/gmu)).toHaveLength(1);
    expect(notices).toContain('License: "BSD-3-Clause"');
    expect(notices).toContain("Copyright (c) Map Lib contributors");
    expect(notices).toContain("Map Lib notice");
    expect(notices).toContain('@scope/tiles@4.0.0\nLicense: "See package notices"');
    expect(notices.indexOf("@scope/tiles")).toBeLessThan(notices.indexOf("map-lib"));
    expect(notices).not.toContain("main.ts");
  });

  it("is part of the standalone build that the published image serves", () => {
    const config = standaloneConfig as (env: { command: "build"; mode: string }) => UserConfig;
    const plugins = (config({ command: "build", mode: "production" }).plugins ?? []) as Plugin[];
    expect(plugins.map((plugin) => plugin.name)).toContain("license-notices");
  });
});
