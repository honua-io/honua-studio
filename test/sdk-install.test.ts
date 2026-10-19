import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("reviewed SDK installer", () => {
  it("rejects archive substitution, unsafe members, and unrelated dependency drift", () => {
    const result = spawnSync(
      "python3",
      ["-m", "unittest", "discover", "-s", "test/scripts", "-p", "test_install_reviewed_sdk.py", "-v"],
      { encoding: "utf8", timeout: 30000, maxBuffer: 1048576 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Ran 4 tests");
  });
});
