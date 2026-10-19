import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Verify every installed SDK payload byte against a separately pinned pack receipt. */
export function verifySdkPayload(directory, receipt) {
  if (
    !receipt ||
    !/^[a-f0-9]{40}$/.test(receipt.sourceCommit ?? "") ||
    !/^[a-f0-9]{64}$/.test(receipt.artifactSha256 ?? "") ||
    !receipt.files ||
    typeof receipt.files !== "object" ||
    Array.isArray(receipt.files)
  )
    throw new Error("SDK payload receipt is incomplete.");
  const expected = Object.keys(receipt.files).sort();
  if (!expected.length || expected.length > 20000) throw new Error("SDK payload receipt has an invalid file count.");
  for (const path of expected) {
    if (
      !path ||
      path.length > 1024 ||
      path.includes("\\") ||
      [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      !/^[a-f0-9]{64}$/.test(receipt.files[path])
    )
      throw new Error("SDK payload receipt has an invalid member.");
  }
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink())
    throw new Error("SDK package root must be a real directory.");
  const actual = [];
  let total = 0;
  function walk(relative) {
    for (const name of readdirSync(join(directory, relative)).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      // npm may install dependencies inside the SDK. Packaged bundled dependencies,
      // if present in the receipt, remain part of the exact checked payload.
      if (name === "node_modules" && !expected.some((entry) => entry.startsWith(`${path}/`))) continue;
      const absolute = join(directory, path);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error("SDK payload cannot contain symbolic links.");
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
        throw new Error("SDK payload member must be a bounded regular file.");
      const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const hash = createHash("sha256");
      try {
        if (!fstatSync(fd).isFile()) throw new Error("SDK payload member must remain a regular file.");
        const buffer = Buffer.alloc(65536);
        let size = 0;
        for (;;) {
          const count = readSync(fd, buffer, 0, buffer.length, null);
          if (!count) break;
          size += count;
          total += count;
          if (size > 64 * 1024 * 1024 || total > 256 * 1024 * 1024)
            throw new Error("SDK payload exceeds its byte budget.");
          hash.update(buffer.subarray(0, count));
        }
      } finally {
        closeSync(fd);
      }
      actual.push(path);
      if (hash.digest("hex") !== receipt.files[path])
        throw new Error(`SDK payload differs from its pinned receipt: ${path}`);
    }
  }
  walk("");
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected))
    throw new Error("SDK payload file set differs from its pinned receipt.");
  return { sourceCommit: receipt.sourceCommit, artifactSha256: receipt.artifactSha256, files: expected.length };
}
