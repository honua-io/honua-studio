import { afterEach, describe, expect, it } from "vitest";
import { mintFixtureAccessToken, startMockServer } from "../../mock-server.mjs";
import { runServerCorpus } from "../../src/evals/server-corpus.js";

let server: Awaited<ReturnType<typeof startMockServer>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("scripted server corpus evidence", () => {
  it("seeds and reads actual drafts, synchronizes undo, and proves cleanup", async () => {
    server = await startMockServer();
    const token = mintFixtureAccessToken();
    const fetchImpl: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    };
    const receipt = await runServerCorpus({
      baseUrl: server.url,
      apiKey: "fixture-key",
      runId: "regression",
      fetchImpl,
    });
    expect(receipt.mode).toBe("scripted-real-mcp");
    expect(receipt.modelQualityEvaluated).toBe(false);
    expect(receipt.cases).toHaveLength(8);
    expect(
      receipt.cases.every((entry) => entry.cleanup.passed),
      JSON.stringify(receipt),
    ).toBe(true);
    const undo = receipt.cases.find((entry) => entry.taskId === "undo-restores-previous-state");
    expect(undo?.passed, JSON.stringify(undo)).toBe(true);
    const publish = receipt.cases.find((entry) => entry.taskId === "publish-stays-behind-human-gate");
    expect(publish?.passed, JSON.stringify(publish)).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain(token);
    expect(JSON.stringify(receipt)).not.toContain("fixture-key");
  });

  it("does not turn connection failures or unconfirmed cleanup into passing scenarios", async () => {
    const receipt = await runServerCorpus({
      baseUrl: "http://127.0.0.1:1",
      apiKey: "secret",
      runId: "offline",
      fetchImpl: async () => {
        throw new Error("unavailable");
      },
    });
    expect(receipt.passed).toBe(false);
    expect(receipt.cases.every((entry) => !entry.passed && !entry.cleanup.passed)).toBe(true);
  });
});
