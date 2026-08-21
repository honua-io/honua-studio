#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const REQUIRED_SDK_GIT_HEAD = "5d5483f155fe4e7774a9c29dc2686031d6971dac";

export function verifySdkPublication({ dependencyVersion, lockEntry, metadata }) {
  if (typeof dependencyVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(dependencyVersion)) {
    throw new Error("@honua/sdk-js must be pinned to one exact immutable SemVer");
  }
  const publicTarball = `https://registry.npmjs.org/@honua/sdk-js/-/sdk-js-${dependencyVersion}.tgz`;
  if (
    lockEntry?.version !== dependencyVersion ||
    typeof lockEntry?.integrity !== "string" ||
    !lockEntry.integrity.startsWith("sha512-") ||
    lockEntry.resolved !== publicTarball
  ) {
    throw new Error("package-lock does not bind the exact @honua/sdk-js dependency and integrity");
  }
  if (
    metadata?.version !== dependencyVersion ||
    metadata?.gitHead !== REQUIRED_SDK_GIT_HEAD ||
    metadata?.["dist.integrity"] !== lockEntry.integrity ||
    metadata?.["dist.tarball"] !== publicTarball
  ) {
    throw new Error(
      `public @honua/sdk-js@${dependencyVersion} is not the immutable ${REQUIRED_SDK_GIT_HEAD} package bound by package-lock`,
    );
  }
}

export async function main() {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const packageLock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const dependencyVersion = packageJson.dependencies?.["@honua/sdk-js"];
  const lockEntry = packageLock.packages?.["node_modules/@honua/sdk-js"];
  const npmArguments = [
    "view",
    `@honua/sdk-js@${dependencyVersion}`,
    "version",
    "gitHead",
    "dist.integrity",
    "dist.tarball",
    "--json",
  ];
  const npmExecutable = process.env.npm_execpath ? process.execPath : "npm";
  const executableArguments = process.env.npm_execpath ? [process.env.npm_execpath, ...npmArguments] : npmArguments;
  const metadata = JSON.parse(execFileSync(npmExecutable, executableArguments, { encoding: "utf8" }));
  verifySdkPublication({ dependencyVersion, lockEntry, metadata });
  process.stdout.write(`verified @honua/sdk-js@${dependencyVersion} from ${REQUIRED_SDK_GIT_HEAD}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `SDK publication verification refused: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
