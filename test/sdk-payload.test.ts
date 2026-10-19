import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type SdkPayloadReceipt, verifySdkPayload } from "../scripts/lib/verify-sdk-payload.mjs";
const roots: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture(): { directory: string; receipt: SdkPayloadReceipt } {
  const directory = mkdtempSync(join(tmpdir(), "honua-sdk-receipt-"));
  roots.push(directory);
  mkdirSync(join(directory, "dist"));
  writeFileSync(join(directory, "package.json"), "{}");
  writeFileSync(join(directory, "dist", "runtime.js"), "export const value=1;");
  return {
    directory,
    receipt: {
      sourceCommit: "a".repeat(40),
      artifactSha256: "b".repeat(64),
      files: {
        "package.json": hash("{}"),
        "dist/runtime.js": hash("export const value=1;"),
      },
    },
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("SDK review payload integrity", () => {
  it("checks all packaged files while excluding installation-only nested dependencies", () => {
    const { directory, receipt } = fixture();
    mkdirSync(join(directory, "node_modules", "dependency"), { recursive: true });
    writeFileSync(join(directory, "node_modules", "dependency", "index.js"), "dependency bytes");
    expect(verifySdkPayload(directory, receipt)).toEqual({
      sourceCommit: receipt.sourceCommit,
      artifactSha256: receipt.artifactSha256,
      files: 2,
    });
  });
  it.each(["changed", "extra", "missing", "symlink"])("rejects a %s package member", (kind) => {
    const { directory, receipt } = fixture();
    if (kind === "changed") writeFileSync(join(directory, "dist", "runtime.js"), "export const value=2;");
    if (kind === "extra") writeFileSync(join(directory, "dist", "foreign.js"), "foreign");
    if (kind === "missing") rmSync(join(directory, "dist", "runtime.js"));
    if (kind === "symlink") {
      rmSync(join(directory, "dist", "runtime.js"));
      symlinkSync(join(directory, "package.json"), join(directory, "dist", "runtime.js"));
    }
    expect(() => verifySdkPayload(directory, receipt)).toThrow(/SDK payload/);
  });
  it("also checks bundled dependency files when explicitly included in the package receipt", () => {
    const { directory, receipt } = fixture();
    mkdirSync(join(directory, "node_modules", "bundled"), { recursive: true });
    writeFileSync(join(directory, "node_modules", "bundled", "index.js"), "actual");
    expect(() =>
      verifySdkPayload(directory, {
        ...receipt,
        files: { ...receipt.files, "node_modules/bundled/index.js": hash("expected") },
      }),
    ).toThrow(/differs/);
  });
});
