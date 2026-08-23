import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireClaim,
  ensureExactOutput,
  rejectCredentialEnvironment,
  writeExclusiveAtomic,
} from "../../scripts/real-model-ai-arc.mjs";

describe("real-model AI arc output transaction", () => {
  it("creates outputs exclusively and verifies byte-identical retries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "honua-ai-arc-transaction-"));
    const path = join(directory, "evidence.json");
    try {
      expect(await ensureExactOutput(path, Buffer.from("exact"))).toBe("created");
      expect(await ensureExactOutput(path, Buffer.from("exact"))).toBe("verified");
      await expect(ensureExactOutput(path, Buffer.from("different"))).rejects.toThrow("does not match this handoff");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not overwrite an occupied immutable handoff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "honua-ai-arc-exclusive-"));
    const path = join(directory, "handoff.json");
    try {
      await writeExclusiveAtomic(path, Buffer.from("first"));
      await expect(writeExclusiveAtomic(path, Buffer.from("second"))).rejects.toThrow(
        "refusing to replace occupied output",
      );
      expect(await readFile(path, "utf8")).toBe("first");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes active producers and permits an atomic stale-claim takeover", async () => {
    const directory = await mkdtemp(join(tmpdir(), "honua-ai-arc-claim-"));
    const path = join(directory, "receipt.claim");
    const digest = "a".repeat(64);
    try {
      const release = await acquireClaim(path, digest, Date.parse("2026-08-21T00:00:00Z"));
      await expect(acquireClaim(path, digest, Date.parse("2026-08-21T00:01:00Z"))).rejects.toThrow(
        "another active or different producer",
      );
      await release();

      await writeFile(
        path,
        `${JSON.stringify({
          schemaVersion: "honua.studio.real-model-ai-arc-claim/v1",
          claimId: "abandoned-producer",
          handoffDigest: digest,
          createdAt: "2026-08-21T00:00:00.000Z",
        })}\n`,
      );
      const releaseTakeover = await acquireClaim(path, digest, Date.parse("2026-08-21T00:16:00Z"));
      await releaseTakeover();
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires a purpose-specific prepare credential and a credential-free resume", () => {
    expect(rejectCredentialEnvironment({ HONUA_AI_ARC_PREPARE_CREDENTIAL: "scoped" }, "prepare")).toBe("scoped");
    expect(() => rejectCredentialEnvironment({ HONUA_ADMIN_KEY: "broad" }, "prepare")).toThrow(
      "broad credential variables are forbidden",
    );
    expect(rejectCredentialEnvironment({}, "resume")).toBeUndefined();
    expect(() => rejectCredentialEnvironment({ HONUA_AI_ARC_PREPARE_CREDENTIAL: "left-set" }, "resume")).toThrow(
      "resume is credential-free",
    );
    expect(() => rejectCredentialEnvironment({ HONUA_AI_ARC_CONSOLE_TOKEN: "console-only" }, "resume")).toThrow(
      "resume is credential-free",
    );
    expect(() => rejectCredentialEnvironment({ AWS_SESSION_TOKEN: "ambient" }, "resume")).toThrow(
      "resume is credential-free",
    );
  });
});
